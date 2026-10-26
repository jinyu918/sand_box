# Cove 威胁模型

| 项目 | 内容 |
| --- | --- |
| 版本 | v0.1 |
| 日期 | 2026-10-26 |
| 方法 | 资产 → 对手 → 入口 → 威胁 → 缓解 → 残余风险 |
| 关联 | [需求](requirements.md)、[设计](design.md) |

## 1. 安全目标

1. **凭据机密性**：真实 API Key、PAT、密码不进入沙箱可读的任何介质。
2. **宿主完整性**：Agent 不能修改项目目录以外的宿主文件，不能控制 Docker/宿主进程。
3. **出网可控**：Agent 只能访问策略允许的主机/方法/路径，所有尝试可审计。
4. **默认失败关闭**：任何安全组件缺失或异常时，不降级为直连/明文/无认证。
5. **可追责**：用户能知道某次会话访问了什么、被注入了哪个凭据、什么被拒绝。

## 2. 资产

| 资产 | 位置 | 影响 |
| --- | --- | --- |
| Provider API Key | DPAPI vault、CLI 内存、broker 内存 | 被盗刷、费用、数据泄露 |
| MCP Token/PAT | 同上 | 仓库/第三方数据被读写 |
| CA 私钥 | DPAPI vault、CLI/broker 内存 | 可伪造任意站点、解密沙箱流量 |
| 项目源码 | 宿主项目目录（挂载） | 知识产权、客户数据 |
| 宿主其他文件 | 宿主 home、SSH、浏览器、其他项目 | 账号接管、横向移动 |
| Docker daemon | 宿主 socket | 等同宿主 root |
| 审计日志 | `~/.cove/sessions/*/audit.jsonl` | 行为隐私；泄露访问目标 |
| 会话元数据 | `session.json` | 项目路径、Agent 类型 |

## 3. 对手

| 对手 | 能力 | 是否在范围 |
| --- | --- | --- |
| A1 被提示注入的 Agent | 可在沙箱内执行任意命令、读写项目、启动子进程、访问网络（受 broker 限制） | 是，核心对手 |
| A2 恶意/被投毒的 MCP server | 同 A1，且可读取 Agent 传给它的占位符 | 是 |
| A3 恶意项目代码/构建脚本 | 在沙箱内执行；可尝试读取环境、扫描网络 | 是 |
| A4 本机其他低权限用户 | 可读共享目录、尝试连接 loopback 端口 | 部分（UI 仅 loopback，文件 ACL） |
| A5 宿主机当前用户 | 可读 vault 密文、Docker inspect、调试进程 | 否，信任根 |
| A6 宿主机管理员/内核级恶意软件 | 可读内存、替换二进制 | 否 |
| A7 上游服务/网络攻击者 | 可返回恶意内容、尝试利用 broker 解析 | 是（broker 输入不可信） |
| A8 供应链攻击者 | npm 包、镜像基础层、Agent 更新 | 部分（固定版本、锁文件、最小镜像） |

## 4. 信任边界

```text
[宿主机用户/CLI/UI/Vault/CA]  ── 信任 ──  [broker 容器]  ── 信任上游 TLS ──  [Internet]
          │
          └── 不信任 ── [沙箱容器: Agent/MCP/项目代码] ── 仅 internal 网络 ──> broker
```

- Docker daemon 与宿主机内核在信任边界内；Cove 不防御其漏洞。
- 沙箱内的 root（UID 0）也不被信任；Cove 默认以 UID 1000 运行，但即使提权到容器 root，
  仍不应能读宿主文件/密钥/网络。
- broker 是可信代码，但它解析不可信网络输入；其内存中的密钥是最高价值目标。

## 5. 威胁与缓解

### T1 沙箱读取真实凭据（环境变量/配置文件/进程）

- **向量**：Agent `env`、`~/.claude.json`、MCP 配置、`/proc/*/environ`、shell history。
- **缓解**：沙箱只注入占位符；真实值只经 broker env 传递并立即从 `process.env` 删除；配置生成器
  不接受真实值；测试扫描沙箱文件/env。
- **残余**：占位符可被读取，但只能在授权主机兑换；宿主用户可 `docker inspect` broker env（信任根）。

### T2 占位符被发送到未授权主机

- **向量**：Agent 把 `Authorization: Bearer <placeholder>` 发往攻击者域名，期望 broker 替换。
- **缓解**：broker 先检查所有 Header 中的已知占位符；若目标主机不在该凭据 `hosts`，直接 403 并
  记录 `placeholder_leak_attempt`；DNS 只解析策略主机，攻击者域名通常不可达。
- **残余**：若用户显式把攻击者域名加入策略且该凭据 hosts 包含它，则无法区分；这是用户授权行为。

### T3 沙箱直接出网 / DNS 隧道 / IP 直连

- **向量**：`curl https://example.com`、直连 `1.1.1.1`、DNS 查询编码数据、访问宿主网关。
- **缓解**：Docker internal 网络无默认路由；broker DNS 只回答策略域名，不转发未知查询；
  broker 拒绝 IP 字面量/私网/环回；集成测试验证直连失败。
- **残余**：Docker Desktop 自身的网络实现漏洞；宿主内核路由配置错误。`doctor` 做基本探测。

### T4 Broker 被 SSRF 利用

- **向量**：`Host: 169.254.169.254`、`https://internal.service`、DNS rebinding、重定向到私网。
- **缓解**：只允许显式域名；解析后校验所有 IP 非私网/环回/链路本地；连接固定解析结果；
  不自动跟随上游重定向（3xx 原样返回，客户端若跟随会再次经 broker 校验）。
- **残余**：公网 IP 上的内部服务（若用户允许该域名）；上游 DNS 被投毒到公网恶意 IP（TLS 仍校验证书）。

### T5 上游 TLS 被降级/冒充

- **向量**：broker 关闭证书校验、使用 HTTP、客户端被诱导信任错误 CA。
- **缓解**：上游 `rejectUnauthorized: true` + SNI；CA 私钥 DPAPI；叶证书短期；不提供关闭校验的开关。
- **残余**：用户系统时间严重错误、上游证书本身被攻破。

### T6 CA 私钥泄露

- **向量**：沙箱读取 CA 私钥、日志泄露、备份泄露。
- **缓解**：私钥只存 DPAPI 密文；broker 通过 env 获取后删除；沙箱只挂载公钥/信任包；审计/错误
  不含 PEM；测试扫描。
- **残余**：宿主机当前用户可解密（信任根）；broker 内存被读取（宿主级攻击）。

### T7 Broker 被恶意输入攻破

- **向量**：超大 Header/Body、畸形 TLS/HTTP、压缩炸弹、路径穿越、Node 漏洞。
- **缓解**：Body 16 MiB 上限、Header 大小由 Node 限制、路径规范化、无 `eval`、最小依赖、
  非 root（绑定端口后降权）、只读根、cap-drop、no-new-privileges、资源限制。
- **残余**：Node/OpenSSL 0-day；broker 被攻破后可读取本会话密钥并伪造上游响应。缓解是会话隔离
  和快速升级；v0.1 不把 broker 放进更强沙箱。

### T8 恶意 MCP server 滥用被注入的凭据

- **向量**：MCP 收到占位符后，用它调用授权主机的写接口（如创建 gist、修改仓库）。
- **缓解**：preset 只声明必要主机；用户应使用最小 scope Token；审计记录方法与路径；v0.1 对
  GitHub 只允许 `api.githubcopilot.com`，不直接暴露 `api.github.com`；文档建议 fine-grained PAT。
- **残余**：Token 本身的能力边界；MCP 在沙箱内可执行任意代码，无法在 v0.1 做工具级审批。
  这是"给 Agent 能力"的固有风险，不是 Cove 能完全消除的。

### T9 项目内已有密钥被 Agent 读取

- **向量**：项目根目录 `.env`、`*.pem`、`.npmrc`、`.git-credentials`。
- **缓解**：启动前扫描常见敏感文件；默认要求用户确认或 `--allow-project-secrets`；文档建议把
  这类文件移出项目或使用占位值。
- **残余**：扫描是启发式，无法识别所有格式；用户确认后 Agent 可读。Cove 的承诺是"不把 Cove
  管理的凭据放进沙箱"，不承诺项目自身不含密钥。

### T10 宿主文件系统越界

- **向量**：项目目录中的符号链接指向宿主 home、`/workspace` 挂载被滥用、Docker 配置错误。
- **缓解**：只挂载项目目录；不挂载 home/socket；容器内非 root；Docker Desktop 的 bind mount
  解析在宿主侧，符号链接可能指向挂载外——需要文档警告并在 preflight 检查项目内指向外部的符号链接。
- **残余**：项目内符号链接可让 Agent 读写挂载目标之外的宿主文件（如果 Docker 跟随）。v0.1 计划
  在 preflight 扫描并阻止指向项目外的符号链接；无法覆盖运行期新建的链接。**这是 v0.1 的已知缺口。**

### T11 Docker socket / 宿主控制面

- **向量**：挂载 `/var/run/docker.sock`、Docker API TCP、宿主任意端口。
- **缓解**：绝不挂载 socket；不加入 host 网络；internal 网络无法访问宿主网关（集成测试）；
  broker 只监听 internal；不发布 broker 管理端口。
- **残余**：Docker Desktop 的 `host.docker.internal` 在 internal 网络的可用性随版本变化；
  测试验证当前版本不可达。

### T12 本地控制台被 CSRF/恶意网页利用

- **向量**：用户浏览器访问恶意站点，向 `127.0.0.1:7777` 发写请求；DNS rebinding。
- **缓解**：仅绑定 loopback；随机 CSRF Token；校验 Origin/Host；无 CORS；CSP 禁止第三方脚本；
  JSON Content-Type；拒绝 `Sec-Fetch-Site: cross-site`。
- **残余**：本机其他进程可读取 loopback 流量/端口（同用户信任）；浏览器扩展可读页面。

### T13 审计/日志泄露密钥

- **向量**：异常堆栈包含 Header/Body；审计记录查询串；调试日志打印 env。
- **缓解**：审计 schema 白名单字段；统一 `redact`；错误只带 code/hint；不记录 Header/Body；
  测试用 canary 密钥扫描所有输出文件。
- **残余**：上游 URL 路径可能含业务敏感 ID（不可避免，已截断）；用户共享审计文件时需自行评估。

### T14 供应链

- **向量**：npm 包被投毒、基础镜像后门、Agent 自动更新。
- **缓解**：版本固定；提交锁文件；镜像构建只从官方 registry 拉取固定 tag；不执行远程安装脚本；
  沙箱内下载的 MCP 包在 broker 只读 GET 策略下获取；文档建议审查 MCP。
- **残余**：npm 账号/包维护者被攻破；Docker Hub 基础镜像被替换；Agent 自身漏洞。

### T15 资源耗尽 / DoS

- **向量**：fork bomb、内存炸弹、超大请求、磁盘写满 home 卷。
- **缓解**：PID/内存/CPU 限制；Body 上限；tmpfs 大小限制；home 卷随会话删除；broker 限流 P1。
- **残余**：磁盘写满宿主（项目目录/审计）仍可能；v0.1 不做项目磁盘配额。

### T16 DSH Web 端口暴露

- **向量**：发布端口被局域网访问；Web UI 无认证；恶意 Agent 控制 Web 内容。
- **缓解**：只发布 `127.0.0.1`；随机端口；DSH 自带 token + browser-trust fence；容器仍无出网。
- **残余**：本机其他进程可访问该端口；DSH Web 自身漏洞；UI 可执行 Agent 命令（用户已授权）。

### T17 清理失败留下敏感资源

- **向量**：CLI 崩溃、Docker 挂起，broker 容器/卷残留。
- **缓解**：`finally` 清理；label 标记；`doctor`/`down --all` 兜底；broker 不落盘密钥。
- **残余**：残留容器仍在 internal 网络，无沙箱则无法利用；用户需手动清理。

## 6. 安全不变量（实现必须测试）

1. 沙箱文件树、env、配置中不出现任何真实 secret 值。
2. 沙箱没有除 internal 网络以外的网络接口/路由。
3. 未授权域名在 DNS 层不可解析，且 broker 拒绝 IP 直连。
4. 占位符发往未授权主机返回 403，并产生审计事件。
5. 审计/错误/UI 响应不含 secret 或占位符。
6. CA 私钥不出现在沙箱、日志、会话目录。
7. vault 解密失败、CA 缺失、broker 不健康时，沙箱不启动。
8. UI 写请求必须同源 + CSRF；服务只绑定 loopback。

## 7. 明确不在威胁模型内

- 宿主机管理员/root、内核漏洞、Docker Desktop/VM 逃逸。
- 物理访问、冷启动攻击、内存取证。
- 侧信道（CPU、功耗、时序）。
- 上游服务自身被攻破或主动作恶。
- 用户自愿把密钥粘贴到沙箱内、把项目密钥文件保留在项目中并确认。
- 供应链全链路可信（仅做固定版本和最小依赖）。
- 证书固定客户端的兼容性。

## 8. 残余风险接受

v0.1 接受以下风险，并在用户文档中明示：

- Docker 边界弱于 microVM；对高危不可信代码建议使用独立虚拟机。
- 项目符号链接可能绕过"仅项目目录"的意图（T10）。
- MCP 的令牌能力边界由上游 scope 决定，Cove 不做工具级审批。
- DSH Web 端口对本机开放（仅 loopback）。
- 无法阻止用户在项目内保存明文密钥并被 Agent 读取；preflight 只做提示/确认。

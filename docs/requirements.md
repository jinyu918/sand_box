# Cove 需求文档

| 项目 | 内容 |
| --- | --- |
| 版本 | v0.1 |
| 状态 | 已评审，作为 v0.1 实现基线 |
| 日期 | 2026-10-26 |
| 目标平台 | Windows 11 + Docker Desktop（Linux containers）；架构保留 macOS/Linux Docker 适配位 |
| 关联文档 | [设计文档](design.md)、[威胁模型](threat-model.md) |

## 1. 背景与问题

AI 编程 Agent 已经能读写代码、执行命令、调用 MCP 工具。为了让它工作，用户通常直接在本机
运行 Agent，并把 API Key 放在环境变量或 `.env` 中。这带来四个现实问题：

1. **凭据暴露面过大**：Agent 进程、子进程、MCP server、shell 都能读到真实密钥；提示注入可以把
   密钥发往任意地址。
2. **文件系统暴露面过大**：Agent 以当前用户身份运行，能读 home、SSH key、浏览器配置、其他项目。
3. **出网不受控**：Agent 可以访问任意域名，数据外传没有统一审计点。
4. **现有方案要么不安全，要么不友好**：容器方案要求用户写 Dockerfile/Compose、手工传 env；
   密钥代理方案不隔离文件和进程；企业级方案需要服务器和复杂策略。

Cove 的目标是在**单台桌面电脑**上，用一个命令获得"文件隔离 + 网络收口 + 凭据不落地"，
同时让主流 Agent 和 MCP 的接入不需要用户改代码、写 Docker 配置或把密钥放进沙箱。

## 2. 目标与非目标

### 2.1 目标

- **G1 凭据隔离**：真实 API Key、Token、密码不进入沙箱的文件系统、环境变量、进程参数或日志。
- **G2 工作区隔离**：Agent 只能访问显式挂载的项目目录，不能访问宿主 home、其他项目、Docker socket。
- **G3 出网收口**：沙箱无直接出网能力；所有 HTTPS 流量经可信 broker 容器，按策略放行并审计。
- **G4 主流 Agent 可用**：Claude Code、Codex、DSH 可在沙箱内以接近原生的体验运行。
- **G5 主流 MCP 免密钥配置**：MCP 配置由 Cove 生成，沙箱内只有占位符；真实密钥留在宿主机。
- **G6 桌面级易用**：首次配置不超过 3 个引导步骤；日常运行为一条命令；错误信息可操作；
  提供本地图形控制台完成密钥、MCP、状态和审计管理。
- **G7 默认安全**：未显式允许的域名、方法、路径默认拒绝；失败关闭；清理失败不会静默。

### 2.2 非目标（v0.1）

- 不是虚拟机级隔离，不承诺防御 Docker、Linux 内核或硬件侧信道漏洞。
- 不做恶意软件检测、DLP、内容审查或企业集中管控。
- 不支持把宿主 home 目录整体挂载进沙箱。
- 不支持订阅制 OAuth 登录（Claude Pro/Max、ChatGPT 账号登录）；v0.1 使用 API Key。
- 不支持需要原始 TCP/UDP 的 MCP（如 PostgreSQL、MySQL、Redis）；v0.1 仅支持 HTTPS 型 API。
- 不支持 Windows 原生进程沙箱；Agent 运行在 Linux 容器中。
- 不做团队共享、云端密钥托管、多用户权限系统。
- 不在沙箱内提供通用浏览器；DSH 的 Web UI 通过仅绑定 loopback 的发布端口提供（见设计 ADR-0004）。

## 3. 用户与场景

### 3.1 主要用户

- **独立开发者**：在本机用 Claude Code/Codex 改代码，持有多个 SaaS Token，担心误泄露。
- **技术负责人**：需要给团队一个"默认可接受"的本地 Agent 运行方式，但不想搭服务器。
- **安全敏感用户**：需要知道 Agent 访问了哪些域名、哪些请求被拒绝、密钥是否离开宿主。

### 3.2 核心场景

1. **首次安装**：安装 Cove，运行 `cove setup`，看到 Docker、CA、保险箱三项就绪。
2. **保存密钥**：在终端或本地控制台录入 Anthropic/OpenAI/DeepSeek/GitHub 密钥，输入不回显。
3. **运行 Agent**：进入项目目录，`cove run claude`，Agent 正常启动；模型请求成功，但沙箱内
   `env`、`~/.claude.json`、进程命令行均看不到真实密钥。
4. **接入 MCP**：`cove mcp add github`，只输入一次 GitHub Token；Claude Code、Codex、DSH 的
   MCP 配置自动生成；沙箱配置里只有占位符。
5. **观察与止损**：`cove audit` 或本地控制台看到请求域名、状态、是否注入、是否拒绝；
   发现异常域名被拒绝，项目代码未被外传。
6. **清理**：Agent 退出后容器、网络、临时配置被删除；`cove down --all` 可清理残留。

## 4. 术语

| 术语 | 含义 |
| --- | --- |
| 沙箱（Sandbox） | 运行 Agent 的 Linux 容器，视为不可信区域 |
| 宿主机（Host） | 用户桌面系统，运行 Cove CLI、UI、保险箱、broker |
| Broker | 独立运行的可信出网代理容器，负责策略、TLS 终止、凭据注入、审计；与沙箱共享 internal 网络，沙箱只能访问它 |
| 占位符（Placeholder） | 每个会话生成的一次性假 Token，仅能由 broker 兑换为真实密钥 |
| 保险箱（Vault） | 宿主侧加密密钥存储，Windows 使用 DPAPI |
| Agent Profile | 某 Agent 的启动命令、环境变量、配置生成规则 |
| MCP Preset | 主流 MCP 的连接参数、所需密钥、允许域名、注入方式 |
| 会话（Session） | 一次 `cove run` 对应的 broker + 沙箱 + 网络 + 临时目录 |

## 5. 功能需求

优先级：P0 = v0.1 必须；P1 = v0.1 后首个迭代；P2 = 未来。

### FR-01 安装与诊断（P0）

- 提供 `cove setup`：检查 Docker 可用、Linux containers 模式、生成 CA、初始化保险箱、写入全局配置。
- 提供 `cove doctor`：逐项输出 Docker、镜像、CA、保险箱、端口、残留会话状态，并给出修复建议。
- 安装/诊断过程不要求用户编辑 JSON/YAML/Compose 文件。
- 失败时必须说明"哪一项失败、为什么、下一步做什么"，不得只打印堆栈。

**验收**：在干净 Windows 11 + Docker Desktop 环境，按 README 三步完成初始化；任一项缺失时
`doctor` 返回非零退出码并给出可执行建议。

### FR-02 工作区沙箱（P0）

- 每次运行创建独立容器，只挂载当前项目目录到 `/workspace`（读写）。
- 沙箱内进程以非 root 用户（UID/GID 1000）运行。
- 根文件系统只读；`/tmp`、`/run` 使用受限 tmpfs；home 使用会话独立卷。
- 禁止挂载宿主 home、SSH 目录、Docker socket、X11/Wayland socket。
- 默认资源限制：2 CPU、4 GiB 内存、512 PID、可选磁盘配额（v0.1 记录限制，不强制实现配额）。
- 启用 `no-new-privileges`、`cap-drop ALL`、默认 seccomp；禁止 `--privileged`、宿主网络、设备直通。
- 退出后删除容器、网络、临时配置和会话卷；异常退出由 `cove down` 兜底。

**验收**：沙箱内 `id` 非 root；`/root`、`~/.ssh`、`/var/run/docker.sock` 不可用；除 `/workspace`
和临时目录外不可写；Agent 退出后 `docker ps -a` 无 `cove.session` 残留。

### FR-03 网络隔离（P0）

- 沙箱只加入 Docker internal 网络，不加入 bridge/host 网络。
- 沙箱内唯一可路由的外部服务是 broker；broker 同时接入 internal 网络与出网网络。
- 沙箱直接访问公网、宿主网关、宿主其他端口必须失败。
- broker 对每个请求执行主机、方法、路径、凭据策略；未知目标默认拒绝。
- 禁止 IP 字面量、localhost、链路本地、私网目标，防止 SSRF。
- DNS 解析与连接使用同一地址并校验，防止 DNS rebinding。

**验收**：在沙箱内 `curl https://example.com` 失败；访问 `host.docker.internal` 失败；
访问仅被允许的假上游成功；`curl http://169.254.169.254` 失败。

### FR-04 凭据保险箱（P0）

- `cove secret set <id>`、`list`、`remove`、`rotate`。
- Windows 使用 DPAPI（CurrentUser）加密；密钥文件权限仅当前用户可读写。
- 密钥只在以下位置出现：用户输入、Cove 宿主进程内存、DPAPI 密文、broker 进程内存及容器启动环境
  （broker 解析后立即从 `process.env` 删除；容器删除后不残留，且不落在沙箱可见的挂载中）。
- 密钥不得写入 shell history、日志、审计、会话状态、异常堆栈。
- `list` 只显示元数据（ID、标签、允许域名、更新时间），不显示明文或掩码片段。
- 非 Windows 平台：优先系统 keychain；无可用后端时失败关闭，除非显式开发模式。

**验收**：保存后搜索整个仓库、`~/.cove` 非密文文件、审计日志和容器文件系统，均找不到明文；
DPAPI 密文在另一 Windows 用户下无法解密。

### FR-05 凭据注入（P0）

- Broker 对允许的 HTTPS 目标终止 TLS，并使用每个安装独立生成的 CA 签发叶证书。
- 支持两种注入：
  - **替换**：对指定主机强制写入 `Authorization`/`x-api-key` 等头。
  - **占位符兑换**：沙箱配置携带占位符，broker 只在凭据声明的允许主机上替换为真实值。
- 真实密钥只在 broker 进程内存中；不上行到日志。
- 占位符发往非授权主机时，请求必须被拒绝并记录安全事件。
- 上游 TLS 必须校验证书；不允许全局关闭校验。
- 代理认证使用每次会话随机 Token，Token 不是敏感凭据。

**验收**：假上游收到真实注入头；沙箱内只有占位符；把占位符发往未授权主机返回 403；
上游证书无效时 broker 拒绝连接。

### FR-06 Agent Profile（P0）

支持以下 Agent，且启动前自动准备配置：

| Agent | 命令 | 凭据方式 | 备注 |
| --- | --- | --- | --- |
| Claude Code | `claude` | `ANTHROPIC_API_KEY` 占位符；broker 注入 `x-api-key` | 关闭非必要遥测 |
| Codex | `codex` | `OPENAI_API_KEY` 占位符；broker 注入 `Authorization` | 关闭内部沙箱，由 Cove 提供边界 |
| DSH | `dsh web` | `DEEPSEEK_API_KEY` 占位符；broker 注入 `x-api-key` | v0.1 通过仅 loopback 的端口发布其 Web UI |
| Shell | `bash` | 无 | 用于调试与自定义 Agent |

- 用户可通过 `cove run <agent> -- <args>` 透传参数。
- 未安装的 Agent 必须给出清晰安装提示，而不是容器启动后 `command not found`。
- Agent 版本在镜像中固定，构建时校验来源（npm registry + 锁定版本）。

**验收**：`cove run claude -- --version` 成功；`env | grep -i key` 只显示占位符；
容器内配置文件无真实密钥。

### FR-07 MCP 接入（P0）

- 提供 `cove mcp add <preset>`、`list`、`remove`；本地控制台提供同等能力。
- 首批 preset：GitHub、Brave Search、Tavily、Exa、Firecrawl、Context7、Playwright、Filesystem。
- 需要密钥的 preset 在宿主机提示输入一次；密钥进入保险箱，不进入沙箱。
- 为 Claude Code、Codex、DSH 生成各自 MCP 配置；配置中只出现占位符或本地服务命令。
- 本地 stdio MCP server 在沙箱内运行；远程 HTTP MCP 由沙箱内客户端直接访问其 HTTPS 端点。
  两种方式的出网都必须经过 broker，允许域名由 preset 声明。
- 不支持原始 TCP 的 MCP 必须在 `add` 时明确拒绝，并说明原因。
- 用户可以添加自定义 MCP（P1），但必须显式声明主机与注入方式。

**验收**：`cove mcp add github` 后，Claude/Codex 配置无真实 Token；MCP 请求经 broker 注入；
移除 preset 后配置同步删除；`cove mcp add postgres` 给出"不支持原始 TCP"的明确错误。

### FR-08 出网策略（P0）

- 策略按主机、方法、路径前缀匹配；默认 deny。
- 默认允许：
  - 已配置凭据对应的 Agent API 主机（仅推理所需方法与路径）。
  - 已启用 MCP 声明的 API 主机。
  - npm/PyPI 等包注册表的只读 GET/HEAD（用于 `npx` 安装 MCP）。
- 默认拒绝：写方法（POST/PUT/PATCH/DELETE）到包注册表、GitHub 网页/API 写操作、未知域名。
- 用户可通过项目配置或 `cove allow`（P1）添加规则；v0.1 至少支持在全局/项目 JSON 中声明。
- 请求体大小限制 16 MiB；超限返回 413。

**验收**：只读包请求成功；向包注册表 POST 被拒绝；未知域名拒绝；审计中出现策略命中的规则 ID。

### FR-09 审计（P0）

- 记录每次出网尝试：时间、会话、主机、方法、路径（去查询串）、状态、耗时、字节数、
  命中的凭据 ID、动作（allow/deny/error）、原因。
- 绝不记录 Header、Body、查询串、真实密钥、占位符值。
- 审计文件位于宿主机 `~/.cove/sessions/<id>/audit.jsonl`，仅当前用户可读。
- `cove audit [session]` 输出表格/JSON；本地控制台展示最近事件。
- 日志轮转：单会话超过 10 MiB 时截断并保留最近记录（v0.1 简单实现）。

**验收**：捕获的审计行不含密钥和 Header；拒绝事件可定位到规则；UI 与 CLI 读取同一数据源。

### FR-10 本地控制台（P0）

- `cove ui` 启动仅绑定 `127.0.0.1` 的本地服务，自动打开浏览器。
- 页面包含：概览（Docker/CA/保险箱/会话）、密钥管理、MCP 管理、审计、设置。
- 密钥输入使用密码框；保存后不回显；所有写操作使用 CSRF Token 与同源校验。
- 页面不加载任何第三方脚本、字体或分析代码。
- 服务默认使用 `127.0.0.1:7777`；端口被占用时回退到随机可用端口并打印实际地址；退出时关闭。
- 不提供远程访问能力。

**验收**：页面在无外网环境可用；API 无鉴权时拒绝跨站写请求；密钥永不出现在 HTML/JS 中。

### FR-11 多会话与清理（P0）

- 同一项目可并行运行多个会话，网络、broker、卷、占位符彼此隔离。
- 会话状态保存在 `~/.cove/sessions/<id>/session.json`，权限仅当前用户。
- `cove down <id>`、`cove down --all`、`cove status` 可用。
- 进程崩溃后残留资源可被下次 `doctor`/`down --all` 识别并清理。
- 会话 ID 使用随机 ULID/UUID，不使用项目名作为容器名。

**验收**：两个会话同时运行互不影响；删除一个不影响另一个；强杀 CLI 后 `down --all` 清理干净。

### FR-12 文档（P0）

- 需求、设计、威胁模型、用户指南、故障排查。
- 明确写出支持/不支持能力、残余风险、密钥生命周期。
- 每个提交附带评审记录（`docs/reviews/`）。

## 6. 非功能需求

### 6.1 安全

- **NFR-S1 失败关闭**：策略缺失、CA 缺失、凭据解密失败、Docker 网络创建失败时必须中止，不得降级为直连。
- **NFR-S2 最小权限**：宿主与容器均遵循最小权限；broker 不需要宿主文件系统写权限（审计目录除外）。
- **NFR-S3 不信任沙箱输入**：所有 Host/URL/Header/Body 都按不可信数据处理；限制大小、校验格式。
- **NFR-S4 密钥零日志**：日志、错误、审计、UI 响应统一走脱敏函数；测试覆盖。
- **NFR-S5 依赖可信**：固定版本、锁文件提交、构建时不执行未审核的远程脚本。

### 6.2 易用性

- **NFR-U1** 首次配置 ≤ 3 个交互步骤；正常路径不需要手写配置。
- **NFR-U2** 错误信息包含：发生了什么、为什么、用户可以做什么。
- **NFR-U3** 启动 Agent ≤ 5 秒（镜像已构建、依赖已缓存）。
- **NFR-U4** 中文界面/文档为主，代码与标识符英文。

### 6.3 兼容与性能

- Windows 11 22H2+，Docker Desktop 4.x，WSL2 后端。
- macOS/Linux 使用 Docker Engine/Desktop；v0.1 以 Windows 为验收平台。
- 空闲 broker 内存 < 100 MiB；单个会话元数据 < 50 KiB。
- 流式响应不整段缓冲；请求体上限 16 MiB。
- 日志写入不阻塞请求路径（异步追加，失败不导致请求失败但记录错误）。

### 6.4 可维护性

- TypeScript strict；核心策略、注入、配置生成、保险箱必须有单元测试。
- Docker 集成测试使用假上游，不依赖真实模型 API。
- 不引入不必要的框架；本地控制台无前端构建链。
- 关键安全不变量以测试固化。

## 7. 成功标准（v0.1）

| 编号 | 标准 | 验证方式 |
| --- | --- | --- |
| AC-1 | 沙箱内任何文件/env/进程参数不含真实密钥 | 集成测试扫描 + 手工检查 |
| AC-2 | 沙箱无法直接出网，只能经 broker | 容器内 curl 测试 |
| AC-3 | 允许的假上游收到 broker 注入的真实头 | 集成测试 |
| AC-4 | 未授权主机/方法被拒绝并审计 | 单元 + 集成测试 |
| AC-5 | Claude Code、Codex、DSH 配置生成正确且只含占位符 | 快照/单元测试 |
| AC-6 | 主流 MCP 配置无需用户输入密钥到沙箱 | 端到端假 MCP 测试 |
| AC-7 | 首次配置三步完成 | 手工走查 |
| AC-8 | 所有提交有评审记录且测试通过 | git log + docs/reviews |

## 8. 假设与依赖

- 用户已安装 Docker Desktop，并接受其许可；Cove 不静默安装 Docker。
- Docker Desktop 使用 Linux containers；Windows containers 不支持。
- 用户项目目录可通过 Docker Desktop 文件共享访问。
- Agent 使用 API Key 认证；订阅 OAuth 不在 v0.1 范围。
- 主流 MCP 的凭据通过 HTTP Header 传递；使用 URL/查询串传密钥的 MCP 需自定义适配（P1）。
- 上游服务允许经代理访问，且不强制证书固定（certificate pinning）。

## 9. 风险与待决事项

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Docker Desktop 许可/安装门槛 | 部分用户无法使用 | 文档明确；后续评估 Podman/WSL 后端 |
| 项目目录中的 `.env` 被 Agent 读取 | 项目内密钥泄露 | 启动前扫描并警告/拦截；文档建议移出 |
| 恶意 MCP 使用被注入凭据执行写操作 | 数据被改/外传 | 最小权限 Token、方法白名单、审计、后续写操作审批 |
| CA 被沙箱信任带来的中间人面 | 若 broker 被攻破可解密沙箱流量 | broker 最小化、只读、非 root、密钥仅宿主 |
| 证书固定/不走系统 CA 的工具 | 请求失败 | 明确不支持；提供诊断 |
| DSH 无默认 TUI，Web UI 端口需发布到宿主 | 本机端口暴露/兼容性 | 仅绑定 127.0.0.1、随机端口、DSH token；固定版本并回归 |
| Windows 文件权限/路径差异 | 挂载失败或不可写 | 集成测试覆盖；doctor 检查 |

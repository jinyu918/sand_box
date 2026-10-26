# Cove v0.1 安全评审

| 项目 | 内容 |
| --- | --- |
| 版本 | v0.1.0 |
| 评审人 | 主导开发（自评）+ 独立复核（见 §7） |
| 日期 | 2026-10-26 |
| 范围 | 提交 `4f4d1e6..`（实现）及 Docker 镜像 |
| 结论 | 有条件通过：独立复核提出的 4 个发布阻断项已修复并复测；Docker 边界与残余风险在发布说明中明示 |

## 1. 评审方法

- 对照 [需求](requirements.md) 的安全目标与 [威胁模型](threat-model.md) 的 T1–T17。
- 阅读每个提交的 diff，检查信任边界、默认值、错误路径与清理路径。
- 运行单元测试、真实 Docker 集成测试、CLI 冒烟与 UI API 测试。
- 用 canary 密钥扫描仓库、会话目录、审计、沙箱配置与容器 env。
- 对无法自动化的项做手工验证并记录命令/结果。

## 2. 安全不变量与证据

| # | 不变量 | 证据 | 结果 |
| --- | --- | --- | --- |
| I1 | 沙箱文件/env/配置不含真实密钥 | `test/session-lifecycle` 断言 env 与三份 Agent/MCP 配置不含 canary；真实轻量镜像 E2E 打印 env 仅见 `sk-ant-cove_*` 占位符 | 通过 |
| I2 | 保险箱静态密文不含明文 | `test/vault` 扫描 `vault.json`；CLI 实测 `sk-ant-test-value-123` 不在文件中 | 通过 |
| I3 | 沙箱无直接出网 | `test/integration` 沙箱访问 `example.com` 失败；internal 网络无默认路由 | 通过 |
| I4 | 只有允许域名可解析 | broker DNS 对未知域名返回 NXDOMAIN；集成测试覆盖 | 通过 |
| I5 | 占位符只在授权主机兑换 | 集成测试：授权主机收到真实头；其他凭据占位符发往本主机返回 403 并审计 | 通过 |
| I6 | 审计不含密钥/占位符/Header | 集成测试扫描 `audit.jsonl`，无 canary、无 `authorization` | 通过 |
| I7 | 反向代理只走固定路由 | 集成测试 `broker:8080/anthropic/v1/messages` 注入并转发；其他前缀 404；broker 只绑定 internal IP | 通过 |
| I8 | 失败关闭 | 缺密钥、缺 CA、镜像缺失、broker 不健康均在沙箱启动前失败；`doctor` 不创建 CA | 通过 |
| I9 | UI 写请求需 CSRF + 同源 | `test/ui`：无 CSRF 403；有 CSRF 保存成功；密钥不回显；所有路径校验 Host | 通过 |
| I10 | 会话清理无残留 | 真实镜像 E2E：Claude/Codex/DSH 会话结束后容器、网络、卷、网关清理；`session.json` 为 stopped | 通过 |

## 3. 关键代码审查

### 3.1 凭据生命周期

- DPAPI 调用把明文放在子进程 stdin，不放 argv；错误信息不包含输入。
- 保险箱原子写；系统条目（CA 私钥）不出现在 `secret list`。
- broker 配置通过 `COVE_BROKER_CONFIG` 传入，解析后立即 `delete process.env`。
- 占位符随机、每次会话新生成；broker 的 placeholder 扫描覆盖 Header 与 URL。
- 配置生成器只接受 `PlaceholderProvider`，没有接收真实值的接口。

**审查意见**：宿主机当前用户可 `docker inspect` broker 环境、也可解密 DPAPI，这是信任根的一部分。
发布文档已写明，未把它当作沙箱可抵御的攻击。

### 3.2 网络与 TLS

- 沙箱只加入 internal 网络；broker 在 health 通过后才连接 bridge，避免启动阶段把沙箱暴露到出网网络。
- DNS 不向上游转发；白名单由同一 PolicyEngine 驱动，避免 DNS/HTTP 策略不一致。
- 透明 TLS 校验 SNI 与 Host 一致；叶证书 SAN=host；上游证书 `rejectUnauthorized:true`。
- 解析上游 IP 后拒绝私网/环回/链路本地；连接固定到该 IP，降低 rebinding 风险。
- 反向代理只接受配置中的前缀/方法/路径，不允许任意上游。

### 3.3 容器

- 沙箱：非 root 1000、只读根、cap-drop ALL、no-new-privileges、PID/内存/CPU 限制、tmpfs noexec。
- broker：只读根、cap-drop ALL，仅保留 `NET_BIND_SERVICE` + 用于降权的 `SETUID`/`SETGID`；
  绑定 53/443 后 `setuid(1000)`；无管理 API。
- 不挂载 Docker socket、宿主 home、SSH；项目路径含逗号直接拒绝。
- 项目敏感文件与根目录越界符号链接在启动前检查。

### 3.4 审计与 UI

- 审计 schema 是白名单；路径截断/去控制字符；查询串不落盘。
- UI 绑定 127.0.0.1；CSP 禁止第三方脚本；无 inline script；密钥输入 `type=password` 且不回显。
- API 不返回密钥值；`/api/status` 只返回元数据。

## 4. 发现与修复

| ID | 严重度 | 发现 | 状态 |
| --- | --- | --- | --- |
| F1 | 高 | 透明 TLS 路径最初未调用注入，假上游收到占位符 | 已修复，集成测试固化 |
| F2 | 高 | broker 在 cap-drop ALL 下无法降权，启动退出 | 已修复，增加 SETUID/SETGID 并写测试 |
| F3 | 中 | `doctor` 会创建 CA，产生隐藏副作用 | 已修复，新增只读 `inspectCa` |
| F4 | 中 | 沙箱镜像复用 UID 1000 时 `useradd` 冲突 | 已修复，复用基础镜像 UID 1000 用户并重测 |
| F5 | 中 | UI `hidden` 被 CSS 覆盖，首屏弹出密钥框 | 已修复，截图复验 |
| F6 | 低 | `Vault.set` 未传 hosts 会清空已有 hosts | 已修复，继承已有值 |
| F7 | 低 | `down --all` 不清理 failed 残留 | 已修复 |
| F8 | 严重 | 独立复核：broker 监听 0.0.0.0，bridge 上其他容器可无认证调用反向代理并消耗密钥 | 已修复：DNS/TLS/8080 只绑定 internal IP；bridge 侧不再有监听 |
| F9 | 严重 | 独立复核：DSH 日志 URL 未校验，Windows `cmd /c start` 可被 `&` 注入宿主命令 | 已修复：只接受 token 形式的 loopback URL；`openBrowser` 拒绝元字符；`httpReady` 不接受 404 |
| F10 | 高 | 独立复核：项目 `.cove/project.json` 可自行增添出网规则/关闭密钥扫描 | 已修复：默认忽略项目 egress 与 allow 标记，需显式 `--trust-project-config` / `--allow-project-secrets` |
| F11 | 高 | 独立复核：清理失败被吞、状态被覆盖、Ctrl-C 不清理 | 已修复：非零清理结果抛错、保留 failed、running 会话注册 SIGINT/SIGTERM、`down` 清理 DSH 网关 |
| F12 | 中 | 独立复核：审计 path 可含占位符 | 已修复：审计所有字段对已知凭据值/占位符做替换 |
| F13 | 中 | 独立复核：UI GET 未校验 Host | 已修复：所有请求先校验 `127.0.0.1:<port>` Host |
| F14 | 中 | 独立复核：编码路径分隔符绕过前缀策略 | 已修复：解码并规范化路径后再匹配 |

## 5. 残余风险（接受）

1. **Docker 边界**：共享内核，容器/Docker 逃逸不在防御范围。高风险代码建议独立 VM。
2. **项目内密钥**：preflight 只检查根目录两层；运行期新建符号链接、深层 `.env` 仍可能被读。
3. **MCP 能力**：Token scope 决定 MCP 能做什么；v0.1 无工具级审批。
4. **主机构建/宿主用户**：能运行 Docker 或当前 Windows 用户可读取 broker env/解密 DPAPI。
5. **CA 信任面**：沙箱信任 Cove CA；broker 被攻破可伪造上游响应。CA 私钥只在宿主/broker 内存。
6. **证书固定客户端**：不兼容，失败关闭。
7. **DSH Web**：仅 loopback，但本机其他进程可访问；依赖 DSH 自身 token/信任栅栏。
8. **Linux 宿主审计权限**：v0.1 验收平台是 Windows；Linux 的 bind mount UID 映射需另行验证。

## 6. 验证记录（执行）

```text
pnpm typecheck                                     通过
pnpm test                                          66 tests passed
pnpm build                                         通过
test/integration/broker-docker.test.ts             通过（真实 Docker）
cove secret set/list --stdin                       通过（DPAPI，vault 无明文）
cove run claude --no-tty + 轻量镜像 E2E            通过（占位符、挂载、清理）
Edge headless 截图                                  通过（概览/密钥弹窗布局）
```

真实镜像验收：`claude 2.1.310`、`codex 0.164.0`、`dsh 0.2.1-rc.2`；`cove run claude/codex`
通过；`cove run dsh` 通过本地回环网关提供 Web UI（带 token），`cove doctor` 全绿。
独立复核的 F8–F14 修复后，`pnpm test` 66 项通过；listener 绑定、Host/路径校验与审计脱敏由代码审查和针对性探测复核。

## 7. 独立复核

在最终提交前由独立 subagent 按本文件 §2 的不变量逐项检查代码与测试；发现的问题以新提交修复，
并在 `docs/reviews/` 记录。独立复核不替代正式第三方安全审计。

## 8. 发布条件

- P0 测试全部通过；
- 真实镜像构建成功，`claude/codex/dsh --version` 通过；
- `cove doctor` 在干净安装上全部通过；
- 发布说明明确 Docker 边界、项目密钥、MCP scope、CA 固定客户端不兼容。

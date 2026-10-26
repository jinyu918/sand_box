# Cove

**给 AI Agent 的桌面安全舱。Agent 拿到工作区，拿不到你的密钥。**

Cove 是一个面向本地 AI 编程 Agent（Claude Code、Codex、DeepSeek Harness/DSH）的桌面级安全沙箱。
它把 Agent 关进一个一次性的 Linux 容器，只给它当前项目目录；同时把所有 API Key、Token、
数据库密码留在宿主机的加密保险箱里，由可信 broker 容器在出网时注入。

```text
┌──────────────────────────────┐         ┌───────────────────────────┐
│  Sandbox                     │         │  Host                     │
│  Claude Code / Codex / DSH   │         │  Cove CLI + local console │
│  MCP servers                 │         │  DPAPI vault (secrets)    │
│  placeholders only           │         │  egress broker + CA       │
└──────────────┬───────────────┘         └─────────────┬─────────────┘
               │  only route: internal network           │
               └──────────────► broker ─────────────────┘
                                allowlist + credential injection + audit
                                        │
                                        ▼  HTTPS
                                   upstream APIs
```

## 当前状态

v0.1.0 已实现，验收平台为 **Windows 11 + Docker Desktop（Linux containers）**。
需求、设计、威胁模型、评审记录与用户指南均已提交；接口和配置格式仍可能变化。

## 为什么需要 Cove

把 API Key 放进 Agent 沙箱，等于把钥匙和保险柜一起交出去。即使容器隔离了文件系统，
一个被提示注入的 Agent 仍可以读取环境变量、配置文件、shell 历史，并把它们发到任意地址。
只做"容器"不解决凭据泄露，只做"密钥代理"不解决文件与进程隔离。

Cove 同时做三件事：

1. **工作区隔离**：只挂载当前项目，非 root、只读根文件系统、无 Docker socket、无宿主 home。
2. **网络收口**：沙箱没有直接出网能力，唯一可达的是可信 broker 容器；默认拒绝，按主机/方法/路径放行。
3. **凭据不落地**：密钥只存在于宿主机 DPAPI 保护的保险箱和 broker 内存中；沙箱里只有一次性占位符。
   broker 在 TLS 层完成真实凭据注入，并记录脱敏审计日志。

对用户而言，配置只有两步：`cove setup`，然后在项目里 `cove run claude`。
主流 MCP 通过 `cove mcp add <name>` 或本地控制台一键接入，沙箱配置文件里没有任何真实密钥。

## 快速开始

```powershell
# 0. 从源码构建（首次需要数分钟）
pnpm install
pnpm build
npm link

# 1. 一次性初始化：检查 Docker、生成 CA、创建保险箱、构建镜像
cove setup

# 2. 保存密钥（输入不回显，不经过沙箱）
cove secret set anthropic

# 3. 在任意项目目录运行 Agent
cd D:\code\my-project
cove run claude

# 4. 接入 MCP（密钥同样留在宿主机）
cove mcp add github
cove mcp list

# 5. 本地控制台：状态、密钥、MCP、审计
cove ui
```

Docker 构建 apt/npm 较慢时：

```powershell
$env:COVE_APT_MIRROR = "mirrors.aliyun.com"
cove build
```

## 安全边界（摘要）

Cove 的信任边界是 **Docker 容器**，不是虚拟机。它能显著降低 Agent 误用和提示注入造成的
凭据泄露、宿主文件访问与任意出网风险，但不能防御 Docker/Linux 内核漏洞或容器逃逸。
完整威胁模型、残余风险和不支持的能力见 [设计文档](docs/design.md) 与 [威胁模型](docs/threat-model.md)。

v0.1 明确不支持：订阅制 OAuth 登录、需要原始 TCP 的 MCP（如 PostgreSQL）、
把宿主机 home 目录挂进沙箱、在沙箱内填写任何真实密钥。

## 文档

- [需求文档](docs/requirements.md)
- [设计文档](docs/design.md)
- [威胁模型](docs/threat-model.md)
- [安全评审](docs/security-review.md)
- [架构决策记录](docs/adr/)
- [提交评审记录](docs/reviews/)
- [用户指南](docs/user-guide.md)

## 开发

```powershell
pnpm install
pnpm typecheck
pnpm test
```

集成测试需要 Docker Desktop（Linux containers）。测试只使用本地假上游，不调用真实模型 API。

## License

[MIT](LICENSE)

# Cove 用户指南（v0.1）

Cove 让 AI 编程 Agent 在一个只挂载当前项目的 Linux 沙箱里工作，同时把 API Key、Token 和密码
留在宿主机的 DPAPI 保险箱。沙箱只能访问一个出网 broker，broker 按主机/方法/路径放行，并在请求
离开本机前注入真实凭据。

## 1. 前置条件

- Windows 11（22H2 或更新），已启用 WSL2。
- Docker Desktop 4.x，使用 **Linux containers**。
- Node.js 22+ 与 pnpm 10+（从源码构建时）。
- 项目目录位于 Docker Desktop 可共享的磁盘（通常是 `C:` 或 `D:`）。

Cove 不是虚拟机。它不能防御 Docker/Linux 内核漏洞或容器逃逸；运行来源不明的高风险代码时，
请使用独立虚拟机。

## 2. 安装（源码）

```powershell
git clone <repo> cove
cd cove
pnpm install
pnpm build
node dist/cli.js setup
```

把 `dist/cli.js` 链接到 PATH，或使用：

```powershell
npm link
cove --version
```

中国网络环境可在构建 sandbox 镜像时使用镜像：

```powershell
$env:COVE_APT_MIRROR = "mirrors.aliyun.com"
cove build
```

## 3. 初始化

```powershell
cove setup
```

它会：

1. 检查 Docker 与 Linux containers；
2. 创建 `~/.cove`（仅当前用户可访问）；
3. 生成每个安装独立的本地 CA，私钥用 Windows DPAPI 加密；
4. 创建/校验保险箱；
5. 缺少镜像时自动构建（首次需要数分钟）。

检查状态：

```powershell
cove doctor
```

全部通过后再继续。`doctor` 不会创建或修改密钥。

## 4. 保存密钥

```powershell
cove secret set anthropic
cove secret set openai
cove secret set deepseek
```

- 输入不回显。
- `list` 只显示元数据，不显示值或掩码片段。
- 密钥保存在 `%USERPROFILE%\.cove\vault.json`，值字段为 DPAPI 密文。
- 更新同一 ID 就是轮换。

自动化/CI 可用管道（注意避免 shell history 泄露）：

```powershell
$env:ANTHROPIC_API_KEY | cove secret set anthropic --stdin
```

## 5. 运行 Agent

在项目目录：

```powershell
cd D:\code\my-project
cove run claude
cove run codex
cove run dsh
cove run shell
```

- `claude`：Claude Code，使用 `ANTHROPIC_API_KEY` 占位符，broker 注入真实 `x-api-key`。
- `codex`：Codex CLI，使用 Cove model provider（`http://broker:8080/openai/v1`）。
- `dsh`：DeepSeek Harness Web UI，仅发布到 `127.0.0.1` 随机端口，自动打开浏览器。
- `shell`：在沙箱里打开 bash，用于调试；没有任何模型密钥。

镜像预装 Node 22、git、curl、jq、ripgrep 与三个 Agent；v0.1 未预装 Python，Python MCP 需要自定义镜像。

参数透传：

```powershell
cove run claude -- --resume
cove run codex -- --model gpt-5
```

`cove run` 结束后会删除容器、网络、home 卷和临时配置；审计与会话元数据保留。

脚本/CI 可用 `--no-tty`（不分配 TTY）：

```powershell
"echo hello" | cove run shell --no-tty
```

### 项目内已有密钥文件

沙箱会挂载整个项目目录，因此项目里的 `.env`、`*.pem`、`.npmrc` 等文件对 Agent 可读。Cove 在启动前
扫描常见敏感文件并拒绝启动。确认风险后可显式允许：

```powershell
cove run claude --allow-project-secrets
```

项目里的 `.cove/project.json` 是不可信输入：默认只读取资源限制，不会采纳其中的额外出网主机，
也不会因为文件里的 `allowProjectSecretFiles` 而跳过扫描。确需信任该文件时显式加
`--trust-project-config`；`.env` 扫描仍只由 `--allow-project-secrets` 放行。

更安全的做法是把这些值移到宿主机 Cove 保险箱，项目里只保留 `.env.example`。

## 6. MCP

查看可用 preset：

```powershell
cove mcp list
```

接入：

```powershell
cove mcp add github
cove mcp add brave
cove mcp add context7
cove mcp add filesystem
```

- 需要 Token 的 preset 会在宿主机提示输入一次；Token 进入保险箱。
- Claude Code、Codex、DSH 的 MCP 配置自动生成，里面只有随机占位符。
- 本地 stdio MCP 在沙箱内运行，HTTPS 出网仍经 broker。
- 远程 HTTP MCP 由客户端直连，DNS/TLS 仍被 broker 接管。

v0.1 不支持：

- PostgreSQL/MySQL/Redis 等原始 TCP MCP；
- 只支持 OAuth 登录的远程 MCP（Notion/Sentry/Slack 等）；
- 使用证书固定（certificate pinning）的客户端。

断开（不删除 Token）：

```powershell
cove mcp remove github
```

## 7. 本地控制台

```powershell
cove ui
```

- 只监听 `127.0.0.1`，默认 `http://127.0.0.1:7777/`；端口占用时自动换端口。
- 可以保存/更新密钥、接入/断开 MCP、查看状态和审计。
- 页面不加载第三方脚本/字体；写请求要求同源 + CSRF Token。
- 关闭终端或 Ctrl-C 即停止服务。

## 8. 审计

```powershell
cove audit
cove audit <session-id> --json
cove audit --limit 200
```

记录字段：时间、会话、主机、方法、路径（去查询串）、状态、耗时、字节数、凭据 ID、命中规则、
allow/deny/error。不会记录 Header、Body、查询串或密钥。

## 9. 清理

```powershell
cove status
cove down <session-id>
cove down --all
```

会话异常退出后，`cove down --all` 会按 label 清理残留容器、网络和卷。

## 10. 故障排查

| 症状 | 原因/处理 |
| --- | --- |
| `Docker 不可用` | 启动 Docker Desktop，确认 `docker info` 成功，且是 Linux containers。 |
| `镜像尚未构建` | 运行 `cove build`；首次构建时间较长。 |
| `项目内含可能被 Agent 读取的密钥文件` | 移出 `.env`/私钥，或确认风险后加 `--allow-project-secrets`。 |
| `缺少 anthropic 所需的密钥` | `cove secret set anthropic`。 |
| MCP 请求 502/403 | 查看 `cove audit`；确认 preset 的主机在策略内，Token 有效。 |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `certificate verify failed` | 客户端不信任 Cove CA 或使用证书固定；v0.1 不兼容。Node/Python/curl/git 已通过环境变量指向信任包。 |
| DSH 页面打不开 | 用 `cove run dsh --no-open` 查看打印的 URL；确认 127.0.0.1 端口未被占用。 |
| Docker 构建 apt 很慢 | 设置 `COVE_APT_MIRROR`（如 `mirrors.aliyun.com`）后 `cove build`。 |
| 想彻底重置 | 先 `cove down --all`，备份后删除 `%USERPROFILE%\.cove`；这会丢失密钥与审计。 |

调试时设置 `COVE_DEBUG=1` 可看到脱敏后的异常堆栈；不要把输出直接发到公开渠道。

## 11. 安全边界（必读）

- 沙箱内的 Agent/MCP 被视为不可信；它们可以读整个项目目录，可以执行任意代码。
- 真实密钥只在宿主保险箱与 broker 内存；沙箱只有占位符。
- 出网默认拒绝；只允许策略中的主机/方法/路径。
- Docker 边界弱于 microVM；`cove doctor` 不会改变这一点。
- 宿主当前用户是信任根；能运行 Docker 的用户可以检查容器环境，也能解密 DPAPI。
- 项目内符号链接、运行期新建链接、允许主机上的写操作、Token 自身权限，都是需要用户判断的残余风险。

完整分析见 [威胁模型](threat-model.md)。

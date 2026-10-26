# ADR 0004 — DSH 通过 Web UI + 回环端口发布运行

- 状态：接受
- 日期：2026-10-26

## 背景

DSH（`@deepseek-ai/dsh`）当前发布物没有默认 TUI profile；交互形态是 `dsh web`，绑定一个具体
本地接口并打印带 token 的 URL。`dsh headless` 是一次性任务，不适合作为日常 Agent 会话。

## 决策

`cove run dsh`：

1. 在沙箱内启动 `dsh web --host <容器IP> --port <容器内端口> --no-open`。
2. Docker 只发布 `127.0.0.1:<宿主随机端口>:<容器端口>`。
3. 通过 `--public-url http://127.0.0.1:<宿主端口>` 与 `--trusted-host 127.0.0.1:<宿主端口>`
   让打印 URL 与浏览器信任栅栏匹配宿主地址。
4. 宿主等待 HTTP 就绪，打开浏览器；Ctrl-C 结束会话。
5. DSH 的模型流量走 `DEEPSEEK_BASE_URL=http://broker:8080/deepseek`；MCP 通过
   `$DSH_HOME/profiles/web/cordis.patch.yml` 插入 `@deepseek-ai/dsh-mcp-client` 条目。

## 结果

优点：

- 用户获得 DSH 原生 Web 体验，不需要在沙箱内登录或粘贴密钥。
- 端口只绑 loopback，不暴露到局域网；沙箱出网仍只经 broker。
- 与 Claude/Codex 的终端体验并存。

代价：

- 这是宿主机到沙箱的入站端口；本机其他进程可访问（DSH token 与浏览器信任栅栏缓解）。
- DSH Web 的 CLI 参数/信任栅栏可能随版本变化；镜像固定版本，升级需回归。
- 不覆盖 `dsh headless` 的脚本化场景（用户可在 `cove run shell` 内自行调用）。

## 备选方案

- **headless**：一次性、无交互，不满足"运行 Agent 应用"的日常体验。
- **在宿主运行 DSH、项目挂载进沙箱**：破坏隔离，密钥与文件暴露给宿主进程；放弃。
- **自建 TUI**：超出范围，且与上游体验不一致。

## 后续

DSH 若发布官方 TUI profile，增加 `cove run dsh --tui`；保留 Web 模式作为图形选项。

# ADR 0002 — DNS + 透明 TLS，而不是要求客户端配置代理

- 状态：接受
- 日期：2026-10-26

## 背景

需要在不让沙箱看到真实凭据的前提下，对 MCP/CLI 的 HTTPS 请求做策略与 Header 注入。

候选：

1. 正向 HTTP 代理 + CONNECT + TLS MITM，沙箱设置 `HTTPS_PROXY`；
2. 每个 Provider 一个反向代理，改 Agent 的 base URL；
3. 沙箱 DNS 把白名单域名解析到 broker，broker 在 443 终止 TLS；
4. 宿主侧运行 MCP server，沙箱只连 MCP RPC。

关键事实：Node 的 `fetch`/undici 默认不读取 `HTTPS_PROXY`（不同版本行为不一致）；大量 MCP server
用 Node/Python 的默认 HTTP 客户端。正向代理方案会静默失效，用户看到的是"网络不通"，很难诊断。
反向代理只能覆盖已知 Provider，不能覆盖任意 MCP 的固定 HTTPS 端点。

## 决策

采用 3 + 2 的组合：

- **透明路径**：broker 内置 DNS，只把策略允许的域名解析为 broker 的 internal IP；broker 在 443
  用每安装独立 CA 动态签发叶证书，终止 TLS、执行策略/注入，再以校验证书的方式连接上游。
- **反向路径**：对 Claude/OpenAI/DeepSeek 的模型流量提供 `http://broker:8080/<route>` 反向代理，
  Agent 通过 base URL 使用；这样模型流量不依赖 CA，且减少 TLS 终止面。
- 不配置 `HTTPS_PROXY`，也不实现 CONNECT 代理。

## 结果

优点：

- 对客户端透明；Node/Python/Go/Rust 只要走系统 DNS 与系统 CA 就能工作。
- DNS 层直接阻断未知域名与 DNS 隧道（broker 不转发沙箱查询）。
- 所有 HTTPS 请求都有统一审计点；IP 直连因无路由天然失败。
- Agent 模型流量可绕过 TLS MITM，降低 CA/证书兼容风险。

代价：

- broker 必须绑定 53/443（容器内 root 绑定后降权）；需要 `NET_BIND_SERVICE`。
- 客户端必须信任 Cove CA；证书固定（pinning）客户端不兼容。
- 使用 DoH/硬编码 IP 的客户端会失败（失败关闭，符合预期）。
- Windows Docker Desktop 的 DNS 转发行为需集成测试验证。

## 备选方案

- **正向代理**：客户端兼容性差，且需要代理认证；放弃。
- **仅反向代理**：无法覆盖任意 MCP；放弃。
- **宿主侧 MCP**：可以隐藏密钥，但恶意 MCP 在宿主运行会获得宿主权限，且 stdio 桥接复杂；v0.1 不做。

## 后续

如发现 Docker DNS 行为不稳定，可在镜像内写入 `/etc/hosts` 作为兜底（仅限固定主机列表）；不改变
TLS/策略模型。

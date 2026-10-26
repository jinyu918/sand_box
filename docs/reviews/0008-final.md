# 评审 0008 — 独立安全复核修复与最终验收

| 项目 | 内容 |
| --- | --- |
| 提交 | `fix(security): close independent review findings` |
| 评审人 | 主导开发（自评）+ 独立 subagent 复核 |
| 日期 | 2026-10-26 |
| 范围 | broker listener、DSH URL/浏览器、项目配置信任、清理、审计脱敏、UI Host、路径规范化、DSH 网关 |
| 结论 | 通过（限定于已测试不变量；非第三方正式审计） |

## 独立复核结论

独立复核最初给出 **REJECT**，4 个发布阻断项：

1. broker 监听 0.0.0.0，bridge 上其他容器可无认证调用并消耗密钥；
2. DSH 日志 URL 未校验，Windows `cmd /c start` 可被 `&` 注入宿主命令；
3. 项目 `.cove/project.json` 可自行增添出网规则/关闭密钥文件扫描；
4. 清理失败被吞、状态被覆盖、非 DSH Ctrl-C 不清理。

本轮逐项修复并复测。

## 修复

| ID | 修复 |
| --- | --- |
| S1 | DNS/TLS/8080 只绑定 broker 的 internal IP；health 仅 127.0.0.1；bridge 侧无监听。 |
| S2 | DSH 只接受 `?token=[A-Za-z0-9_-]+` 形式的 loopback URL；`openBrowser` 校验协议/主机/无元字符；`httpReady` 不接受 404。 |
| S3 | 默认忽略项目 `egress.extraHosts` 与 `security.allowProjectSecretFiles`；新增 `--trust-project-config`，密钥扫描只由 `--allow-project-secrets` 放行。 |
| S4 | 清理非零结果（除 no such/not found/already）抛错；failed 状态不再被覆盖；running 会话注册 SIGINT/SIGTERM；`down` 清理 DSH 网关。 |
| S5 | 审计所有字段按已知凭据值与占位符替换；路径先解码再匹配，阻断 `%2e%2e%2f` 前缀绕过。 |
| S6 | UI 所有请求（含 GET）先校验 `127.0.0.1:<port>` Host，DNS rebinding 不能读取 `/api/status`。 |
| S7 | DSH 通过 localhost 网关（仅 127.0.0.1 发布）访问；沙箱仍只连 internal 网络；网关无密钥。 |
| S8 | 补充 bridge 侧回归测试（必须 `BLOCKED`）、Body 占位符 400、缺失 CA 时 `SETUP_REQUIRED`。 |

## 最终验收

```text
pnpm typecheck                                     通过
pnpm test                                          16 files / 66 tests passed
真实镜像 claude --version                          2.1.310
真实镜像 codex --version                           codex-cli 0.164.0
真实镜像 dsh --version                             0.2.1-rc.2
cove doctor（真实镜像）                            所有检查通过
cove run claude/codex（真实镜像，--no-tty）        通过
cove run dsh                                       打印带 token 的 127.0.0.1 URL，303/401 探测正常
```

## 明确保留的残余风险

- Docker 共享内核/daemon 边界；容器逃逸不在范围。
- 项目深层/运行期新建符号链接；preflight 只覆盖根目录两层。
- MCP Token 能力与工具级写操作无审批。
- DSH 网关/端口对本机进程可见；DSH 自身 token 与信任栅栏是主要控制。
- 证书固定客户端不兼容；沙箱信任 Cove CA。
- 独立复核仍未覆盖所有组合（例如 Ctrl-C 的真实终端交互、真实模型 API 请求），
  发布说明不得声称"已通过第三方安全审计"。
- bridge 暴露现在有真实 Docker 回归测试；Ctrl-C 仅通过信号处理代码与清理路径审查，未做真实终端复现。

## 结论

阻断项已关闭。发布为 **v0.1.0（有条件）**：必须同时发布安全边界与上述残余风险说明。

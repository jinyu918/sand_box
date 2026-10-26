# 评审 0006 — 沙箱运行时、Agent 与 MCP 适配

| 项目 | 内容 |
| --- | --- |
| 提交 | `feat(sandbox): add runtime, agent profiles, and MCP adapters` |
| 评审人 | 主导开发（自评） |
| 范围 | `src/agents/`、`src/mcp/`、`src/session/`、`docker/sandbox.Dockerfile`、`docker/entrypoint.sh`、相关测试 |
| 结论 | 通过 |

## 检查清单

- [x] 沙箱只挂载项目、只读配置目录、CA 信任包和会话 home 卷。
- [x] 非 root、只读根、cap-drop、no-new-privileges、资源限制、独立 internal 网络。
- [x] Claude/Codex/DSH 使用占位符；真实密钥不进入环境或配置文件。
- [x] MCP 配置为 Claude/Codex/DSH 分别渲染；真实密钥不进入渲染输入。
- [x] 项目敏感文件与越界符号链接在启动前检查。
- [x] 会话清理幂等，失败会保留记录并提示 `cove down --all`。
- [x] 系统信任包覆盖 Node/Python/curl/git/Go 常见路径。

## 发现与处理

| ID | 发现 | 处理 |
| --- | --- | --- |
| R1 | 会话测试在清理后读取配置目录，误报 ENOENT。 | 在沙箱启动时快照配置，断言快照不含真实密钥。 |
| R2 | 项目资源只支持全局配置，项目覆盖未接入。 | `ProjectConfig.resources` 改为完整 ResourceConfig，生命周期优先使用项目值。 |
| R3 | DSH 无 TTY 形态；需要浏览器。 | 采用 `dsh web` + loopback 端口 + `--public-url`/`--trusted-host`；集成阶段验证。 |
| R4 | entrypoint 需要复制 Codex/DSH 配置到 home 卷。 | 仅在配置存在时复制；Claude 使用 `--mcp-config` 直接读取只读目录。 |
| R5 | 非 TTY/CI 无法运行交互 Agent。 | 增加 `--no-tty`，使用 `docker run -i`；用于冒烟测试。 |
| R6 | 项目路径含逗号会破坏 Docker `--mount`。 | preflight 拒绝并提示移动项目。 |

## 验证

- `test/session-lifecycle` 使用假 Docker 验证：启动顺序、占位符、清理、缺失密钥/项目密钥失败关闭。
- `test/mcp-render` 解析 JSON/TOML/YAML，断言配置中只有占位符。
- `test/docker-runtime` 断言沙箱 flags 与挂载不含宿主 home/Docker socket。
- 真实镜像的 `claude --version`/`codex --version`/`dsh --version` 与 DSH Web 在最终验收中执行。

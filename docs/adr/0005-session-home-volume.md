# ADR 0005 — 每会话一次性 home 卷与按项目只读边界

- 状态：接受
- 日期：2026-10-26

## 背景

Agent 需要可写的 home（npm 缓存、配置、临时文件），但宿主 home 不能挂载。候选：

1. tmpfs `/home/agent`；
2. 每会话 Docker volume；
3. 每项目持久 volume；
4. 宿主目录 bind mount。

## 决策

- 每个会话创建一次性 Docker volume `cove-home-<session>`，挂载到 `/home/agent`；会话结束删除。
- volume 首次挂载时从镜像内容初始化（包含预初始化的 DSH profile）。
- 项目目录是唯一的宿主 bind mount，读写挂载到 `/workspace`。
- 配置目录 `/cove/config` 只读挂载；CA 信任包只读。
- 不在会话之间保留 Agent 登录态；v0.1 使用 API Key，不需要 OAuth 持久化。

## 结果

优点：

- 会话之间不共享可写状态，减少投毒/持久化。
- 不把宿主 home 暴露给 Agent。
- 仍可使用 npx/pip 缓存于单次会话内。

代价：

- 每次会话重新下载 MCP 包（npx），启动可能变慢；可在 P1 增加"预热镜像"而非共享卷。
- DSH profile 初始化依赖镜像预置；镜像升级需重建。

## 备选方案

- **tmpfs**：最快、最干净，但 npm 解压和 DSH 运行需要空间；tmpfs 占内存，且无法保存会话内缓存。
- **每项目持久 volume**：启动快，但跨会话持久化可被 Agent 写入恶意配置/包，隔离性下降。
- **宿主 home**：直接违反 FR-02；放弃。

## 后续

提供 `cove run --ephemeral`（默认）与 `--persist-home`（显式、带警告）两个模式；v0.1 只实现前者。

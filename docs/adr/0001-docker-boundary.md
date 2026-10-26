# ADR 0001 — 用 Docker Linux 容器作为安全边界

- 状态：接受
- 日期：2026-10-26

## 背景

Cove 要在 Windows 桌面上隔离 Agent。候选边界：

1. WSL2 独立发行版 + 非特权用户 + netns/nftables；
2. Hyper-V / 微虚拟机；
3. Docker Desktop（Linux containers）；
4. Windows Sandbox / AppContainer。

约束：用户要一条命令运行主流 Agent；不能在每台机器上要求企业虚拟化平台；网络必须由沙箱外的东西
强制，不能让沙箱内 root 改防火墙。

## 决策

使用 Docker Linux 容器作为 v0.1 的安全边界：

- 每会话一个容器，非 root、只读根、cap-drop、no-new-privileges、资源限制。
- 单独 Docker `internal` 网络；broker 是唯一双网容器。
- 不挂载宿主 home、SSH、Docker socket。
- 宿主 Docker daemon 在信任边界内。

## 结果

优点：

- Windows/macOS/Linux 安装路径统一；Docker Desktop 已是多数开发者的现有依赖。
- 网络隔离可由 Docker 网络实现，沙箱内 root 无法修改宿主转发规则。
- 镜像可固定 Agent 版本，环境可复现。

代价：

- 弱于 microVM：共享内核，Docker/内核逃逸不在防御范围。
- 依赖 Docker Desktop 许可与 WSL2；无法服务不愿安装 Docker 的用户。
- Windows 文件挂载的权限/符号链接语义需要单独测试。

## 备选方案

- **WSL2 + netns**：更轻，但要在发行版内以 root 建网并防止 Agent 提权改规则，复杂且易错。
- **microVM**：安全性更好，但安装、镜像、GPU/文件共享和启动成本高，不适合 v0.1 的"一条命令"。
- **Windows Sandbox**：一次性、难持久化项目与工具链，不适合日常 Agent 工作流。
- **AppContainer/Job Object**：无法提供同等文件/网络隔离。

## 后续

评估 microVM 后端（如 Firecracker/WSL2 VM 模式）作为高风险用户的 P1 选项；保持 Runtime 接口可替换。

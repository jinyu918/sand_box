# ADR 0003 — Windows DPAPI 保险箱与 broker 环境传递

- 状态：接受
- 日期：2026-10-26

## 背景

密钥需要静态加密，且只能被 Cove 宿主进程与 broker 读取。候选：

1. `keytar`/系统 keychain 原生模块；
2. Windows DPAPI（CurrentUser）；
3. 自管 AES 主密钥文件；
4. 每次运行让用户重新输入，不落盘。

`keytar` 需要原生编译/预编译二进制，跨 Node 版本易碎；自管 AES 把主密钥放在密文旁边，只是混淆；
每次输入不友好。broker 是独立容器，需要拿到本会话密钥。

## 决策

- 静态存储：Windows DPAPI CurrentUser，通过系统 `powershell.exe` + stdin/stdout 调用
  `ProtectedData.Protect/Unprotect`；密钥不出现在命令行参数。
- 元数据（ID、标签、允许主机、时间）明文存储，密文单独字段；原子写。
- 运行时：CLI 解密后把 broker 配置（含密钥）序列化到 `COVE_BROKER_CONFIG` 环境变量，传给
  broker 容器；broker 解析后立即 `delete process.env.COVE_BROKER_CONFIG`。
- 不使用宿主机明文临时文件；容器删除后环境随之消失。
- 非 Windows 平台 v0.1 失败关闭（测试可使用注入的内存 protector）。

## 结果

优点：

- 无需原生 Node 模块；DPAPI 与 Windows 用户绑定，其他用户无法解密。
- 密钥不落明文文件，减少崩溃残留。
- broker 配置随容器生命周期结束，不需要清理临时文件。

代价：

- v0.1 仅 Windows；macOS/Linux 需后续实现 Keychain/Secret Service。
- 每次加解密启动一个 PowerShell 进程（~100–300ms），可接受。
- 宿主机当前用户可 `docker inspect` broker 环境；该用户本来就能解密 DPAPI，属于信任根。
- broker 启动参数在极短时间内出现在宿主进程列表；宿主机用户可见，沙箱不可见。

## 备选方案

- **keytar**：原生依赖与 Node ABI 风险；放弃。
- **AES + 主密钥文件**：密钥与密文同处，无法抵御同一用户/文件读取；放弃。
- **Docker secret**：仅 Swarm 支持，单机 Desktop 不适用。

## 后续

macOS 使用 `security` CLI（Keychain），Linux 使用 Secret Service；保持 `Protector` 接口不变。
评估把 broker 配置改为只读挂载 + 读后删除，以进一步缩短 env 暴露窗口。

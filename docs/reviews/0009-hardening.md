# 评审 0009 — 最终硬化回归

| 项目 | 内容 |
| --- | --- |
| 提交 | `test(security): add bridge, body, and CA fail-closed regressions` |
| 评审人 | 主导开发（自评） |
| 日期 | 2026-10-26 |
| 范围 | broker 监听绑定、Body 占位符、CA 缺失失败、Docker 集成测试 |
| 结论 | 通过 |

## 背景

独立复核之后，F8（bridge 暴露）只有代码修复；F15（Body 占位符）、F16（CA 缺失静默创建）
仍未固化。本轮补测试，避免"修了但没证明"。

## 变更

- 集成测试启动独立 bridge 容器访问 broker 的 bridge IP，必须得到 `BLOCKED`；broker 只绑定
  internal IP，因此 bridge 侧无监听。
- Docker 不可用时集成测试硬失败；只有显式 `COVE_SKIP_DOCKER=1` 才跳过，避免"绿但没跑"。
- `PolicyEngine.placeholderInBody` + broker 400 `placeholder_in_body`，防止占位符经 Body 绕过。
- `cove run` 先 `inspectCa`，缺失时 `SETUP_REQUIRED`；只有 `cove setup` 创建 CA。
- 生命周期测试显式创建 CA，避免测试依赖隐式行为。

## 验证

```text
pnpm typecheck                         通过
pnpm test                              16 files / 66 tests passed
bridge 探测                            BLOCKED（集成测试断言）
```

## 残余

- Ctrl-C 的真实终端交互未自动化；代码路径已注册 SIGINT/SIGTERM。
- 真实模型 API 未调用；使用假上游与占位符。

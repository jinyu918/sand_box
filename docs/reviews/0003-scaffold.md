# 评审 0003 — TypeScript 工程脚手架

| 项目 | 内容 |
| --- | --- |
| 提交 | `chore: scaffold TypeScript project` |
| 评审人 | 主导开发（自评） |
| 范围 | `package.json`、`pnpm-lock.yaml`、`tsconfig*.json`、`vitest.config.ts`、`scripts/`、`.dockerignore` |
| 结论 | 通过 |

## 检查清单

- [x] TypeScript strict + NodeNext，源码与测试都参与类型检查。
- [x] 依赖固定版本并提交锁文件；只有 `esbuild` 允许构建脚本。
- [x] 不使用前端框架，避免为单页控制台引入构建链。
- [x] Docker 构建上下文排除 `node_modules`、源码与测试，但保留 broker 需要的 `dist`。
- [x] 构建脚本把 broker 打成单文件，运行时镜像不需要 `node_modules`。

## 发现与处理

| ID | 发现 | 处理 |
| --- | --- | --- |
| S1 | `.dockerignore` 最初排除了 `dist`，broker 镜像 `COPY dist/broker.cjs` 失败。 | 已保留 `dist`，改为排除 `src`/`test`/`docs`；broker 构建验证通过。 |
| S2 | pnpm 10 默认忽略 `esbuild` 的 postinstall，导致打包器不可用。 | 在 `package.json` 的 `pnpm.onlyBuiltDependencies` 中显式允许，仍不开放其他脚本。 |
| S3 | 没有 lint/format 工具。 | 接受：v0.1 用 strict TS + 测试覆盖；避免为工具链增加无关依赖。 |

## 验证

- `pnpm install` 成功，`pnpm typecheck` 通过。
- `pnpm build` 生成 `dist/cli.js`、`dist/broker.cjs`、`dist/ui/public/*`。
- 未提交 `node_modules`、`dist` 或临时截图。

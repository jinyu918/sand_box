# 评审 0005 — Broker 与真实 Docker 集成

| 项目 | 内容 |
| --- | --- |
| 提交 | `feat(broker): add transparent egress broker` |
| 评审人 | 主导开发（自评） |
| 范围 | `src/broker/{main,proxy,tls,upstream}.ts`、`docker/broker.Dockerfile`、`docker/test-upstream/`、`test/integration/` |
| 结论 | 通过 |

## 检查清单

- [x] 沙箱无直接出网；只有 internal 网络；broker 是唯一双网容器。
- [x] DNS 把白名单域名解析到 broker；未知域名不可达。
- [x] 443 透明 TLS 按 SNI 签发证书，Host/SNI 必须一致。
- [x] 占位符只在授权主机兑换；发往未授权主机 403 并审计。
- [x] 反向代理只允许固定前缀/方法/路径，并强制注入 Agent 凭据。
- [x] 审计不含密钥、占位符、Header、Body、查询串。
- [x] broker 以 root 绑定 53/443 后降权；只读根、cap-drop、no-new-privileges。
- [x] 健康检查在容器内，不向沙箱暴露管理接口。

## 集成验证（真实 Docker）

测试启动本地 HTTPS 假上游、broker、沙箱，验证：

1. `upstream.test` 经 broker DNS 解析并注入真实 Authorization；
2. 查询串保留，Header 中只有占位符；审计不含真实值；
3. 把其他凭据占位符发往本主机返回 403，审计记录 `placeholder_leak_attempt`；
4. `example.com` 直连失败（NXDOMAIN/无路由）；
5. 反向代理 `broker:8080/anthropic/v1/messages` 正确剥离前缀、注入并转发 Body；
6. broker 健康检查通过。

## 发现与处理

| ID | 发现 | 处理 |
| --- | --- | --- |
| B1 | 透明 TLS 路径最初忘记调用注入函数，假上游收到占位符。 | 集成测试捕获；在 `handleTransparent` 注入后复测通过。 |
| B2 | broker 在 `--cap-drop ALL` 下无法 `setuid`，启动后退出。 | 增加 `SETUID`/`SETGID`（仅用于降权），并加入 Docker 加固单测与设计文档。 |
| B3 | 反向代理测试最初使用 placeholder 模式，未发送占位符导致不注入。 | 明确反向代理只用于 force 凭据；测试改用 force 凭据。生产 Agent 凭据本就是 force。 |
| B4 | 测试会话 ID 不符合 UUID 正则。 | 改用 `randomUUID()`；生产本身使用 UUID。 |
| B5 | 容器没有 `broker` 别名，Agent base URL 无法解析。 | broker 在 internal 网络增加 `--network-alias broker`。 |

## 残余风险

- 证书固定客户端不兼容。
- broker 依赖 Node/OpenSSL；被攻破时可读本会话密钥（宿主级攻击）。
- Docker 边界不是 VM。

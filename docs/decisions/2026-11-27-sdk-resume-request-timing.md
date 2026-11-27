# 内置网关续接与请求计时

## 问题与范围

右侧工具面板运行在截图时累计 572 秒，工具区间并集约 55 秒。SQLite 运行事件记录了多处 30–56 秒的工具间空档，未记录人工审批等待或 SDK API 重试。在本机同一会话、相同模型和执行模式的样本中，26 次内置网关仅换回环端口的运行都记录了 SDK 上下文重建。修复范围是 SDK 历史续接，以及在既有运行轨迹与诊断导出区分请求和本地工具的实际耗时。阶段证据记入[桌面执行日志](../../openspec/roadmaps/build-atelier-desktop/task-log.md)。

## 查阅来源与候选对比

- atelier 的 `desktop/host/managed-shunt.mts` 以 `127.0.0.1:0` 启动，`desktop/host/runtime.mts` 注入实际地址。`server/modules/gateway/service.ts` 决定当前有效的托管配置。固定端口会引入端口占用与运行实例冲突。按受信来源建立稳定身份可以沿用现有进程生命周期。
- Claude Code 2.1.332 随 Agent SDK 0.3.332 锁定。已从本机 CLI 核对 `claude_code.llm_request`、`ttft_ms` 和 `first_content_ms`。官方请求 span 包含尝试阶段，流事件从 SDK 交付时开始可见。两类数据可以在有可靠关联时互相印证。[监控文档](https://code.claude.com/docs/en/monitoring-usage) · [OTLP/HTTP](https://opentelemetry.io/docs/specs/otlp/)
- `pleaseai/shunt@ace707b1075ec6bc522f8a1c21904f227ae440c2` 的 `src/proxy.rs::post` 创建 `proxy_request`，可记录客户端会话 ID。`src/stream_metrics.rs::ObserverState::record_ttft` 统计首个非保活 SSE 帧。`src/telemetry.rs` 未提取传入的 W3C trace context。会话 ID 在并发请求间可能相同，现有接口不足以无歧义拼出逐次网关和上游时间。[请求路由](https://github.com/pleaseai/shunt/blob/ace707b1075ec6bc522f8a1c21904f227ae440c2/src/proxy.rs) · [流指标](https://github.com/pleaseai/shunt/blob/ace707b1075ec6bc522f8a1c21904f227ae440c2/src/stream_metrics.rs) · [遥测导出](https://github.com/pleaseai/shunt/blob/ace707b1075ec6bc522f8a1c21904f227ae440c2/src/telemetry.rs)
- `openai/codex@d7ebabf7b7bbd2b4b1004ba2fdd908a7c67971d1` 的 `codex-api/src/telemetry.rs` 将 `on_request` 和 `on_sse_poll` 分开，`sse/responses.rs::process_sse_with_treatment` 记录轮询、超时、解码错误和 EOF。这里沿用观测边界的划分，复用 SDK 自带流事件，避免为计时架设模型请求代理。[客户端遥测](https://github.com/openai/codex/blob/d7ebabf7b7bbd2b4b1004ba2fdd908a7c67971d1/codex-rs/codex-api/src/telemetry.rs) · [流消费](https://github.com/openai/codex/blob/d7ebabf7b7bbd2b4b1004ba2fdd908a7c67971d1/codex-rs/codex-api/src/sse/responses.rs)

## 结论与理由

只有当前运行的网关确实来自宿主时，才使用不含回环端口的内置 Shunt 身份。外部网关保持完整地址身份，执行器、运行模式、绑定 Agent 的版本继续参与兼容判断。保留旧键的算法。在同会话或已登记分叉来源存在对应的 SDK 消息锚点和托管运行时，可以按原始配置复算旧键并在 SDK 初始化成功后更新。其余历史按现有恢复流程处理。

请求计时由持有 SDK 连接的运行时采集。先在非必要联网关闭的条件下实测锁定 CLI 的本地导出。能取得官方 span 时只处理请求时间、数值和用于本地关联的标识。没有官方 span 时，保留 SDK 可观察到的首流、首内容、结束和已完成工具的时间。缺少关联或事件的字段保持缺失。首流前等待可包含 SDK、网关和上游多个环节，展示和导出以实际测量边界命名。

## 2026-11-27 · 真实网关的请求配对

真实 `gpt-6.2-sol` 经锁定 Shunt 请求时，HTTP 响应无 `request-id`，SDK Assistant 和 SSE 使用同一条消息 ID，但 Assistant 与 OTLP 请求跨度都未收到 HTTP 请求 ID。Shunt 0.64.0 的 `early_streaming_response` 先提交响应，原始上游请求 ID 此时尚不可用。Claude 的 SDK 从 HTTP `request-id` 采集请求身份，不能用流内消息 ID 代替。Envoy 的 `UUIDRequestIDExtension::set` 和 `setInResponse` 展示了在本地生成独立标识并回传的做法。[Shunt 早启流源码](https://github.com/pleaseai/shunt/blob/ace707b1075ec6bc522f8a1c21904f227ae440c2/src/adapters/responses/early_stream.rs#L42-L66) · [Claude API 请求标识](https://platform.claude.com/docs/en/api/errors#request-id) · [Envoy v1.32.0 UUID 扩展](https://github.com/envoyproxy/envoy/blob/v1.32.0/source/extensions/request_id/uuid/config.cc#L7-L29) · [Node HTTP 流生命周期](https://nodejs.org/api/http.html)

只在运行时确认连接为桌面托管 Shunt 且计时接收器可用时，为该轮 SDK 提供一个认证回环转发入口。固定目的地，清理逐跳头，保留流及背压，关闭时销毁该轮的上下游连接。对成功的 Messages 请求保留有效 `request-id`，缺失时只补工作台本机 ID。每条 HTTP 响应独立生成，现有 SDK 精确匹配和诊断脱敏逻辑继续生效。相比更换锁定 Shunt，转发可随运行时回退并沿用现有进程归属。相比按时间推断，唯一 ID 支持重试和并发。SDK 的目标地址在该轮环境中修改，持久配置、会话兼容键与网关凭据来源沿用原 Shunt。若回退，移除转发入口后仍可使用同样的会话和诊断记录，缺 ID 的记录继续分开。

## 验证与回退

使用真实锁定 SDK 和可控的本地回环模型，在隔离数据目录里更换端口并重开运行时。核对同一个 SDK 会话 ID 和真实请求里的既有工具证据。覆盖外部地址、模式、旧锚点和分叉边界。用分段延迟、重试和异常结束校准观测，核对无内容或凭据进入导出，且已有运行缺少新诊断字段时仍可查看。在隔离 Electron 里验收重启、运行轨迹和中英文交互。若回退代码，旧版可从已有应用历史恢复；回退后首次遇到新版托管兼容键时会重新构建 SDK 上下文。
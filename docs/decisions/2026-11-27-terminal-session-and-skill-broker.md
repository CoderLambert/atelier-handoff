# 终端附件会话拆解与搜索技能代理抽离决策

## 背景

`server/modules/terminal/manager.ts`（841 行）将进程台账管理、单连接快照围栏（`finishSnapshot`）、高低水位流控等待（`releaseOutputWait`）、多处状态集合判断及热路径重复 `JSON.stringify` 耦合在同一类中；同时 `server/skill-package-execution.ts`（532 行）将通用 Linux `bwrap` Python 沙箱执行器与 `@zhaopintong/multi-search-engine` 第三方 HTTP 代理逻辑硬编码捆绑，通过 `search?: boolean` 与若干 `!` 非空断言驱动。

## 决策

1. **拆分终端附件会话与实例对象**：
   - 新增 `server/modules/terminal/attachment-session.ts`（`TerminalAttachmentSession`、`OUTPUT_PAUSE_BYTES`、`OUTPUT_RESUME_BYTES`），收口单次连接 `snapshotSeq` 围栏、512/384/192 KiB 双水位流控、单调 `lastAck` / `inputSeq` / `commandSeq` 协议校验，并计算一次 `serializeFrame(frame)` 后将预序列化 `encoded` 透传给 `TerminalConnection.send(frame, encoded?)`。
   - `server/modules/terminal/transport.ts` 在 `ws.send(encoded ?? JSON.stringify(frame))` 直接复用预序列化字符串，消除快照校验和发帧热路径的多余序列化开销；保留 [工作台面板与终端流控决策](2026-11-26-terminal-workbench.md) 的全部阈值和时序语义。
   - 新增 `server/modules/terminal/terminal-instance.ts`（`TerminalInstance`、`outputChunks` 与统一状态谓词 `isTerminalClosedOrClosing` / `isTerminalRetained` / `isTerminalClosing` / `isTerminalRunning`），管理顺序队列、`pauses` 集合及清理收尾；`manager.ts` 保留全部对外契约与重导出，专注于会话/票据生命周期协调。
2. **抽离搜索技能代理并通用化 Python 沙箱**：
   - 新增 `server/search-skill-broker.ts` 收口 `SEARCH_ORIGIN`、`SEARCH_GATEWAY_PORT`、`isAllowedSearchBrokerRequest`、`validateSearchSkillArgs`、`rewriteSearchCheckoutOutput` 与 `createSearchSkillBrokerSpec` / `PackagePythonBrokerSpec`。
   - `server/skill-package-execution.ts` 的 Python 引导脚本和 `runPackagePython` 改为接收通用可选 `broker?: PackagePythonBrokerSpec`（保留 `search?: boolean` 作为现有调用方和测试的薄兼容入口），消除 `options.root/state/output` 路径解构上的 `!` 断言；`server/skill-package-runtime.ts` 显式传入 `createSearchSkillBrokerSpec(options.args)` 并复用 `rewriteSearchCheckoutOutput`。

## 验证与回退

- **验证**：`npm run check`（`check:architecture`、`check:query`、`check:i18n`、`check:ui`、`tsc`、desktop、tools）、`npm run check:headers`、`npm run build`、`npm run build:desktop`；新增 `tests/terminal-attachment-and-broker.test.ts` 验证预序列化复传、双水位与协议边界以及搜索代理白名单与改写；复跑全部 `terminal-*.test.ts` 与 `skill-package-*.test.ts`、完整 `npm test` 及隔离真实 Electron 烟测 `scripts/smoke-right-tool-panels.mts`。
- **回退**：若连接流控或代理挂载出现回归，可将 `attachment-session.ts` / `terminal-instance.ts` 与 `search-skill-broker.ts` 合并回 `manager.ts` / `skill-package-execution.ts`，对 WebSocket 线协议、SQLite 结构及 HTTP 契约无任何破坏性变更。

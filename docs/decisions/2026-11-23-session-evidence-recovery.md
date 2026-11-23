# 会话续接与工具证据恢复

## 问题与范围

一次剧情图续聊中，前一轮 WebFetch 已取得剧情，下一轮变更扩展后启动新 SDK 上下文。应用恢复检查点仅包含搜索网址、工具 ID 和状态，未提供已抓取页面与结果的关联，模型再次获取同一网页。正常 SDK 续接和 SDK 自动压缩不同于应用的降级重建。保留用户当前权限、会话隔离与未确认副作用处理。

## 查阅来源

- [Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)：持久会话包含工具调用及结果；使用 session ID 恢复，示例在后续查询变更 allowedTools。应用锁定 `@anthropic-ai/claude-agent-sdk@0.3.326`，实际组合须用该版本验证。
- [OpenCode 工具历史转换](https://github.com/anomalyco/opencode/blob/4cf9db957485dd51a5b195fb6e2c1e03d8da1107/packages/core/src/session/runner/to-llm-message.ts)：根据持久化历史恢复已完成和错误工具结果，分别处理不完整调用。阅读源码，不等于运行该项目。
- [OpenCode 压缩实现](https://github.com/anomalyco/opencode/blob/4cf9db957485dd51a5b195fb6e2c1e03d8da1107/packages/core/src/session/compaction.ts)：压缩有界历史并逐步裁剪旧结果。
- [既有原生执行决策](2026-11-22-native-harness.md)：记录输出持久化、分页读取、执行者授权和恢复检查点。

## 候选及选择

继续使用 SDK 原生 transcript 是正常续聊的首选，可保留真实工具交互而不重新实现协议；但运行权限、执行范围或异常状态不能因恢复旧历史而继承旧授权。`sdkConfigKey` 改为版本化的 transcript 兼容身份，包含网关、执行器和绑定智能体版本，运行模式仍单独核对；当前工具与权限每次重新构造。旧版指纹首次不匹配时仍走原检查点恢复，完成后保存新版身份；停止和异常退出仍清除该身份。原始 transcript 不可用或不兼容时使用应用检查点，提供有界且可授权回查的来源证据。网页内容属于不可信历史资料；不能将搜索发现当成抓取成功，也不能将未知副作用视为已完成。

不采用按 URL 强制缓存或拦截网页请求：网页可能变化，模型有时需要更新，且它会改变 SDK 原生工具行为。应用检查点受大小预算约束，不能保证保留完整历史；用户主动要求更新时仍可重新抓取。

## 验证与回退

使用锁定 SDK 和隔离的本地模型传输替身，验证真实续接请求含旧工具结果、配置变更后本轮权限有效，并覆盖停止、重启及分支范围。检查点覆盖成功/失败及会话隔离。真实模型是否再次决定抓取需另做实际模型验收；替身只证明请求内容和工具执行契约。若恢复引入越权、未确认副作用重放或 SDK 无法正确处理旧 transcript，回退到原有严格配置指纹和检查点恢复，保留故障证据。

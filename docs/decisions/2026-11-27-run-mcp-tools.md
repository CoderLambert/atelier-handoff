# 运行 MCP 工具注册与执行拆分（C1 第 1 步）

`server/agent.ts` 同时装配 MCP 工具和协调 SDK 流，绑定与外部 MCP 各自实现参数上限、审批、授权复核和派发。此次拆分范围为工具注册和调用封装。用户仍通过原聊天和审批入口使用工具，执行仍在 Node 运行时。

- [Claude Agent SDK 自定义工具文档](https://code.claude.com/docs/en/agent-sdk/custom-tools#create-a-custom-tool)和已安装的 0.3.332 `sdk.d.ts` 定义了 `tool` 的 schema、处理器及 `createSdkMcpServer` 的注册方式。沿用两者和现有 SDK hooks，避免另开注册入口或替换应用的逐次审批。
- 仓库的 `prepare-run-scope.ts` 以数据及具名能力接收运行依赖，现有 `extension-mcp.ts` 的 `callMcp` 在发现和校验后通过回调复核，再执行远端工具。沿用这两个边界，将注册层置于 `server/modules/runs/mcp-tools/`。运行仍持有在途工作及记录，由注册模块调用窄能力。
- 共用调用封装只合并原有步骤。保留绑定和外部工具各自的参数校验顺序、审批内容和事件。跨项目授权继续遵循[共享 MCP 决策](2026-11-27-shared-project-mcp.md)。保留注册顺序，因为 Skill 绑定需检查当时已注册的内置工具，且注册结果会进入 SDK。

验收使用架构、类型、文件头检查及内存测试，覆盖授权撤销、逐次审批、派发复核与调用结果。完整运行时与 Electron 验收由主会话完成。回退时还原工具装配原调用块并移除拆出的模块，无数据转换。

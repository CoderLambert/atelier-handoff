# atelier 项目内 OpenWiki MCP 适配

## 决策

在本项目提供一个显式登记的 stdio 启动器，复用 atelier 的项目 MCP 表单、工具白名单和逐次审批。保留原生 Claude Code 的 `.mcp.json`，不打开 SDK 的项目设置自动加载，也不把项目脚本加入所有会话。

现有工作台使用 [MCP TypeScript SDK 的 stdio 客户端](https://github.com/modelcontextprotocol/typescript-sdk)，可以常驻，但上下游连接断开时不会转交服务端内存状态。OpenWiki 的 [MCP 实现](https://github.com/langchain-ai/openwiki/blob/main/src/integrations/mcp/server.ts) 和 [生命周期说明](https://github.com/langchain-ai/openwiki/blob/main/integrations/openwiki/SKILL.md) 将开跑和后续页面操作分开：开跑携带仓库根目录，后续调用携带 run ID。现有桌面回执证明 `begin` 能读出持久记录，后续调用却找不到活动运行；还不能据此断定是进程重建。

适配器只代理六个同步生命周期工具，固定到其工作目录所在的 Git 仓库，不接收其他仓库的根目录。它独享一个上游连接。如果在当前连接上尚未关联请求的 run ID，先只读核对 OpenWiki 写下的 `.run.json`（版本、ID、模式、语言），再在同一个上游连接调用官方 `begin`；只有返回同一个活动 ID 才把原请求发出。适配器不直接写状态文件，也不会在一次页面操作发出后自动重试。生命周期工具保留逐次审批：一次获准调用可能包含上述恢复步骤，恢复可以由 OpenWiki 更新它自己的运行状态。

## 验收与回退

用隔离的临时 Git 仓库和有状态的 stdio 替身复现“每个连接的内存状态独立”：验证两次工具调用、关闭适配器再启动后的同 ID 恢复、错误 ID 和其他仓库的拒绝，以及发现工具不启动 Wiki 运行。真实验收仍要求用户在桌面登记启动器后对本机 OpenWiki 做连续调用，不能用替身通过代替真实同步成功。回退只需还原该项目扩展的命令与参数，不删除既有 Wiki 或运行记录。

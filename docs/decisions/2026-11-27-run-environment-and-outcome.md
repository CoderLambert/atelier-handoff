# C1 第 4 步：运行进程、环境与终态

## 问题与范围

`AgentRunner` 同时持有两套 SDK 进程清理路径、启动资源及终态规则。将它们移到每轮运行专用的模块，保留对话启动、停止、超时、服务关闭和会话续接的现有行为。改动位于 Node 运行时，沿用当前 SDK、持久格式及公开入口。[桌面路线图 P5](../../openspec/roadmaps/build-atelier-desktop/roadmap.md#阶段与依赖)

## 依据与选择

- Claude Agent SDK 0.3.332 的锁定声明区分运行的取消信号和 SDK 在 EOF 宽限后转发的信号。Node 的 `spawn` 用转发信号触发终止和 `AbortError`，实际退出仍由 `exit` 确认。Python SDK v0.1.0 的 `SubprocessCLITransport.close` 同样持有管道和进程生命周期，但采用自己的 terminate/wait 路径。Atelier 保留原生模式的 `createHarnessProcess` 后代归属与清理凭据，以及受控模式的单子进程、1 秒取消升级和 8 秒收尾升级。两种模式共用 SDK spawn 接口与清理结果。[TypeScript SDK](https://code.claude.com/docs/en/agent-sdk/typescript) · [Node v24.0.0 spawn 源码](https://github.com/nodejs/node/blob/v24.0.0/lib/child_process.js#L450-L475) · [Python SDK close 源码](https://github.com/anthropics/claude-agent-sdk-python/blob/v0.1.0/src/claude_agent_sdk/_internal/transport/subprocess_cli.py#L275-L314)
- 环境对象持有附件视图、Bash 临时目录、Skill 挂载、托管 Shunt 转发与 OTLP 接收器。进程退出后先关转发再收集跨度。宿主在目录移除前完成计时、等待后台工作并结算子任务。沿用精确 `request-id` 配对及原会话兼容键。[SDK 续接与请求计时决策](2026-11-27-sdk-resume-request-timing.md)
- 使用扁平守卫和取消原因映射保留终态优先级及文案。初始提示由纯函数拼装，项目指令的读取及会话续接仍由运行宿主编排。

## 验证与回退

用本地 Node 子进程验证正常退出、取消升级、收尾超时与启动失败。用表驱动单测核对终态和错误字段，用完整字符串断言核对提示顺序与换行。另检查运行导入边界、四组 TypeScript、文件头及格式。

若进程凭据、请求跨度、临时资源清理或运行终态出现回归，可恢复 `server/agent.ts` 中的对应实现并移除本次接线。继续使用既有会话数据和临时目录布局即可回退。

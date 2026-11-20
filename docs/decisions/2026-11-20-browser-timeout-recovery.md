# 浏览器工具超时与状态恢复

## 问题与范围

一次 `browser_snapshot` 在 30 秒后结束运行时等待。Electron 只调用 `webContents.stop()`，挂起的无障碍树请求继续占用标签。后续浏览器工具立即报忙，而模型能照常结束回复。浏览器工具失败需要独立记录，并直接在会话中显示。

## 取舍

Electron 的 `loadURL` 等待页面载入，`stop` 停止待处理的导航。Playwright 支持为导航选择等待条件和独立时限，Puppeteer 为 CDP 调用配置协议时限。简单延长所有工具的共同等待会推迟故障反馈。只在 Node 侧先返回错误，则无法告诉模型原标签是否已恢复，也会让下一次工具与清理竞争。Atelier 保留完整加载的导航语义，为导航留 60 秒，其余操作留 30 秒。主进程持有业务时限和清理权，运行时使用额外 5 秒 IPC 兜底并发送精确请求取消。

- [Electron WebContents](https://www.electronjs.org/docs/latest/api/web-contents)
- [Electron Debugger](https://www.electronjs.org/docs/latest/api/debugger)
- [Playwright `page.goto`](https://playwright.dev/docs/api/class-page#page-goto)
- [Puppeteer `protocolTimeout`](https://pptr.dev/api/puppeteer.connectoptions)
- [Playwright Chromium 会话回调清理](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/crConnection.ts)

## 恢复规则

- 读取快照和截图被取消时结束本次等待。快照释放旧调试连接。健康页面保留原实例、网址、表单、标签与项目分区，旧结果和元素引用失效。
- 导航停止后保留浏览器实际呈现的页面。输入或导航仍未在 1 秒内退出时，关闭原操作的视图，在同一分区补一个空白 Agent 标签，保留其他标签及独立的用户选中状态。正在执行工具的网页进程崩溃时走同一隔离路径。恢复过程不回放导航或输入。已发出的点击、输入和提交由模型或用户先核实页面结果。重新观察可以为后续操作生成有效引用。
- 浏览器异常仍写入本轮工具记录，转为模型可读的失败。会话直接呈现最近的原生浏览器工具失败和轨迹入口。后续工具仍可执行，最终模型回复和工具结果分别记录。
- 回退可恢复此前统一 IPC 时限，但必须独立保留有界取消，否则会复发标签占用。

## 验证计划

独立的 Linux Electron 夹具让原生快照回复保持挂起，取消后核对同一标签、网址和未提交表单值。还验证 31 秒的导航成功、输入等待超时后替换原标签、迟到回复与取消不会清掉下一次操作，以及隔离网页进程异常退出后的恢复。安装态回环夹具通过真实 SDK 验证导航达到生产时限、工具错误进入聊天、同页重新读取以及后续完整回复。

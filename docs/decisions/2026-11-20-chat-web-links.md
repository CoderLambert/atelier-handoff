# 桌面会话的网页链接

点击会话正文中的 HTTP 或 HTTPS 链接时，在一个 shadcn 对话框提供内置浏览器和系统默认浏览器两个入口。对话框显示目标地址，关闭后将焦点交回原链接。通过 Markdown 组件的可选回调接入桌面行为，普通 Web 会话仍使用原锚点。

内置入口在当前项目创建新标签，沿用地址栏导航的人工接管规则。外部入口由 Electron 主进程调用 `shell.openExternal`。两条路径从同一个浏览器 IPC 入口收敛到已校验的网页地址，继续检查可信窗口、主 frame 和工作台 origin。外部打开仅响应用户在选择对话框中的操作。参考 [Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security) 和 [Electron shell](https://www.electronjs.org/docs/latest/api/shell)。

用 Linux 安装件和本地网页验证链接点击、原生标签、外部打开分发和协议拒绝。

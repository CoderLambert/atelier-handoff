# 工作台路由和设置页面

工作台之前用组件状态和 Redux 切换功能，同一地址无法表达会话和内容页。TanStack Router 负责页面、会话、运行和设置分区的位置。Redux 继续保存草稿、提交和抽屉等交互状态。

参考 [TanStack Router 代码路由](https://tanstack.com/router/latest/docs/framework/react/routing/code-based-routing)和[历史记录类型](https://tanstack.com/router/latest/docs/framework/react/guide/history-types)。现有运行时只提供静态入口及白名单资源，选择 hash history 使直接打开和刷新仍命中同一受信入口，Electron 和网页使用同一地址结构。代码路由允许复用现有工作台外壳和面板组件。路由回退走标准浏览器历史。

Electron 重启时运行时端口变化。在现有 SQLite 设置表记录经过验证的位置，工作台根地址启动后用 replace 恢复。显式地址优先。设置以独立页面呈现，复用网关目录和现有设置操作。

验证所有主导航以及会话、轨迹、交付物、设置子页的前进后退、刷新与桌面冷启动。检查废弃会话和不存在的地址有明确退出入口。回退可恢复原组件导航，持久记录使用独立设置键。

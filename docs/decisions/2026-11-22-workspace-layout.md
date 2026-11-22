# 桌面工作区布局

三栏需要支持指针和键盘调宽，左栏能折叠，默认值和最近使用的宽度能在桌面重开后读取。现有工作区 CSS 负责断点切换，Electron 浏览器槽位负责把可信页面几何同步到宿主。

采用 [react-resizable-panels 4.24.1](https://github.com/bvaughn/react-resizable-panels/releases/tag/4.24.1)。该版本支持 React 19，提供像素尺寸、键盘分隔条及可折叠 Panel。[shadcn Resizable](https://ui.shadcn.com/docs/components/resizable) 以同一套库组成面板，现有主题可直接给 Separator 定样式。手工实现 CSS 网格分隔条还需要实现键盘、边界、指针捕获及恢复，放弃该路径。增加 [Radix Dropdown Menu](https://www.radix-ui.com/primitives/docs/components/dropdown-menu) 承载项目内会话操作，沿用现有确认 Dialog。

运行时持有布局偏好，与网关配置使用不同设置键。宽度用 CSS 像素，左、右初始值为 232 和 320，中间取得剩余空间。窄屏抽屉与三栏共享同一内容实例，临时裁剪尺寸不覆盖宽屏偏好。菜单或 Dialog 打开时使用原有 Electron 遮挡规则。验收使用隔离 Electron 检查拖动、键盘、重开以及缩放时浏览器槽位。移除三栏接线即可恢复 CSS 布局，原偏好行仍可保留。

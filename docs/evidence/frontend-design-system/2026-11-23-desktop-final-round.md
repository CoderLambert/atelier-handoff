# 桌面窗口与三栏收官验收

基于 `cf7852e`。本轮用 Linux Electron 45.4.1、隔离数据目录和浏览器 profile、回环模型与本地 HTML 网页运行。Chromium 前端回归使用合成会话和桥接替身，全量测试不读取用户工作区。

| 场景 | 结果与复跑方式 |
| --- | --- |
| 门禁 | `npm run check`、`npm run build`、`npm run build:desktop` 和变更文件头检查通过。`ATELIER_TEST_CHROMIUM=/usr/bin/chromium npm test` 通过 408 项，1 项既有 WebFetch 用例跳过。 |
| 原生菜单与主题 | Linux 实测菜单默认隐藏，Alt 呼出，Ctrl+C/X/V 仍可用。Ctrl+R 用 Wayland 虚拟键盘验证刷新。Parchment、Midnight 互切和分别重启后，原生底色和页面底色一致。Windows、macOS 与首帧逐帧闪烁未实测。 |
| 三栏布局 | `node --import tsx scripts/smoke-context-usage.mts` 通过。实测中栏顶栏和浏览器标签栏均为 48 CSS px，底边对齐。原生页可接收键盘输入，拖动分隔条时跟随槽位尺寸。新建、切换和关闭标签通过，关闭面板归还焦点。 |
| 遮挡与恢复 | 右侧变更抽屉和浏览器设置弹层打开时移除原生视图，Esc 关闭后视图恢复，焦点归还各自触发器。Chromium 还核对了抽屉贴右且占满高度，以及窄窗口的单栏浏览器。 |
| 工具摘要与回执 | Chromium 检查中文 URL 解码、畸形原样及原始参数保留。紧凑回执限高 180px，输入限高 120px，两类长内容均能内部滚动。普通详情和完整输出保留原尺寸。 |
| 已完成清单 | Chromium 确认第一次挂载 `3/3` 清单即收起，并保留历史清单的键盘操作。 |

[Wayland 实机三栏截图](2026-11-23-desktop-three-pane.png) 使用隔离窗口和本地页面，2048×1152 CSS px，截图为 2560×1440 像素。[机器可读烟测结果](2026-11-23-desktop-final-round.json)

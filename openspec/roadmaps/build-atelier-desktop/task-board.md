# atelier 桌面开发任务看板

按 [路线图](roadmap.md) 的验收标准逐阶段推进。实施取舍见 [整体设计](design.md)，命令、工件、结果和回退记录见 [执行日志](task-log.md)。状态在对应工件通过验收后更新。

| 阶段 | 交付目标 | 状态 | 验收与依赖 |
|---|---|---|---|
| P1 | Linux x64 安装样包 | 已验证 | [Arch 与便携包验收](../../../docs/evidence/desktop-p1-linux-x64/acceptance.json) |
| P2 | 宿主、运行时监督与恢复 | 已验证 | [安装态进程清理](../../../docs/evidence/desktop-p2-linux-x64/installed.json) 和 [故障恢复](../../../docs/evidence/desktop-p2-linux-x64/recovery.json) |
| P3 | 旧数据迁入与备份恢复 | 已验证 | P1 数据、迁入向导回调和回退副本。[最终验证记录](../../../docs/evidence/desktop-p7-linux-x64/workflows.json) |
| P4 | 原生浏览器与人工接管 | 已验证 | [标签与接管](../../../docs/evidence/desktop-p4-linux-x64/tabs.json) · [内置工具与安装态审批点击](../../../docs/evidence/desktop-p7-linux-x64/native-browser.json) |
| P5 | 运行时工具与 Agent 桌面流程 | 已验证 | [聊天审批、流式回复与上下文续接](../../../docs/evidence/desktop-p5-linux-x64/agent.json)，取消和截图见 P2/P4 |
| P6 | 桌面文件操作 | 已验证 | 拖入附件、另存、取消及定位。[文件记录](../../../docs/evidence/desktop-p7-linux-x64/workflows.json) |
| P7 | Linux x64 正式发行验收 | 本地候选已验证 | [最新归档校验值与内置浏览器验收](../../../docs/evidence/desktop-p7-linux-x64/native-browser.json) · [退出与恢复](../../../docs/evidence/desktop-p7-linux-x64/ipc-shutdown.json) · [安装态功能](../../../docs/evidence/desktop-p7-linux-x64/workflows.json) · [Wayland](../../../docs/evidence/desktop-p7-linux-x64/wayland.json) · [第三方许可](../../../docs/evidence/desktop-p7-linux-x64/license-update.json)。对外发行等待应用及工作区组件许可证和发布授权 |
| P8 | Windows 移植与安装验收 | 阻塞 | 已准备宿主正常退出和恢复测试入口。需 Windows 构建与运行环境。签名身份在分发阶段确认 |
| P9 | macOS 移植与安装验收 | 阻塞 | 恢复测试入口可定位 `.app` 内运行时。需 macOS 构建与运行环境。对外分发需 Developer ID 和公证权限 |

## P2 · 已验证

- [x] 用隔离数据复现 P1 窗口关闭、运行时退出和重复启动行为。
- [x] 记录生命周期协议、运行时配对、写者锁与恢复取舍。[P2 决策](../../../docs/decisions/2026-11-20-desktop-runtime-supervision.md)
- [x] 拆分宿主窗口与 sidecar 监督，提供故障状态和重启入口。
- [x] 收尾时停止接收任务，等待在途工具结束或取消，保存中断和审批状态。
- [x] 检查导入边界和旧连接，验证 Electron 协议、恢复流程及归档中的进程清理。
- [x] 将验收结果和开发过程 review 写入执行日志。

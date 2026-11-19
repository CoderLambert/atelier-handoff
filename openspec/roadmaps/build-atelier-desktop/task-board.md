# atelier 桌面开发任务看板

按 [路线图](roadmap.md) 的验收标准逐阶段推进。实施取舍见 [整体设计](design.md)，命令、工件、结果和回退记录见 [执行日志](task-log.md)。状态在对应工件通过验收后更新。

| 阶段 | 交付目标 | 状态 | 验收与依赖 |
|---|---|---|---|
| P1 | Linux x64 安装样包 | 已验证 | [Arch 与便携包验收](../../../docs/evidence/desktop-p1-linux-x64/acceptance.json) |
| P2 | 宿主、运行时监督与恢复 | 已验证 | [安装态进程清理](../../../docs/evidence/desktop-p2-linux-x64/installed.json) 和 [故障恢复](../../../docs/evidence/desktop-p2-linux-x64/recovery.json) |
| P3 | 旧数据迁入与备份恢复 | 进行中 | [迁入决策](../../../docs/decisions/2026-11-20-desktop-data-migration.md) · 隔离数据副本与桌面入口验收 |
| P4 | 原生浏览器与人工接管 | 待实施 | P2/P3；项目分区、多标签、控制交接、截图交付 |
| P5 | 运行时工具与 Agent 桌面流程 | 待实施 | P4；工具发现、流式回复、逐次审批、取消与交付 |
| P6 | 桌面文件操作 | 待实施 | P3/P5；原生选择、粘贴/拖入、导出和定位 |
| P7 | Linux x64 正式发行验收 | 待实施 | P1–P6；安装件全功能、升级回退和诊断 |
| P8 | Windows 移植与安装验收 | 待实施 | P7；Windows 构建、签名方案与真机 |
| P9 | macOS 移植与安装验收 | 待实施 | P7；macOS 构建、签名/公证权限与真机 |

## P2 · 已验证

- [x] 用隔离数据复现 P1 窗口关闭、运行时退出和重复启动行为。
- [x] 记录生命周期协议、运行时配对、写者锁与恢复取舍。[P2 决策](../../../docs/decisions/2026-11-20-desktop-runtime-supervision.md)
- [x] 拆分宿主窗口与 sidecar 监督，提供故障状态和重启入口。
- [x] 收尾时停止接收任务，等待在途工具结束或取消，保存中断和审批状态。
- [x] 检查导入边界和旧连接，验证 Electron 协议、恢复流程及归档中的进程清理。
- [x] 将验收结果和开发过程 review 写入执行日志。

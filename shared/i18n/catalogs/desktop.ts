/**
 * @file 提供桌面宿主、恢复、迁入与原生文件操作的双语词条。
 * @implementation 以稳定语义键和整句插值提供中文及英文，诊断原文由宿主作为数据保留。
 * @updated 2026-11-22T16:00:00+08:00
 */
export const desktop = {
  'host.failure.portInUse': [
    '工作台端口已被占用。释放端口后重试。',
    'The workspace port is in use. Free the port and try again.',
  ],
  'host.failure.dataLocked': [
    '工作台数据正在被其他实例使用。关闭该实例后重试。',
    'Another instance is using this workspace data. Close it and try again.',
  ],
  'host.failure.dataPath': [
    '工作台数据目录不可用。请检查目录及所有者。',
    'The workspace data directory is unavailable. Check its location and owner.',
  ],
  'host.failure.startupFailed': [
    '工作台服务启动失败。请查看运行日志。',
    'The workspace service could not start. Check the runtime logs.',
  ],
  'host.failure.startupTimeout': [
    '工作台服务启动超时。',
    'The workspace service took too long to start.',
  ],
  'host.failure.startupCanceled': [
    '工作台服务启动已取消。',
    'Workspace service startup was canceled.',
  ],
  'host.failure.connectionFailed': [
    '无法启动或连接工作台服务。',
    'The workspace service could not be started or reached.',
  ],
  'host.failure.disconnected': [
    '工作台服务连接已断开。',
    'The workspace service was disconnected.',
  ],
  'host.failure.exited': ['工作台服务已退出。', 'The workspace service has stopped.'],
  'host.failure.protocolMismatch': [
    '工作台服务协议不兼容。',
    'The workspace service protocol is incompatible.',
  ],
  'host.failure.notStopped': ['工作台服务尚未停止。', 'The workspace service has not stopped yet.'],
  'host.failure.rendererGone': [
    '工作台窗口意外退出。',
    'The workspace window closed unexpectedly.',
  ],
  'host.failure.windowTimeout': [
    '工作台窗口加载超时。',
    'The workspace window took too long to load.',
  ],
  'host.recovery.detail': [
    '重新启动服务后可查看历史。中断的任务不会自动重跑。',
    'Restart the service to view your history. Interrupted tasks will not run again automatically.',
  ],
  'host.recovery.diagnostic': ['诊断详情：\n{{diagnostic}}', 'Diagnostic details:\n{{diagnostic}}'],
  'host.recovery.restart': ['重新启动服务', 'Restart service'],
  'host.action.exit': ['退出', 'Exit'],
  'host.action.cancel': ['取消', 'Cancel'],
  'host.action.ok': ['确定', 'OK'],
  'host.migration.chooseTitle': [
    '选择旧版工作台的数据目录',
    'Choose the old workspace data directory',
  ],
  'host.migration.chooseMessage': [
    '先退出使用该数据目录的旧版。请选择包含 atelier.sqlite 的目录。',
    'Close the old version using this data directory first. Choose the directory containing atelier.sqlite.',
  ],
  'host.migration.chooseButton': ['选择目录', 'Choose directory'],
  'host.migration.confirmTitle': ['迁入旧工作台数据', 'Import old workspace data'],
  'host.migration.confirmMessage': [
    '将旧工作台迁入新目录？',
    'Import the old workspace into a new directory?',
  ],
  'host.migration.confirmDetail': [
    '来源 {{source}}\n目标 {{destination}}\n原项目目录及旧数据保留。网页可能需要重新登录。',
    'Source: {{source}}\nDestination: {{destination}}\nYour original project directories and old data will be kept. Websites may require you to sign in again.',
  ],
  'host.migration.import': ['迁入', 'Import'],
  'host.migration.completeTitle': ['工作台数据已迁入', 'Workspace data imported'],
  'host.migration.completeMessage': [
    '已迁入 {{projects}} 个项目和 {{sessions}} 个会话',
    'Imported projects: {{projects}}; conversations: {{sessions}}',
  ],
  'host.migration.completeDetail': [
    '附件 {{attachments}} 个，交付物 {{artifacts}} 个。\n回退副本 {{backupPath}}',
    'Attachments: {{attachments}}; deliverables: {{artifacts}}.\nRollback copy: {{backupPath}}',
  ],
  'host.migration.open': ['打开工作台', 'Open workspace'],
  'host.migration.failedTitle': ['未迁入旧数据', 'Old data was not imported'],
  'host.migration.failedMessage': [
    '无法迁入所选工作台数据。',
    'The selected workspace data could not be imported.',
  ],
  'host.migration.worktreesLive': [
    '请先在旧工作台完成工作树操作并回收独立检出，再迁入到新数据目录。',
    'Finish the Git operations and reclaim the linked worktrees in the original workspace before importing to a new data directory.',
  ],
  'host.migration.worktreeSnapshotInvalid': [
    '工作树快照未通过完整性校验。',
    'A worktree snapshot failed verification.',
  ],
  'host.migration.failedDetail': [
    '检查来源目录及目标位置，再启动迁入向导。',
    'Check the source directory and destination, then start the import wizard again.',
  ],
  'host.files.chooseDirectory': ['选择项目目录', 'Choose project directory'],
  'host.files.chooseButton': ['选择目录', 'Choose directory'],
  'host.files.saveArtifact': ['另存交付物', 'Save deliverable as'],
  'host.files.saveButton': ['保存', 'Save'],
  'host.files.exportDiagnostics': ['导出工作台诊断', 'Export workspace diagnostics'],
  'host.files.exportButton': ['导出', 'Export'],
  'host.files.invalidSource': [
    '文件操作来源无效。',
    'The file operation came from an untrusted source.',
  ],
  'host.files.connectionChanged': ['工作台连接已更新。', 'The workspace connection has changed.'],
  'host.files.readFailed': [
    '无法读取交付物，请重新打开后重试。',
    'The deliverable could not be read. Open it again and retry.',
  ],
  'host.files.tooLarge': [
    '交付物超过另存大小限制。',
    'The deliverable exceeds the size limit for saving a copy.',
  ],
  'host.files.saveFailed': ['无法保存选定的文件。', 'The selected file could not be saved.'],
} as const;

/**
 * @file 定义应用标题、语言偏好和共享错误词条。
 * @implementation 用成对的简体中文与英文文本覆盖跨功能的提示。
 * @updated 2026-11-22T22:58:24+08:00
 */
export const common = {
  'app.title': ['atelier. — 把决定留给你', 'atelier. — The decisions are yours'],
  'language.saveFailed': [
    '无法保存界面语言。请重试。',
    'Could not save the display language. Try again.',
  ],
  'errors.conflict': ['状态已变更，请刷新后重试。', 'The state changed. Refresh and try again.'],
  'errors.unavailable': ['所需资源已不可用。', 'The requested resource is no longer available.'],
  'errors.invalidInput': ['请检查输入后重试。', 'Check the input and try again.'],
  'errors.permissionResponseMismatch': [
    '审批响应不匹配，请重新加载。',
    'The approval response did not match. Reload and try again.',
  ],
  'errors.permissionExpired': ['审批已失效。', 'The approval request is no longer active.'],
  'errors.busy': ['工作台正忙，请稍后重试。', 'The workbench is busy. Try again in a moment.'],
  'errors.fileActionFailed': ['文件操作失败，请重试。', 'The file operation failed. Try again.'],
  'errors.fileActionUnavailable': [
    '当前环境不支持原生文件操作。',
    'Native file actions are unavailable in this environment.',
  ],
  'errors.fileCopyMissing': [
    '已保存的副本不可用，请重新保存。',
    'The saved copy is unavailable. Save it again.',
  ],
  'errors.modelCatalogInvalid': [
    '模型列表格式不正确，请重新加载。',
    'The model catalog is invalid. Reload it and try again.',
  ],
  'errors.fileTooLarge': ['文件超过大小限制。', 'The file exceeds the size limit.'],
  'errors.pathDenied': ['无法访问该路径。', 'This path is not accessible.'],
  'errors.sessionArchived': ['会话已归档。', 'The session is archived.'],
  'errors.runActive': ['会话仍有任务在运行。', 'This session still has an active run.'],
} as const;

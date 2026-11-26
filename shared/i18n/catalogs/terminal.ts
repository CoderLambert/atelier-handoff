/**
 * @file 提供人工终端和功能面板的双语文案。
 * @implementation 覆盖生命周期、连接恢复、可用能力和无障碍名称。
 * @updated 2026-11-26T01:00:00+08:00
 */
export const terminal = {
  title: ['终端', 'Terminal'],
  open: ['打开终端', 'Open terminal'],
  hide: ['收起终端面板', 'Hide terminal panel'],
  expand: ['全屏查看终端', 'Expand terminal to full window'],
  dock: ['收回终端侧栏', 'Dock terminal sidebar'],
  resize: ['调整终端面板宽度', 'Resize terminal panel'],
  new: ['新建终端', 'New terminal'],
  creating: ['正在创建终端…', 'Creating terminal…'],
  end: ['结束终端', 'End terminal'],
  remove: ['关闭已退出终端', 'Close exited terminal'],
  endTitle: ['结束这个终端？', 'End this terminal?'],
  endDescription: [
    '此终端内仍在运行的进程会结束。其他终端和会话任务继续运行。',
    'Processes still running in this terminal will end. Other terminals and session tasks continue.',
  ],
  cancel: ['取消', 'Cancel'],
  retry: ['重试', 'Retry'],
  reconnect: ['重新连接', 'Reconnect'],
  connectionNotice: ['终端连接提醒', 'Terminal connection notice'],
  dismissNotice: ['知道了', 'Dismiss notice'],
  loading: ['正在读取终端…', 'Loading terminals…'],
  empty: ['当前会话还没有终端。', 'This session has no terminals yet.'],
  emptyHint: [
    '新建终端将在当前会话目录中打开 shell。',
    'A new terminal opens a shell in this session’s directory.',
  ],
  tabs: ['会话终端', 'Session terminals'],
  tab: ['终端 {{number}}', 'Terminal {{number}}'],
  closeTab: ['关闭终端 {{number}}', 'Close terminal {{number}}'],
  screen: ['终端屏幕', 'Terminal screen'],
  shell: ['Shell：{{name}}', 'Shell: {{name}}'],
  cwd: ['初始目录：{{path}}', 'Initial directory: {{path}}'],
  limit: [
    '此会话最多保留 {{count}} 个终端；关闭不用的终端后可继续新建。',
    'This session retains up to {{count}} terminals. Close an unused terminal to create another.',
  ],
  'state.creating': ['创建中', 'Creating'],
  'state.awaitingAttach': ['等待连接', 'Waiting for connection'],
  'state.starting': ['启动中', 'Starting'],
  'state.running': ['运行中', 'Running'],
  'state.exited': ['已退出', 'Exited'],
  'state.closing': ['结束中', 'Closing'],
  'state.cleanupFailed': ['清理失败', 'Cleanup failed'],
  'state.closed': ['已关闭', 'Closed'],
  'state.failed': ['启动失败', 'Start failed'],
  exit: [
    '进程已退出（退出码 {{code}}）。屏幕保留，新建终端可开始新的 shell。',
    'Process exited (code {{code}}). The screen is retained. Create a terminal to start a new shell.',
  ],
  signal: ['进程已结束（信号 {{signal}}）。', 'Process ended (signal {{signal}}).'],
  'connection.idle': ['等待显示终端', 'Waiting to display terminal'],
  'connection.connecting': ['正在连接…', 'Connecting…'],
  'connection.restoring': ['正在恢复屏幕…', 'Restoring screen…'],
  'connection.connected': ['已连接', 'Connected'],
  'connection.disconnected': ['连接已断开，输入已暂停。', 'Disconnected. Input is paused.'],
  'connection.replaced': [
    '此终端已在另一连接中打开。',
    'This terminal was opened in another connection.',
  ],
  'connection.failed': ['终端连接失败。', 'Terminal connection failed.'],
  'connection.disposed': ['终端已关闭。', 'Terminal closed.'],
  inputUnconfirmed: [
    '断线前部分输入未获得确认，不会自动重发。',
    'Some input was not acknowledged before disconnection and will not be resent.',
  ],
  runtimeChanged: [
    '运行时已重新启动，原终端不可连接。请按需新建终端。',
    'The runtime restarted. Previous terminals are unavailable. Create a new terminal when needed.',
  ],
  'unavailable.desktopRequired': [
    '终端仅在已配对的桌面应用中可用。',
    'Terminal is available in the paired desktop application.',
  ],
  'unavailable.platformUnsupported': [
    '当前平台尚不支持终端。',
    'Terminal is not supported on this platform yet.',
  ],
  'unavailable.nativeExecutionDisabled': [
    '本机执行已停用，无法打开终端。',
    'Native execution is disabled. Terminal is unavailable.',
  ],
  'unavailable.runtimeUnavailable': [
    '终端运行时暂不可用。',
    'The terminal runtime is unavailable.',
  ],
  'unavailable.archived': [
    '已归档会话不能新建终端。',
    'Archived sessions cannot create terminals.',
  ],
  'unavailable.workspace': [
    '会话工作目录暂不可用，请先恢复工作树。',
    'The session directory is unavailable. Restore its worktree first.',
  ],
  'errors.failed': ['终端操作失败，请重试。', 'Terminal operation failed. Try again.'],
  'errors.unavailable': [
    '终端不可用，请检查桌面和本机执行设置。',
    'Terminal is unavailable. Check desktop and native execution settings.',
  ],
  'errors.limit': [
    '终端数量已达到上限，请先关闭不用的终端。',
    'The terminal limit was reached. Close an unused terminal first.',
  ],
  'errors.changed': [
    '运行时或会话工作目录已变化，请重新打开终端。',
    'The runtime or session directory changed. Reopen the terminal.',
  ],
  'errors.closed': ['该终端已关闭。', 'This terminal was closed.'],
  'errors.conflict': [
    '终端请求已变化，请刷新后重试。',
    'The terminal request changed. Refresh and try again.',
  ],
  'errors.protocol': [
    '终端流状态不一致，请重新连接。',
    'The terminal stream is inconsistent. Reconnect to restore it.',
  ],
  'errors.timeout': ['终端连接超时，请重试。', 'The terminal connection timed out. Try again.'],
  'errors.slow': [
    '终端输出超过当前连接的处理能力，请重新连接恢复屏幕。',
    'Terminal output exceeded this connection’s capacity. Reconnect to restore the screen.',
  ],
  panelLoading: ['正在打开面板…', 'Opening panel…'],
  panelFailed: [
    '此面板未能显示。可以重试或关闭面板。',
    'This panel could not be displayed. Retry or close it.',
  ],
  panelClose: ['关闭面板', 'Close panel'],
} as const;

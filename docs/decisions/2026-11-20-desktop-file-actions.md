# P6 桌面文件操作

项目绑定当前通过运行时调用系统目录选择器，附件已有 Chromium 文件选择和剪贴板粘贴，交付物已有工作台下载与预览。P6 为桌面使用者提供 Electron 原生目录选择、拖入附件、交付物另存与定位。

采用 Electron 的 [dialog](https://www.electronjs.org/docs/latest/api/dialog) 和 [shell.showItemInFolder](https://www.electronjs.org/docs/latest/api/shell#shellshowiteminfolderfullpath)。窗口内的文件选择和拖入继续复用现有附件上传入口及大小、类型、会话授权。桌面目录选择返回用户指定的目录，实际绑定仍经运行时原有路径校验。Web 沿用原入口。

宿主仅从当前配对运行时读取指定 ID 的交付物，弹出系统保存对话框并写入用户选择的位置。保存成功后按交付物 ID 记住这次创建的副本路径，定位操作只接受该 ID。文件副本保留原有交付物的内容与预览。IPC 校验主 frame、当前来源及 ID，失败向工作台返回可读提示。

在隔离工作区测试取消、成功保存和定位，加一条从消息拖入真实文件后出现在附件列表的路径。Linux 安装件回归使用同一套附件、PDF/HTML 和交付物测试。
# 网页附件的保存名称

苏州市人社局附件以十六进制标识作为 URL 文件名，响应未提供 `Content-Disposition`，页面链接另有中文附件标题。Electron 的 `DownloadItem.getFilename()` 返回建议文件名，工作台用它分配目标路径。

文件名形如十六进制标识且与原始链接文件名一致时，从发起下载的项目网页中查找该地址的唯一链接标题。使用隔离的脚本世界，仅提取匹配链接的标题。接受标题后保留下载原有的文件后缀，应用文件名清理及同名序号规则。标题缺失、模糊或读取超时时使用 Electron 的建议名称。参考 [Electron DownloadItem](https://www.electronjs.org/docs/latest/api/download-item) 和 [WebContents 隔离脚本](https://www.electronjs.org/docs/latest/api/web-contents#contentsexecutejavascriptinisolatedworldworldid-scripts-usergesture)。

安装态用无名称响应头的十六进制 Excel 链接验证可读名称、实际保存路径和同名文件保留。

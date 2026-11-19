# P3 旧工作区迁入

状态为提案。范围见 [P3 路线图](../../openspec/roadmaps/build-atelier-desktop/roadmap.md#阶段与依赖)。

开发版默认把 SQLite、SDK 会话、附件、交付物和完整工具输出保存在 `.data/`。安装版使用系统用户数据目录。项目源文件仍在各自目录，现有项目路径和 ID 在迁入后保持原值。旧 Electron profile 可能位于开发机默认用户目录或 `.data/desktop-profile`，网页登录凭据依赖 Chromium 和系统密钥环，P3 提供重新登录路径。

SQLite 使用 WAL。选择 [SQLite Online Backup](https://sqlite.org/backup.html) 及 [Node sqlite.backup](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackupsource-db-path-options) 生成一致的数据库副本，避免单独复制主库遗漏 WAL 内的数据。持有工作台数据租约结合 SQLite 快照，把文件库和会话副本对应到同一个时间点。应用可用数据包括四个有明确用途的文件目录，复制和校验只遍历这些内容。单表或 JSON 导出适合人工检查，无法独立恢复完整会话和附件引用。

迁入时先由用户在本机选择停止写入的旧数据目录和空的新位置。运行时迁移命令先保留完整备份，在同文件系统的临时目录准备新数据根，再检查 SQLite 完整性、记录关系和文件大小与哈希。通过后切换新位置。重复执行或现有目标包含数据时保留已有数据并提示选择空位置。已经生成新成果的新版数据与升级前备份分别保留。

验收使用隔离的 P1 schema 样本和附属于样本的项目目录，覆盖 WAL、附件与成果、源文件校验、运行时占用、已存在目标和数据损坏。完成迁入后用新运行时打开新位置，回退时另用旧版打开备份副本。

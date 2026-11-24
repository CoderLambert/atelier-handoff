/**
 * @file 展示 Git 文件类型、名称和所属目录。
 * @implementation 按文件类型选择图标，保留完整路径供悬停核对。
 * @updated 2026-11-24T04:36:00+08:00
 */
import { File, FileCode2, FileImage, FileJson2, FileText, Folder } from 'lucide-react';

const kinds = {
  code: {
    icon: FileCode2,
    extension: /\.(?:[cm]?[jt]sx?|py|go|rs|java|css|s?html|sh|sql|rb|vue)$/iu,
  },
  document: { icon: FileText, extension: /\.(?:mdx?|txt|rst|adoc|pdf)$/iu },
  config: { icon: FileJson2, extension: /\.(?:jsonc?|[iy]?ya?ml|toml|ini|lock|xml)$/iu },
  image: { icon: FileImage, extension: /\.(?:png|svg|webp|gif|jpe?g|avif)$/iu },
};

export function GitFileLabel({ path }: { path: string }) {
  const name = path.replace(/\/$/u, '');
  const at = name.lastIndexOf('/');
  const kind = Object.values(kinds).find(({ extension }) => extension.test(name));
  const Icon = path.endsWith('/') ? Folder : (kind?.icon ?? File);
  return (
    <>
      <span className="git-file-icon" aria-hidden="true">
        <Icon />
      </span>
      <span className="git-file-name" title={path}>
        <span className="git-file-basename">{name.slice(at + 1)}</span>
        {at >= 0 ? <small className="truncate">{name.slice(0, at)}</small> : null}
      </span>
    </>
  );
}

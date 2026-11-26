/**
 * @file 通知 Git 面板已授权工作树的本地变动。
 * @implementation 分别监听工作目录和 Git 元数据，合并无路径的 SSE 通知并随请求释放监听。
 * @updated 2026-11-26T21:22:00+08:00
 */
import type { ServerResponse } from 'node:http';
import { basename, isAbsolute, relative, sep } from 'node:path';
import { watch } from 'chokidar';
import type { LocalGit } from '../../modules/git/git-cli.js';

const checkoutMetadata = new Set([
  'HEAD',
  'index',
  'config.worktree',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply',
  'sequencer',
]);
const sharedMetadata = new Set(['config', 'packed-refs', 'refs', 'reftable']);

function segments(root: string, path: string) {
  const name = relative(root, path);
  const parts = name.split(sep);
  return parts[0] === '..' || isAbsolute(name) ? undefined : parts;
}

function metadataPath(git: LocalGit, path: string) {
  if (basename(path).endsWith('.lock')) return false;
  const checkout = segments(git.admin, path)?.[0];
  if (checkout === '' || (checkout && checkoutMetadata.has(checkout))) return true;
  const shared = segments(git.common, path);
  if (!shared) return false;
  const [entry, child, file] = shared;
  if (entry === '' || (entry && sharedMetadata.has(entry))) return true;
  if (entry === 'info') return !child || child === 'exclude';
  return entry === 'worktrees' && (!file || ['HEAD', 'gitdir', 'locked'].includes(file));
}

export async function streamGitChanges(
  git: LocalGit,
  response: ServerResponse,
  streams: Set<ServerResponse>,
  signal: AbortSignal,
) {
  // Use Git's ignores to skip existing generated directory trees without guessing their names.
  const ignored = new Set(
    (
      await git.text(
        ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
        { signal },
      )
    )
      .split('\0')
      .filter((path) => path.endsWith('/'))
      .map((path) => path.slice(0, -1).split('/').join(sep)),
  );
  signal.throwIfAborted();

  const options = { persistent: false, followSymlinks: false, ignoreInitial: true, atomic: false };
  const files = watch(git.root, {
    ...options,
    ignored: (path) => {
      const name = relative(git.root, path);
      return name.split(sep).includes('.git') || ignored.has(name);
    },
  });
  const metadata = watch([...new Set([git.common, git.admin])], {
    ...options,
    ignored: (path) => !metadataPath(git, path),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ready = 0;
  function send(frame: string) {
    if (response.destroyed || response.writableEnded) return;
    if (response.writableNeedDrain) response.destroy();
    else response.write(frame);
  }
  function changed() {
    timer ??= setTimeout(() => {
      timer = undefined;
      send('data: {}\n\n');
    }, 160);
  }
  function watchReady() {
    ready++;
    if (ready === 2) changed();
  }
  function restart(retry: number) {
    send(`retry: ${retry}\n\n`);
    response.end();
  }
  files.on('all', (_event, path) => {
    if (basename(path) === '.gitignore') restart(500);
    else changed();
  });
  metadata.on('all', (_event, path) => {
    if (path === git.common + sep + 'info' + sep + 'exclude') restart(500);
    else changed();
  });
  for (const watcher of [files, metadata]) {
    watcher.once('ready', watchReady);
    watcher.on('error', () => restart(10_000));
  }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  streams.add(response);
  const heartbeat = setInterval(() => send(': heartbeat\n\n'), 15_000);
  response.once('close', () => {
    clearInterval(heartbeat);
    clearTimeout(timer);
    streams.delete(response);
    void Promise.allSettled([files.close(), metadata.close()]);
  });
  send('retry: 2000\n: connected\n\n');
}

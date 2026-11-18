import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const data = resolve(process.env.ATELIER_DATA_DIR || join(root, '.data'));
const port = Number(process.env.ATELIER_PORT || '4317');
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('ATELIER_PORT must be a valid port.');
await mkdir(data, { recursive: true, mode: 0o700 });
const lockFile = join(data, 'server.lock');
async function lock(): Promise<void> {
  try {
    const file = await open(lockFile, 'wx', 0o600);
    await file.writeFile(String(process.pid));
    await file.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lockFile, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1)
      throw new Error('Invalid server.lock; inspect the data directory before starting.');
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
    }
    if (alive) throw new Error('This data directory is already in use by another atelier server.');
    await unlink(lockFile);
    await lock();
  }
}
await lock();
try {
  const app = await createApp({ root, data });
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`atelier ready: http://127.0.0.1:${port}`);
  console.log(`Private data: ${data}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('Stopping atelier and active SDK runs…');
    try {
      await app.close();
    } finally {
      await unlink(lockFile).catch(() => {});
    }
  };
  process.on('SIGINT', () => {
    void stop().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void stop().then(() => process.exit(0));
  });
} catch (error) {
  await unlink(lockFile).catch(() => {});
  throw error;
}

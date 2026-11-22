/**
 * @file 验证本机 Codex 模型发现的恢复和隔离。
 * @implementation 用无网络的 app-server 子进程替身覆盖分页、部分解析、进程失败、超时、缓存时限和身份切换。
 * @updated 2026-11-22T01:30:00+08:00
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCodexModelCatalog } from '../server/codex-model-catalog.js';

function appServer(handler: string) {
  return spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `import {createInterface} from 'node:readline';
     const reply = (id, result) => process.stdout.write(JSON.stringify({id, result}) + '\\n');
     createInterface({input:process.stdin}).on('line', (line) => {
       const message = JSON.parse(line);
       if (message.method === 'initialize') return reply(message.id, {});
       if (message.method !== 'model/list') return;
       ${handler}
     });`,
  ]);
}
const healthy = `reply(message.id, {data:[{model:'fixture-model', displayName:'Fixture', supportedReasoningEfforts:[{reasoningEffort:'high'}]}], nextCursor:null});`;

test('Codex discovery reads all pages, preserves valid rows and deduplicates model metadata', async () => {
  const load = createCodexModelCatalog({
    identity: async () => 'account-a',
    start: () =>
      appServer(`
        if (!message.params.cursor) {
          process.stdout.write(JSON.stringify({method:'notification', params:{}}) + '\\n');
          reply(message.id, {data:[
            {model:'shared', displayName:'Shared', supportedReasoningEfforts:[{reasoningEffort:'high'}, {reasoningEffort:'none'}]},
            {model:'hidden', displayName:'Hidden', hidden:true},
            {model:'invalid id', displayName:'Invalid'}
          ], nextCursor:'page-two'});
        } else if (message.params.cursor === 'page-two') {
          reply(message.id, {data:[{model:'shared'}, {model:'second', displayName:'Second'}], nextCursor:null});
        }
      `),
  });
  const result = await load({ source: 'gateway-a' });
  assert.deepEqual(result.discovery, {
    status: 'partial',
    reason: 'protocol',
    modelCount: 2,
    rejectedCount: 1,
  });
  assert.deepEqual(result.models, [
    { id: 'shared', displayName: 'Shared', supportedEfforts: ['high'], provider: 'chatgpt-plan' },
    { id: 'second', displayName: 'Second', provider: 'chatgpt-plan' },
  ]);
});

test('Codex discovery bounds repeated cursors and preserves completed pages on RPC failure', async () => {
  const looping = createCodexModelCatalog({
    identity: async () => 'account',
    start: () => appServer(`reply(message.id, {data:[{model:'first'}], nextCursor:'same'});`),
  });
  const result = await looping({ source: 'gateway' });
  assert.equal(result.discovery.status, 'partial');
  assert.equal(result.discovery.reason, 'pagination-limit');
  assert.deepEqual(
    result.models.map((entry) => entry.id),
    ['first'],
  );
  const brokenPage = createCodexModelCatalog({
    identity: async () => 'account',
    start: () =>
      appServer(`if (!message.params.cursor) reply(message.id, {data:[{model:'first'}],nextCursor:'second'});
        else process.stdout.write(JSON.stringify({id:message.id,error:{code:-1,message:'fixture'}})+'\\n');`),
  });
  const partial = await brokenPage({ source: 'gateway' });
  assert.equal(partial.discovery.status, 'partial');
  assert.equal(partial.discovery.reason, 'protocol');
  assert.deepEqual(
    partial.models.map((entry) => entry.id),
    ['first'],
  );
});

test('failed process has a short cooldown, deduplicates concurrent requests and then recovers', async () => {
  let clock = 1000;
  let starts = 0;
  const load = createCodexModelCatalog({
    identity: async () => 'account',
    now: () => clock,
    start() {
      starts++;
      return starts === 1 ? spawn(process.execPath, ['-e', 'process.exit(1)']) : appServer(healthy);
    },
  });
  const [first, same] = await Promise.all([
    load({ source: 'gateway' }),
    load({ source: 'gateway' }),
  ]);
  assert.deepEqual(first, same);
  assert.equal(first.discovery.status, 'unavailable');
  assert.equal(first.discovery.reason, 'process');
  assert.equal(starts, 1);
  await load({ source: 'gateway', refresh: true });
  assert.equal(starts, 1);
  clock += 2001;
  const recovered = await load({ source: 'gateway' });
  assert.equal(starts, 2);
  assert.equal(recovered.discovery.status, 'ready');
  assert.equal(recovered.models[0]?.id, 'fixture-model');
  await load({ source: 'gateway' });
  assert.equal(starts, 2);
  await load({ source: 'gateway', refresh: true });
  assert.equal(starts, 3);
});

test(
  'default discovery deadline allows the native five-second refresh fallback',
  { timeout: 15_000 },
  async () => {
    const load = createCodexModelCatalog({
      identity: async () => 'account',
      start: () => appServer(`setTimeout(() => { ${healthy} }, 5100);`),
    });
    const result = await load({ source: 'gateway' });
    assert.equal(result.discovery.status, 'ready');
    assert.equal(result.models[0]?.id, 'fixture-model');
  },
);

test('timeout is explicit, the child is terminated and a later attempt recovers', async () => {
  let clock = 1000;
  let hung = true;
  let closed: Promise<void> | undefined;
  const load = createCodexModelCatalog({
    identity: async () => 'account',
    timeoutMs: 300,
    now: () => clock,
    start() {
      const child = appServer(hung ? '' : healthy);
      closed = new Promise((resolve) => child.once('close', () => resolve()));
      return child;
    },
  });
  const failed = await load({ source: 'gateway' });
  assert.equal(failed.discovery.reason, 'timeout');
  assert.equal(failed.discovery.status, 'unavailable');
  await closed;
  hung = false;
  clock += 2001;
  assert.equal((await load({ source: 'gateway' })).discovery.status, 'ready');
});

test('stale success has a finite age and never crosses gateway or account identities', async () => {
  let clock = 0;
  let account = 'account-a';
  let failing = false;
  const load = createCodexModelCatalog({
    identity: async () => account,
    now: () => clock,
    start: () =>
      failing ? spawn(process.execPath, ['-e', 'process.exit(1)']) : appServer(healthy),
  });
  assert.equal((await load({ source: 'gateway-a' })).discovery.status, 'ready');
  failing = true;
  const stale = await load({ source: 'gateway-a', refresh: true });
  assert.equal(stale.discovery.status, 'stale');
  assert.equal(stale.discovery.reason, 'process');
  assert.equal(stale.models[0]?.id, 'fixture-model');
  const otherGateway = await load({ source: 'gateway-b' });
  assert.equal(otherGateway.discovery.status, 'unavailable');
  assert.deepEqual(otherGateway.models, []);
  account = 'account-b';
  assert.deepEqual((await load({ source: 'gateway-a' })).models, []);
  account = 'account-a';
  clock = 5 * 60_000 + 1;
  const expired = await load({ source: 'gateway-a' });
  assert.equal(expired.discovery.status, 'unavailable');
  assert.deepEqual(expired.models, []);
});

test('identity changes during discovery discard the in-flight result', async () => {
  let account = 'account-a';
  const load = createCodexModelCatalog({
    identity: async () => account,
    start() {
      queueMicrotask(() => {
        account = 'account-b';
      });
      return appServer(healthy);
    },
  });
  const result = await load({ source: 'gateway' });
  assert.equal(result.discovery.status, 'unavailable');
  assert.equal(result.discovery.reason, 'identity');
  assert.deepEqual(result.models, []);
});

test(
  'local auth, provider config and Shunt file revisions invalidate cached identities',
  { skip: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atelier-catalog-identity-'));
    const previousHome = process.env.CODEX_HOME;
    const previousAccounts = process.env.SHUNT_CHATGPT_PLAN_ACCOUNTS_DIR;
    const accounts = join(directory, 'accounts');
    await mkdir(accounts);
    const authPath = join(directory, 'auth.json');
    await writeFile(authPath, '{"fixture":1}', { mode: 0o600 });
    await writeFile(join(directory, 'config.toml'), 'model="fixture"');
    const accountPath = join(accounts, 'fixture.json');
    await writeFile(accountPath, '{"fixture":1}', { mode: 0o600 });
    process.env.CODEX_HOME = directory;
    process.env.SHUNT_CHATGPT_PLAN_ACCOUNTS_DIR = accounts;
    let starts = 0;
    const load = createCodexModelCatalog({
      start() {
        starts++;
        return appServer(healthy);
      },
    });
    try {
      await load({ source: 'gateway' });
      await load({ source: 'gateway' });
      assert.equal(starts, 1);
      await writeFile(authPath, '{"fixture":2,"revision":2}', { mode: 0o600 });
      await load({ source: 'gateway' });
      assert.equal(starts, 2);
      await writeFile(join(directory, 'config.toml'), 'model="other-fixture"');
      await load({ source: 'gateway' });
      assert.equal(starts, 3);
      await writeFile(accountPath, '{"fixture":2,"revision":2}', { mode: 0o600 });
      await load({ source: 'gateway' });
      assert.equal(starts, 4);
      await rm(authPath);
      await load({ source: 'gateway' });
      await load({ source: 'gateway' });
      assert.equal(starts, 6);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousAccounts === undefined) delete process.env.SHUNT_CHATGPT_PLAN_ACCOUNTS_DIR;
      else process.env.SHUNT_CHATGPT_PLAN_ACCOUNTS_DIR = previousAccounts;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('unknown identities do not reuse success and source cache is bounded', async () => {
  let starts = 0;
  const unknown = createCodexModelCatalog({
    identity: async () => undefined,
    start() {
      starts++;
      return appServer(healthy);
    },
  });
  await unknown({ source: 'gateway' });
  await unknown({ source: 'gateway' });
  assert.equal(starts, 2);
  const bounded = createCodexModelCatalog({
    identity: async () => 'account',
    start() {
      starts++;
      return appServer(healthy);
    },
  });
  for (let index = 0; index < 9; index++) await bounded({ source: `gateway-${index}` });
  const before = starts;
  await bounded({ source: 'gateway-0' });
  assert.equal(starts, before + 1);
});

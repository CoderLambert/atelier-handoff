import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runPackagePython } from '../server/skill-package-execution.js';

const supported =
  process.platform === 'linux' &&
  spawnSync(
    'bwrap',
    [
      '--unshare-all',
      '--ro-bind',
      '/usr',
      '/usr',
      '--ro-bind',
      '/lib',
      '/lib',
      '--ro-bind-try',
      '/lib64',
      '/lib64',
      '/usr/bin/python3',
      '-I',
      '-c',
      'pass',
    ],
    { timeout: 3000, stdio: 'ignore' },
  ).status === 0;
const sandboxTest = { skip: !supported && 'Linux bubblewrap/python3 isolation is unavailable' };

async function fixture(t: TestContext, source: string) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-package-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'package');
  const state = join(directory, 'state');
  const output = join(directory, 'output');
  await Promise.all([
    mkdir(join(root, 'scripts'), { recursive: true }),
    mkdir(state),
    mkdir(output),
  ]);
  await writeFile(join(root, 'scripts', 'entry.py'), source);
  return {
    root,
    state,
    output,
    script: 'scripts/entry.py',
    args: [] as string[],
    signal: new AbortController().signal,
  };
}

const httpFixture = String.raw`
import json, sys
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from urllib.error import HTTPError
base = sys.argv[sys.argv.index('--base-url') + 1]
opener = build_opener(ProxyHandler({}))
def request(method, path, body=None, headers=None):
    data = body.encode() if body is not None else None
    try:
        response = opener.open(Request(base + path, method=method, data=data, headers=headers or {}), timeout=5)
    except HTTPError as error:
        response = error
    with response:
        return {'status': response.status, 'body': response.read().decode()}
`;

function fakeFetch(t: TestContext, callback: typeof fetch) {
  return t.mock.method(globalThis, 'fetch', callback);
}

test(
  'packaged Python isolates mounts, environment, sibling imports and networking',
  sandboxTest,
  async (t) => {
    const options = await fixture(
      t,
      String.raw`
import json, os, socket, sys
from pathlib import Path
from sibling import value
Path('/state/persisted').write_text('state')
Path('/output/result.txt').write_text(value)
denied = []
for path in ['/skill/new', '/skill/scripts/sibling.py', '/tmp/new', '/new', '/usr/new']:
    try:
        Path(path).write_text('forbidden')
    except OSError:
        denied.append(path)
network = []
for address in [('1.1.1.1', 443), ('127.0.0.1', 17863)]:
    try:
        socket.create_connection(address, timeout=.1).close()
    except OSError:
        network.append(address)
print(json.dumps({'denied': denied, 'network': network, 'home': Path('/home').exists(),
                  'host': Path(sys.argv[1]).exists(), 'secret': os.environ.get('ATELIER_TEST_SECRET'),
                  'isolated': sys.flags.isolated, 'cwd': os.getcwd(), 'args': sys.argv[2:]}))
`,
    );
    await writeFile(join(options.root, 'scripts', 'sibling.py'), "value = 'bundled import'\n");
    const hostFile = join(options.state, '..', 'host-secret');
    await writeFile(hostFile, 'hidden');
    for (const [key, value] of [
      ['ATELIER_TEST_SECRET', 'must not leak'],
      ['PYTHONPATH', options.state],
    ]) {
      const previous = process.env[key!];
      process.env[key!] = value;
      t.after(() => {
        if (previous === undefined) delete process.env[key!];
        else process.env[key!] = previous;
      });
    }
    const result = await runPackagePython({
      ...options,
      args: [hostFile, 'spaces and $shell; text'],
    });
    assert.equal(result.code, 0, result.output);
    const value = JSON.parse(result.output);
    assert.equal(value.denied.length, 5);
    assert.equal(value.network.length, 2);
    assert.equal(value.home, false);
    assert.equal(value.host, false);
    assert.equal(value.secret, null);
    assert.equal(value.isolated, 1);
    assert.equal(value.cwd, '/skill');
    assert.deepEqual(value.args, ['spaces and $shell; text']);
    assert.equal(await readFile(join(options.state, 'persisted'), 'utf8'), 'state');
    assert.equal(await readFile(join(options.output, 'result.txt'), 'utf8'), 'bundled import');
    assert.deepEqual(await readdir(join(options.root, 'scripts')), ['entry.py', 'sibling.py']);
  },
);

test('runner rejects escaping scripts and overlapping writable mounts', sandboxTest, async (t) => {
  const options = await fixture(t, 'print("should not run")');
  await writeFile(join(options.state, 'outside.py'), 'print("outside")');
  await symlink(join(options.state, 'outside.py'), join(options.root, 'escape.py'));
  await assert.rejects(runPackagePython({ ...options, script: 'escape.py' }), {
    code: 'SKILL_PACKAGE_EXECUTION_INVALID',
  });
  await assert.rejects(runPackagePython({ ...options, state: options.root }), {
    code: 'SKILL_PACKAGE_EXECUTION_INVALID',
  });
  await assert.rejects(runPackagePython({ ...options, output: join(options.root, 'scripts') }), {
    code: 'SKILL_PACKAGE_EXECUTION_INVALID',
  });
});

test(
  'runner preserves exit code, caps output and stops forked descendants',
  sandboxTest,
  async (t) => {
    const output = await fixture(t, "import sys\nprint('x' * 100000)\nsys.exit(7)\n");
    const result = await runPackagePython(output);
    assert.equal(result.code, 7);
    assert.ok(Buffer.byteLength(result.output) < 66_000);
    assert.match(result.output, /64 KiB/);
    const sleeping = await fixture(
      t,
      String.raw`
import os, time
from pathlib import Path
if os.fork() == 0:
    os.setsid()
    while True:
        with Path('/state/ticks').open('a') as file:
            file.write('tick\n')
        time.sleep(.02)
Path('/output/ready').write_text('ready')
while True: time.sleep(1)
`,
    );
    const controller = new AbortController();
    const run = runPackagePython({ ...sleeping, signal: controller.signal });
    const rejected = assert.rejects(run, { code: 'RUN_STOPPED' });
    const deadline = Date.now() + 5000;
    while (!(await readdir(sleeping.output)).includes('ready')) {
      assert.ok(Date.now() < deadline, 'fixture must start');
      await new Promise((done) => setTimeout(done, 10));
    }
    controller.abort();
    await rejected;
    const ticks = await readFile(join(sleeping.state, 'ticks'), 'utf8');
    await new Promise((done) => setTimeout(done, 80));
    assert.equal(await readFile(join(sleeping.state, 'ticks'), 'utf8'), ticks);
  },
);

test(
  'search uses only fixed HTTPS routes and filters headers through its Unix broker',
  sandboxTest,
  async (t) => {
    const id = 'a'.repeat(32);
    const paths = [
      ['POST', '/api/v1/clients/register'],
      ['POST', '/api/v1/skills/multi-search-engine/activity/engage'],
      ['POST', '/api/v1/skills/multi-search-engine/quote'],
      ['POST', '/api/v1/skills/multi-search-engine/invoke'],
      ['GET', `/api/v1/multi-search/requests/request_123?quote_id=${id}`],
      ['GET', `/api/v1/multi-search/tasks/${id}`],
      ['GET', `/api/v1/multi-search/tasks/${id}/files/0`],
      ['GET', `/api/v1/multi-search/tasks/${id}/files/1`],
      ['GET', `/api/v1/multi-search/tasks/${id}/files/2`],
      ['POST', `/api/v1/multi-search/tasks/${id}/timing`],
    ];
    const options = await fixture(
      t,
      httpFixture +
        `\npaths = json.loads(${JSON.stringify(JSON.stringify(paths))})\n` +
        `print(json.dumps([request(method, path, '{}' if method == 'POST' else None, ` +
        `{'Authorization': 'Bearer fixture', 'X-Skill-Distribution': 'skillhub', 'Cookie': 'private', 'X-Forwarded-Host': 'evil.invalid'}) for method, path in paths]))\n`,
    );
    const calls: string[] = [];
    fakeFetch(t, async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://skill.zhaopintong.com');
      assert.equal(init?.redirect, 'manual');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer fixture');
      assert.equal(headers.get('x-skill-distribution'), 'skillhub');
      assert.equal(headers.has('cookie'), false);
      assert.equal(headers.has('host'), false);
      assert.equal(headers.has('x-forwarded-host'), false);
      calls.push(`${init?.method} ${url.pathname}${url.search}`);
      return Response.json({ fixture: true });
    });
    const result = await runPackagePython({ ...options, args: ['execute'], search: true });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(
      calls,
      paths.map(([method, path]) => `${method} ${path}`),
    );
    assert.ok(JSON.parse(result.output).every((item: { status: number }) => item.status === 200));
    assert.deepEqual(await readdir(options.state), []);
  },
);

test(
  'prepare and collect cannot invoke; malformed targets, methods and arbitrary URLs stay offline',
  sandboxTest,
  async (t) => {
    const id = 'a'.repeat(32);
    const denied = [
      ['POST', '/api/v1/skills/multi-search-engine/invoke'],
      ['GET', '/api/v1/clients/register'],
      ['DELETE', `/api/v1/multi-search/tasks/${id}`],
      ['GET', '/api/v1/other'],
      ['POST', '/api/v1/skills/another/quote'],
      ['POST', '/api/v1/skills/multi-search-engine/quote?url=https://evil.invalid'],
      ['GET', `/api/v1/multi-search/tasks/${id}/files/3`],
      ['GET', `/api/v1/multi-search/tasks/${id}?url=https://evil.invalid`],
      ['GET', `/api/v1/multi-search/tasks/${id}/../${id}`],
      ['GET', `/api/v1/multi-search/tasks/%61${id.slice(1)}`],
      ['GET', '//evil.invalid/api/v1/clients/register'],
    ];
    const options = await fixture(
      t,
      httpFixture +
        `\npaths = json.loads(${JSON.stringify(JSON.stringify(denied))})\n` +
        "print(json.dumps([request(method, path)['status'] for method, path in paths]))\n",
    );
    const fake = fakeFetch(t, async () => {
      throw new Error('Denied traffic must not reach upstream');
    });
    for (const stage of ['prepare', 'collect']) {
      const result = await runPackagePython({ ...options, args: [stage], search: true });
      assert.equal(result.code, 0, result.output);
      assert.deepEqual(
        JSON.parse(result.output),
        denied.map(() => 403),
      );
    }
    assert.equal(fake.mock.callCount(), 0);
    await assert.rejects(runPackagePython({ ...options, args: ['retry'], search: true }), {
      code: 'SKILL_PACKAGE_EXECUTION_INVALID',
    });
    await assert.rejects(
      runPackagePython({
        ...options,
        args: ['prepare', '--base-url=http://elsewhere'],
        search: true,
      }),
      { code: 'SKILL_PACKAGE_EXECUTION_INVALID' },
    );
  },
);

test(
  'broker refuses redirects and caps both buffered and streamed response/request bodies',
  sandboxTest,
  async (t) => {
    const options = await fixture(
      t,
      httpFixture +
        String.raw`
results = [request('POST', '/api/v1/skills/multi-search-engine/quote', '{}') for _ in range(3)]
results.append(request('POST', '/api/v1/skills/multi-search-engine/quote', 'x' * 65537))
print(json.dumps(results))
`,
    );
    let calls = 0;
    let cancelled = false;
    fakeFetch(t, async () => {
      calls++;
      if (calls === 1)
        return new Response(null, { status: 302, headers: { location: 'https://evil.invalid/' } });
      if (calls === 2) return new Response('tiny', { headers: { 'content-length': '2000001' } });
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(200_000));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    });
    const result = await runPackagePython({ ...options, args: ['prepare'], search: true });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(
      JSON.parse(result.output).map((item: { status: number }) => item.status),
      [502, 502, 502, 413],
    );
    assert.match(result.output, /BROKER_REDIRECT_DENIED/);
    assert.match(result.output, /BROKER_RESPONSE_TOO_LARGE/);
    assert.equal(calls, 3);
    assert.equal(cancelled, true);
  },
);

test(
  'broker rewrites only canonical checkout links and keeps identities stable across runs',
  sandboxTest,
  async (t) => {
    const options = await fixture(
      t,
      httpFixture +
        "\nprint(json.dumps({'base': base, 'result': request('POST', '/api/v1/skills/multi-search-engine/invoke', '{}')}))\n",
    );
    let checkout = 'https://skill.zhaopintong.com/checkout#fixture-token';
    fakeFetch(t, async () =>
      Response.json({ checkout_url: checkout, code: 'LOGIN_REQUIRED', other: [1, 2] }),
    );
    const first = await runPackagePython({ ...options, args: ['execute'], search: true });
    assert.equal(first.code, 0, first.output);
    const value = JSON.parse(first.output);
    assert.deepEqual(JSON.parse(value.result.body), {
      checkout_url: 'http://127.0.0.1:17863/checkout#fixture-token',
      code: 'LOGIN_REQUIRED',
      other: [1, 2],
    });
    for (checkout of [
      'https://evil.invalid/checkout#token',
      'https://skill.zhaopintong.com/checkout',
      'https://skill.zhaopintong.com/checkout#',
      'https://skill.zhaopintong.com/other#token',
      'https://skill.zhaopintong.com/checkout?next=elsewhere#token',
    ]) {
      const result = await runPackagePython({ ...options, args: ['execute'], search: true });
      assert.equal(result.code, 0, result.output);
      const next = JSON.parse(result.output);
      assert.equal(next.base, value.base);
      assert.equal(next.result.status, 502);
      assert.match(next.result.body, /BROKER_CHECKOUT_DENIED/);
    }
  },
);

test('stopping search aborts upstream work and removes its Unix socket', sandboxTest, async (t) => {
  const options = await fixture(
    t,
    httpFixture + "\nprint(request('POST', '/api/v1/skills/multi-search-engine/quote', '{}'))\n",
  );
  const before = new Set(
    (await readdir(tmpdir())).filter((name) => name.startsWith('atelier-skill-broker-')),
  );
  let started!: () => void;
  const ready = new Promise<void>((done) => (started = done));
  let upstreamAborted = false;
  fakeFetch(t, async (_input, init) => {
    started();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        upstreamAborted = true;
        reject(new Error('aborted'));
      });
    });
  });
  const controller = new AbortController();
  const run = runPackagePython({
    ...options,
    args: ['prepare'],
    search: true,
    signal: controller.signal,
  });
  const rejected = assert.rejects(run, { code: 'RUN_STOPPED' });
  await ready;
  controller.abort();
  await rejected;
  assert.equal(upstreamAborted, true);
  const after = (await readdir(tmpdir())).filter((name) =>
    name.startsWith('atelier-skill-broker-'),
  );
  assert.ok(after.every((name) => before.has(name)));
});

test('broker and whole-run deadlines abort pending upstream work', sandboxTest, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const options = await fixture(
    t,
    httpFixture +
      "\nprint(json.dumps(request('POST', '/api/v1/skills/multi-search-engine/quote', '{}')))\n",
  );
  let started!: () => void;
  let aborted = 0;
  fakeFetch(t, async (_input, init) => {
    started();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted++;
        reject(new Error('fixture deadline'));
      });
    });
  });
  for (const milliseconds of [30_000, 120_000]) {
    const ready = new Promise<void>((done) => (started = done));
    const run = runPackagePython({ ...options, args: ['prepare'], search: true });
    await Promise.race([
      ready,
      run.then((result) => {
        throw new Error('Fixture exited before making a request: ' + result.output);
      }),
    ]);
    t.mock.timers.tick(milliseconds);
    const result = await run;
    if (milliseconds === 30_000) {
      assert.equal(result.code, 0, result.output);
      assert.equal(JSON.parse(result.output).status, 504);
    } else {
      assert.equal(result.code, null);
      assert.match(result.output, /120 秒/);
    }
  }
  assert.equal(aborted, 2);
});

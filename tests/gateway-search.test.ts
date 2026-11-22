/**
 * @file 验证站点搜索网关请求及来源过滤。
 * @implementation 以本地合成响应覆盖域名授权、实际出处和服务不可用的场景。
 * @updated 2026-11-21T03:00:00+08:00
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { searchGateway } from '../server/gateway-search.js';

const searchRequest = { query: '今天新闻', domain: 'baidu.com' };

test('Shunt search uses the current model and keeps only structured citations from the requested site', async () => {
  const requests: unknown[] = [];
  let available = true;
  const fixture = createServer(async (req, res) => {
    const data: Buffer[] = [];
    for await (const chunk of req) data.push(Buffer.from(chunk));
    requests.push({ path: req.url, body: JSON.parse(Buffer.concat(data).toString()) });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        content: available
          ? [
              { type: 'server_tool_use', name: 'web_search' },
              { type: 'web_search_tool_result', content: [] },
              {
                type: 'text',
                text: 'https://baidu.com/unverified',
                citations: [
                  { url: 'https://baike.baidu.com/item/fixture', title: 'Fixture news' },
                  { url: 'https://baidu.com.other.test/path' },
                  { url: 'https://other.test/?site=baidu.com' },
                  { url: 'https://baidu.com@other.test/' },
                ],
              },
            ]
          : [{ type: 'text', text: 'No hosted search occurred.' }],
      }),
    );
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  try {
    const address = fixture.address();
    assert.ok(address && typeof address === 'object');
    const config = {
      gateway: `http://127.0.0.1:${address.port}`,
      model: 'fixture-model',
      maxTurns: 1,
      timeoutMs: 30_000,
    };
    const result = await searchGateway(config, searchRequest, AbortSignal.timeout(10_000));
    assert.deepEqual(result.sources, [
      { url: 'https://baike.baidu.com/item/fixture', title: 'Fixture news' },
    ]);
    const request = requests.at(0);
    assert.match(JSON.stringify(request), /"path":"\/v1\/messages"/);
    assert.match(JSON.stringify(request), /"model":"fixture-model"/);
    assert.match(JSON.stringify(request), /"allowed_domains":\["baidu.com"\]/);
    assert.match(JSON.stringify(request), /今天新闻/u);
    available = false;
    await assert.rejects(
      searchGateway(config, searchRequest, AbortSignal.timeout(10_000)),
      /没有返回网页搜索调用/u,
    );
  } finally {
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { previewSkillHub, searchSkillHub } from '../server/skillhub.js';

const coordinates = '@example/react';

test('SkillHub search preserves namespace and pins the listed version', async () => {
  const results = await searchSkillHub('react', async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.skillhub.cn');
    assert.equal(url.searchParams.get('q'), 'react');
    return Response.json({
      results: [
        { namespace: { canonicalName: coordinates }, displayName: 'React', version: '1.2.3' },
      ],
    });
  });
  assert.equal(results[0]?.source, `skillhub:${coordinates}@1.2.3`);
});

test('SkillHub download rejects redirects outside the approved package CDN', async () => {
  const paths: string[] = [];
  await assert.rejects(
    previewSkillHub(`skillhub:${coordinates}@1.2.3`, async (input, init) => {
      const url = new URL(String(input));
      assert.equal(init?.redirect, 'manual');
      paths.push(url.pathname);
      if (url.pathname.endsWith('/resolve')) {
        return Response.json({
          namespace: { canonicalName: coordinates, handle: 'example', publicSlug: 'react' },
          latestVersion: { version: '1.2.4' },
        });
      }
      assert.equal(url.searchParams.get('version'), '1.2.3');
      assert.equal(url.searchParams.get('namespace'), 'example');
      return new Response(null, {
        status: 302,
        headers: { location: 'https://example.org/skill.zip' },
      });
    }),
    { code: 'SKILLHUB_INVALID_RESPONSE' },
  );
  assert.deepEqual(paths, ['/api/v1/skills/resolve', '/api/v1/download']);
});

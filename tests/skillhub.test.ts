import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectMarkdown } from '../server/extensions.js';
import { normalizeSkillHubMarkdown, previewSkillHub, searchSkillHub } from '../server/skillhub.js';

const coordinates = '@example/react';

test('SkillHub search preserves namespace and pins the listed version', async () => {
  const results = await searchSkillHub('', async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.skillhub.cn');
    assert.equal(url.searchParams.get('q'), '');
    return Response.json({
      results: [
        {
          namespace: { canonicalName: coordinates },
          displayName: 'React',
          version: '1.2.3',
          category: 'dev-programming',
        },
      ],
    });
  });
  assert.equal(results[0]?.source, `skillhub:${coordinates}@1.2.3`);
  assert.equal(results[0]?.category, 'dev-programming');
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

test('SkillHub repairs plain description punctuation and keeps project tool policy', () => {
  const body =
    '---\nname: resume\ndescription_en: Use for writing: resumes and cover letters\nallowed-tools: [Read, Write]\ndisable-model-invocation: true\n---\n# Resume feedback\n';
  const normalized = normalizeSkillHubMarkdown(body);
  assert.equal(inspectMarkdown(normalized).supported, true);
  assert.equal(inspectMarkdown(normalized).modelInvocable, false);
  assert.equal(inspectMarkdown(normalized).text, '# Resume feedback');
  assert.doesNotMatch(normalized, /allowed-tools/);
  const withHook = body.replace('allowed-tools:', 'hooks: {}\nallowed-tools:');
  assert.equal(inspectMarkdown(normalizeSkillHubMarkdown(withHook)).supported, false);
  const duplicate = body.replace('name: resume', 'name: resume\nname: other');
  assert.equal(normalizeSkillHubMarkdown(duplicate), duplicate);
});

test('SkillHub repairs quoted descriptions and literal shell punctuation without enabling commands', () => {
  const body = [
    '---',
    'name: browser-fixture',
    'description: "Use when asked to "open a website" or "read a page"."',
    '---',
    'Watch for `!` characters in shell examples.',
  ].join('\n');
  const pkg = { digest: '', files: [] };
  const repaired = inspectMarkdown(normalizeSkillHubMarkdown(body), pkg);
  assert.equal(repaired.supported, true);
  assert.equal(repaired.description, 'Use when asked to "open a website" or "read a page".');
  assert.equal(repaired.text, 'Watch for &#33; characters in shell examples.');
  assert.equal(
    inspectMarkdown(normalizeSkillHubMarkdown(body + '\nRun !`echo test`.'), pkg).supported,
    false,
  );
  const malformed = body.replace('name: browser-fixture', 'name: "browser" unexpected');
  assert.equal(normalizeSkillHubMarkdown(malformed), malformed);
});

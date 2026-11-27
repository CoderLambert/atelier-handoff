/**
 * @file 验证 @ 文件候选的选中项和编辑器光标。
 * @implementation 用宿主键盘分派和隔离查询缓存检查候选导航、光标恢复、外部正文同步与输入节点替换。
 * @updated 2026-11-27T18:34:46+08:00
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const browserPath = [
  process.env.ATELIER_TEST_CHROMIUM,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));

test(
  'file completion exposes its active option and restores the textarea caret',
  {
    skip: !browserPath,
    timeout: 30_000,
  },
  async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const result = await build({
      absWorkingDir: root,
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
        import React, { useRef, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { ExtensionPicker } from '@/features/extensions/picker';
        import { extensionPickerKeys } from '@/features/extensions/api';
        import { useComposerKeymap } from '@/features/chat/use-composer-keymap';
        import { projectKeys } from '@/use-query/projects/keys';

        const projectId = 'project';
        const sessionId = 'session';
        const skillScope = { type: 'session', projectId, sessionId, mode: 'controlled' };
        const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
        client.setQueryData(extensionPickerKeys.list(projectId), []);
        client.setQueryData(projectKeys.searchFiles(projectId, '', sessionId), { items: [
          { path: 'README.md', isDirectory: false, size: 12 },
          { path: 'src', isDirectory: true, size: 0 },
        ] });
        client.setQueryData(projectKeys.searchFiles(projectId, 'src/', sessionId), { items: [
          { path: 'src/index.ts', isDirectory: false, size: 12 },
        ] });

        function App() {
          const [input, setInput] = useState(null);
          const [version, setVersion] = useState(0);
          const [submissions, setSubmissions] = useState([]);
          const pickerKeyHandlerRef = useRef(null);
          const [draft, setDraft] = useState({ text: '', mode: 'edit', executionPreference: 'native-v1',
            contextPaths: [], attachmentIds: [] });
          const keymap = useComposerKeymap({
            insertRunId: 'run',
            consumeCompletion: (event) => pickerKeyHandlerRef.current?.handleKeyDown(event) ?? false,
            onSubmit: (id) => setSubmissions((previous) => [...previous, id ?? 'send']),
          });
          window.fixture = {
            replaceInput: () => setVersion((previous) => previous + 1),
            setText: (text) => setDraft((previous) => ({ ...previous, text })),
          };
          return <>
            <textarea key={version} ref={setInput} aria-label="Composer" value={draft.text}
              onKeyDown={keymap.onKeyDown} onCompositionStart={keymap.onCompositionStart}
              onCompositionEnd={keymap.onCompositionEnd}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
            <ExtensionPicker projectId={projectId} sessionId={sessionId} skillScope={skillScope}
              sessionSkillIds={new Set()} draft={draft} selectionMode="readonly"
              onChange={(patch) => setDraft((previous) => ({ ...previous, ...patch }))}
              input={input} composing={keymap.composing} keyHandlerRef={pickerKeyHandlerRef} />
            <output id="draft">{JSON.stringify(draft)}</output>
            <output id="submissions">{JSON.stringify(submissions)}</output>
          </>;
        }

        createRoot(document.getElementById('app')).render(
          <QueryClientProvider client={client}><App /></QueryClientProvider>
        );
      `,
      },
      tsconfig: `${root}/tsconfig.json`,
      bundle: true,
      write: false,
      format: 'iife',
      loader: { '.css': 'empty' },
    });
    const bundle = result.outputFiles[0]?.text;
    assert.ok(bundle);
    const browser = await chromium.launch({ executablePath: browserPath, headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="app"></div>');
      await page.addScriptTag({ content: bundle });
      const input = page.getByRole('textbox', { name: 'Composer' });
      await input.fill('@');

      async function assertActiveOption(name: string) {
        const option = page.getByRole('option', { name: new RegExp(name) });
        await option.waitFor();
        assert.equal(await option.getAttribute('aria-selected'), 'true');
        assert.equal(
          await input.getAttribute('aria-activedescendant'),
          await option.getAttribute('id'),
        );
      }

      await assertActiveOption('README');
      await input.press('ArrowDown');
      await assertActiveOption('src/');
      await input.press('Enter');
      await assertActiveOption('index');
      assert.equal(await input.inputValue(), '@src/');
      assert.equal(await page.locator('#submissions').textContent(), '[]');
      await page.getByRole('option', { name: /index/ }).click();
      await page.waitForFunction(() => {
        const input = document.querySelector('textarea');
        return (
          input?.value === '@src/index.ts ' &&
          input === document.activeElement &&
          input.selectionStart === input.value.length &&
          input.selectionEnd === input.selectionStart &&
          !input.hasAttribute('aria-activedescendant')
        );
      });
      assert.match(
        (await page.locator('#draft').textContent()) ?? '',
        /"executionPreference":"native-v1"/,
      );

      await page.evaluate("window.fixture.setText('@')");
      await assertActiveOption('README');
      await input.press('ArrowUp');
      await assertActiveOption('src/');
      await input.press('Escape');
      await page.getByRole('listbox').waitFor({ state: 'hidden' });
      await input.press('Enter');
      assert.equal(await page.locator('#submissions').textContent(), '["send"]');

      const previous = await input.elementHandle();
      assert.ok(previous);
      await page.evaluate('window.fixture.replaceInput()');
      await page.waitForFunction((element) => !element.isConnected, previous);
      assert.equal(await previous.getAttribute('aria-autocomplete'), null);
      await input.focus();
      await input.press('End');
      await assertActiveOption('README');
      await input.press('Control+Enter');
      assert.equal(await page.locator('#submissions').textContent(), '["send","run"]');
      await input.press('Tab');
      assert.equal(await input.inputValue(), '@README.md ');
      assert.equal(await page.locator('#submissions').textContent(), '["send","run"]');
    } finally {
      await browser.close();
    }
  },
);

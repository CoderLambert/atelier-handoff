/* Classic-script integration: create once, then call renderPage / renderComposer on updates.
 * api(path, { method, body }) resolves parsed JSON and rejects unsuccessful requests.
 * MCP tests use persisted status/statusMessage/tools when supplied by the API, with
 * fresh local test results taking precedence. A listed tool alone is not a passing test.
 */
(() => {
  'use strict';

  let instanceSequence = 0;
  const kinds = { skill: 'Skills', command: 'Commands', mcp: 'MCP' };
  const marks = { skill: '✳', command: '/', mcp: '#' };
  const testLabels = { connected: '已连接', 'needs-auth': '需要认证', failed: '连接失败' };
  const encode = encodeURIComponent;
  const transportKey = (item) => {
    const transport = item.transport;
    if (transport?.type === 'http')
      return JSON.stringify(['http', transport.url, transport.tokenEnv || '']);
    if (transport?.type === 'stdio')
      return JSON.stringify([
        'stdio',
        transport.command,
        transport.args || [],
        [...(transport.envNames || [])].sort(),
      ]);
    return 'null';
  };
  const itemKey = (pid, id) => JSON.stringify([pid, id]);
  const messageOf = (error) => error?.message || '操作失败，请重试。';
  const marketLabels = {
    available: '可安装',
    enabled: '已启用',
    disabled: '已停用',
    legacy: '旧版待迁移',
    'update-available': '有审核更新',
    'local-modified': '本地已修改',
    conflict: '同名冲突',
  };
  const allowsAuto = (item) => item?.modelInvocable !== false;
  const autoEnabled = (item) => allowsAuto(item) && item?.autoInvoke !== false;
  const needsMarketReview = (skill) =>
    skill.legacy ||
    skill.localModified ||
    skill.updateAvailable ||
    ['legacy', 'update-available', 'local-modified'].includes(skill.status);

  window.createExtensionUI = function createExtensionUI({
    api,
    project,
    projects,
    draft,
    saveDraft,
    notify,
    escape: escapeHTML,
    openDialog,
    closeDialog,
  }) {
    const prefix = `atelier-ext-${++instanceSequence}`;
    const esc = (value) => escapeHTML(String(value ?? ''));
    const caches = new Map();
    const markets = new Map();
    const tests = new Map();
    const pending = new Set();
    const operationErrors = new Map();
    const composerBindings = new WeakMap();
    const chipsBindings = new WeakSet();
    const pageBindings = new WeakSet();
    const page = {
      container: null,
      root: null,
      pid: '',
      pinned: false,
      kind: 'skill',
      query: '',
      filter: 'all',
    };
    let composer = null;
    let dialogContext = null;
    let dialogSequence = 0;
    let previewRenderer;

    // This is an independent renderer so preview fences never inherit app data-action controls.
    if (typeof window.markdownit === 'function') {
      previewRenderer = window.markdownit({ html: false, linkify: false });
      previewRenderer.renderer.rules.image = (tokens, index) =>
        esc(tokens[index].content || '图片');
      previewRenderer.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
        tokens[index].attrSet('target', '_blank');
        tokens[index].attrSet('rel', 'noopener noreferrer');
        return renderer.renderToken(tokens, index, options);
      };
    }

    function cache(pid) {
      if (!caches.has(pid))
        caches.set(pid, { items: null, error: '', loading: false, promise: null });
      return caches.get(pid);
    }

    function endpoint(pid, id) {
      const base = `/api/projects/${encode(pid)}/extensions`;
      return id == null ? base : `${base}/${encode(id)}`;
    }

    function allProjects() {
      const list = [...(projects() || [])];
      const current = project();
      if (current && !list.some((item) => item.id === current.id)) list.unshift(current);
      return list;
    }

    function connection(pid, item) {
      const result = tests.get(itemKey(pid, item.id));
      if (result?.transport === transportKey(item) && result.version === item.version)
        return result;
      if (Object.hasOwn(testLabels, item.status)) {
        return {
          status: item.status,
          message: item.statusMessage || '',
          tools: item.tools || [],
          transport: transportKey(item),
          version: item.version,
        };
      }
      return null;
    }

    function discoveredTools(pid, item) {
      return connection(pid, item)?.tools || item.tools || [];
    }

    function allowedTools(pid, item) {
      const result = connection(pid, item);
      if (!item.enabled || item.supported === false || result?.status !== 'connected') return [];
      const discovered = new Set(result.tools.map((tool) => tool.name));
      return (item.allowedTools || []).filter(
        (tool) =>
          discovered.has(tool.name) && (draft()?.mode !== 'readonly' || tool.access === 'read'),
      );
    }

    function refreshSurfaces() {
      if (page.root?.isConnected) drawPage();
      if (composer?.input.isConnected) updateComposer(composer);
    }

    function load(pid, force = false) {
      if (!pid) return Promise.resolve();
      const entry = cache(pid);
      if (entry.promise) return force ? entry.promise.then(() => load(pid, true)) : entry.promise;
      if (!force && (entry.items !== null || entry.error)) return Promise.resolve();
      entry.loading = true;
      entry.error = '';
      entry.promise = Promise.resolve()
        .then(() => api(endpoint(pid)))
        .then((result) => {
          if (!Array.isArray(result?.items)) throw new Error('扩展列表响应缺少 items。');
          entry.items = result.items;
        })
        .catch((error) => {
          entry.error = messageOf(error);
        })
        .finally(() => {
          entry.loading = false;
          entry.promise = null;
          refreshSurfaces();
        });
      refreshSurfaces();
      return entry.promise;
    }

    function returnedItem(result) {
      return result?.item || result?.extension || (result?.id ? result : null);
    }

    function rememberItem(pid, item) {
      if (!item?.id) return;
      const entry = cache(pid);
      const list = entry.items || [];
      const index = list.findIndex((value) => value.id === item.id);
      entry.items =
        index < 0 ? [...list, item] : list.map((value) => (value.id === item.id ? item : value));
    }

    function button(action, label, extra = '', className = '') {
      return `<button type="button" class="ext-button ${className}" data-ext-action="${action}" ${extra}>${label}</button>`;
    }

    function statusHTML(pid, item) {
      const result = connection(pid, item);
      const status = result?.status;
      return `<span class="ext-status" data-ext-status="${esc(status || 'untested')}"><span aria-hidden="true"></span>${esc(status ? testLabels[status] : '未测试')}</span>`;
    }

    function focusSnapshot(root) {
      const active = document.activeElement;
      if (!root.contains(active)) return null;
      const key = active.dataset.extFocus;
      if (!key) return null;
      return { key, start: active.selectionStart, end: active.selectionEnd };
    }

    function restoreFocus(root, saved) {
      if (!saved) return;
      const target = [...root.querySelectorAll('[data-ext-focus]')].find(
        (el) => el.dataset.extFocus === saved.key,
      );
      if (!target || target.disabled) return;
      target.focus({ preventScroll: true });
      if (typeof saved.start === 'number' && target.setSelectionRange) {
        target.setSelectionRange(saved.start, saved.end);
      }
    }

    function renderPage(container) {
      const list = allProjects();
      if (!page.pinned || !list.some((item) => item.id === page.pid)) {
        page.pid = project()?.id || list[0]?.id || '';
        page.pinned = false;
      }
      page.container = container;
      let root = container.querySelector(`[data-ext-page="${prefix}"]`);
      if (!root) {
        container.innerHTML = `<section class="ext-page" data-ext-page="${prefix}" aria-label="项目扩展">
          <header class="ext-heading"><div><h1>项目扩展</h1></div>
            <label class="ext-project-label">当前项目<select data-ext-field="project" data-ext-focus="project" aria-label="选择扩展所属项目"></select></label></header>
          <div class="ext-tabs" role="tablist" aria-label="扩展类型"></div>
          <div class="ext-toolbar"><label class="ext-search"><span aria-hidden="true">⌕</span><input type="search" data-ext-field="search" data-ext-focus="search" placeholder="搜索名称或描述" aria-label="搜索扩展"></label>
            <label class="ext-filter">状态<select data-ext-field="filter" data-ext-focus="filter"><option value="all">全部</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select></label>
            <div class="ext-toolbar-actions">${button('market', 'Skill 市场', 'data-ext-focus="market"', 'ext-button-primary')}${button('public-import', '从公开来源导入', 'data-ext-focus="public-import"')}${button('import', '导入 Markdown', 'data-ext-focus="import"')}${button('create', '+ 新建', 'data-ext-focus="create"')}</div></div>
          <p class="ext-scope-note"></p><div class="ext-page-message" role="status" aria-live="polite"></div>
          <section class="ext-results" role="tabpanel" id="${prefix}-results" tabindex="0"></section>
        </section>`;
        root = container.firstElementChild;
      }
      page.root = root;
      if (!pageBindings.has(root)) {
        pageBindings.add(root);
        root.addEventListener('click', onPageClick);
        root.addEventListener('input', (event) => {
          if (event.target.dataset.extField === 'search') {
            page.query = event.target.value;
            drawResults();
          }
        });
        root.addEventListener('change', (event) => {
          const field = event.target.dataset.extField;
          if (field === 'project') {
            page.pid = event.target.value;
            page.pinned = true;
            page.query = '';
            root.querySelector('[data-ext-field="search"]').value = '';
            drawPage();
            load(page.pid);
          } else if (field === 'filter') {
            page.filter = event.target.value;
            drawResults();
          }
        });
        root.addEventListener('keydown', (event) => {
          const tab = event.target.closest('[data-ext-action="tab"]');
          if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          const keys = Object.keys(kinds);
          const index = keys.indexOf(page.kind);
          page.kind =
            keys[
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? keys.length - 1
                  : (index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length
            ];
          drawPage();
          root.querySelector(`[data-ext-kind="${page.kind}"]`).focus();
        });
      }
      drawPage();
      load(page.pid);
    }

    function drawPage() {
      const root = page.root;
      if (!root?.isConnected) return;
      const list = allProjects();
      const selector = root.querySelector('[data-ext-field="project"]');
      const options =
        list
          .map(
            (item) =>
              `<option value="${esc(item.id)}">${esc(item.name || item.path || item.id)}</option>`,
          )
          .join('') || '<option value="">暂无项目</option>';
      if (selector.innerHTML !== options) selector.innerHTML = options;
      selector.value = page.pid;
      const entry = cache(page.pid);
      const tabs = root.querySelector('.ext-tabs');
      const saved = focusSnapshot(tabs);
      tabs.innerHTML = Object.entries(kinds)
        .map(
          ([kind, name]) =>
            `<button type="button" role="tab" id="${prefix}-${kind}-tab" aria-controls="${prefix}-results" aria-selected="${page.kind === kind}" tabindex="${page.kind === kind ? 0 : -1}" data-ext-action="tab" data-ext-kind="${kind}" data-ext-focus="tab-${kind}"><span class="ext-tab-mark" aria-hidden="true">${marks[kind]}</span>${name}<span class="ext-count">${entry.items?.filter((item) => item.kind === kind).length ?? '—'}</span></button>`,
        )
        .join('');
      restoreFocus(tabs, saved);
      const search = root.querySelector('[data-ext-field="search"]');
      if (document.activeElement !== search) search.value = page.query;
      root.querySelector('[data-ext-field="filter"]').value = page.filter;
      const market = root.querySelector('[data-ext-action="market"]');
      market.hidden = page.kind !== 'skill';
      market.disabled = !page.pid;
      const importButton = root.querySelector('[data-ext-action="import"]');
      importButton.hidden = page.kind === 'mcp';
      importButton.disabled = !page.pid;
      root.querySelector('[data-ext-action="public-import"]').disabled = !page.pid;
      const create = root.querySelector('[data-ext-action="create"]');
      create.disabled = !page.pid || entry.loading;
      create.textContent = `+ ${page.kind === 'mcp' ? '添加 MCP' : `新建 ${kinds[page.kind]}`}`;
      root.querySelector('.ext-scope-note').textContent =
        page.kind === 'mcp'
          ? '只在当前项目生效。连接测试通过后，可在会话中输入 # 选择已允许的工具。'
          : page.kind === 'skill'
            ? '只在当前项目生效。允许自动调用的 Skill 可由模型按需使用；输入 / 可手动选择支持的 Skill。'
            : '只在当前项目生效。在会话中输入 /，选择命令。';
      drawResults();
    }

    function drawResults() {
      if (!page.root?.isConnected) return;
      const entry = cache(page.pid);
      const results = page.root.querySelector('.ext-results');
      const saved = focusSnapshot(results);
      const scrollTop = page.container.scrollTop;
      results.setAttribute('aria-labelledby', `${prefix}-${page.kind}-tab`);
      results.setAttribute('aria-busy', String(entry.loading));
      const message = page.root.querySelector('.ext-page-message');
      message.innerHTML = entry.error
        ? `<div class="ext-error" role="alert">${esc(entry.error)} ${button('reload', '重新加载')}</div>`
        : '';
      const query = page.query.trim().toLocaleLowerCase();
      const visible = (entry.items || []).filter(
        (item) =>
          item.kind === page.kind &&
          (page.filter === 'all' || Boolean(item.enabled) === (page.filter === 'enabled')) &&
          `${item.name} ${item.description || ''} ${item.source || ''}`
            .toLocaleLowerCase()
            .includes(query),
      );
      if (!page.pid) {
        results.innerHTML =
          '<div class="ext-empty"><span aria-hidden="true">+</span><h2>先绑定一个项目</h2><p>项目绑定后，就可以在这里管理专属扩展。</p></div>';
      } else if (entry.loading && !entry.items) {
        results.innerHTML = '<p class="ext-loading" role="status">正在读取项目扩展…</p>';
      } else if (entry.error && !entry.items) {
        results.innerHTML = '';
      } else if (!visible.length) {
        results.innerHTML = `<div class="ext-empty"><span aria-hidden="true">${marks[page.kind]}</span><h2>${query || page.filter !== 'all' ? '没有符合条件的扩展' : `还没有 ${kinds[page.kind]}`}</h2><p>${query || page.filter !== 'all' ? '试试其他关键词或状态。' : page.kind === 'mcp' ? '连接一个工具服务，再选择这个项目可以使用的工具。' : '创建一份常用指令，或导入已有的 Markdown 文件。'}</p></div>`;
      } else {
        results.innerHTML = `<div class="ext-card-grid">${visible.map((item) => cardHTML(page.pid, item)).join('')}</div>`;
      }
      restoreFocus(results, saved);
      page.container.scrollTop = scrollTop;
    }

    function cardHTML(pid, item) {
      const key = itemKey(pid, item.id);
      const busy = pending.has(key);
      const attrs = `data-ext-id="${esc(item.id)}"`;
      const invocable = item.kind === 'skill' && item.userInvocable === false;
      const result = connection(pid, item);
      return `<article class="ext-card ${item.enabled ? '' : 'ext-card-disabled'}">
        <div class="ext-card-top"><span class="ext-kind-mark" aria-hidden="true">${marks[item.kind]}</span><span class="ext-card-kind">${kinds[item.kind]}</span>
          <button type="button" class="ext-switch" role="switch" aria-checked="${Boolean(item.enabled)}" aria-label="${item.enabled ? '停用' : '启用'} ${esc(item.name)}" data-ext-action="toggle" ${attrs} data-ext-focus="toggle-${esc(item.id)}" ${busy ? 'disabled' : ''}><span></span></button></div>
        <button type="button" class="ext-card-title" data-ext-action="edit" ${attrs} data-ext-focus="edit-${esc(item.id)}">${item.kind === 'command' ? '<span class="ext-name-prefix">/</span>' : ''}${esc(item.name)}</button>
        <p class="ext-card-description">${esc(item.description || '暂无描述')}</p>
        <div class="ext-card-meta"><span class="ext-state-dot ${item.enabled ? 'ext-is-enabled' : ''}">${item.enabled ? '已启用' : '已停用'}</span>${item.kind === 'mcp' ? statusHTML(pid, item) : `<span>${invocable ? '不支持手动调用' : '可手动调用'}</span>`}<span class="ext-version">v${esc(item.version)}</span></div>
        ${item.supported === false || item.compatibility ? `<p class="ext-compatibility">${esc(item.compatibility || '当前运行环境暂不支持此扩展')}</p>` : ''}
        ${item.kind === 'mcp' ? `<p class="ext-card-source">${esc(item.transport?.type === 'stdio' ? item.transport.command : item.transport?.url || '未配置连接')}<span>${(item.allowedTools || []).length} 个允许的工具</span></p>` : `<p class="ext-card-source">${esc(item.source || '项目内创建')}</p>`}
        ${item.kind === 'skill' ? `<div class="ext-auto-setting"><span>允许自动调用</span><button type="button" class="ext-switch" role="switch" aria-checked="${autoEnabled(item)}" aria-label="${esc(item.name)} 允许自动调用" data-ext-action="toggle-auto" ${attrs} data-ext-focus="auto-${esc(item.id)}" ${busy || !allowsAuto(item) || item.supported === false ? 'disabled' : ''}><span></span></button><small>${!allowsAuto(item) ? '上游禁止模型调用，仅可按手动调用声明使用。' : item.supported === false ? '当前不兼容，暂不能自动调用。' : !item.enabled ? '启用此扩展后生效。' : autoEnabled(item) ? '模型可按需加载，下一轮对话生效。' : '已关闭自动调用。'}</small></div>` : ''}
        ${item.marketId ? `<p class="ext-card-source">市场 · ${esc(item.marketId)}${item.marketRevision ? `<span title="${esc(item.marketRevision)}">目录 ${esc(item.marketRevision.slice(0, 12))}</span>` : ''}</p>` : ''}
        ${item.origin?.location ? `<p class="ext-card-source">${sourceLink(item.origin.location, '公开来源')}<span title="${esc(item.origin.revision)}">${esc(item.origin.revision?.slice(0, 12) || '')}</span></p>` : ''}
        ${result?.message ? `<p class="ext-test-message" data-ext-status="${esc(result.status)}">${esc(result.message)}</p>` : ''}
        ${operationErrors.has(key) ? `<p class="ext-error" role="alert">${esc(operationErrors.get(key))}</p>` : ''}
        <footer class="ext-card-actions">${button('edit', '查看与编辑', `${attrs} data-ext-focus="detail-${esc(item.id)}"`)}${item.origin || item.marketId || item.kind === 'skill' ? button('public-sync', '检查更新', `${attrs} ${busy ? 'disabled' : ''}`) : ''}${item.kind === 'mcp' ? button('test', '测试连接', `${attrs} data-ext-focus="test-${esc(item.id)}" ${busy ? 'disabled' : ''}`) : ''}${button('delete', '删除', `${attrs} data-ext-focus="delete-${esc(item.id)}" ${busy ? 'disabled' : ''}`, 'ext-button-danger')}</footer>
      </article>`;
    }

    function onPageClick(event) {
      const target = event.target.closest('[data-ext-action]');
      if (!target || !page.root.contains(target)) return;
      event.stopPropagation();
      const action = target.dataset.extAction;
      const pid = page.pid;
      const item = cache(pid).items?.find((value) => value.id === target.dataset.extId);
      if (action === 'tab') {
        page.kind = target.dataset.extKind;
        drawPage();
      } else if (action === 'reload') {
        load(pid, true);
        drawPage();
      } else if (action === 'market') {
        openMarket(pid);
      } else if (action === 'public-import' || (action === 'public-sync' && item)) {
        openPublicImport(pid, page.kind, action === 'public-sync' ? item : null);
      } else if (action === 'create' || action === 'import') {
        const context = openEditor(pid, null, page.kind);
        if (action === 'import') context.root.querySelector('[name="markdownFile"]').click();
      } else if (item && action === 'edit') {
        openEditor(pid, item);
      } else if (item && action === 'test') {
        const context = openEditor(pid, item);
        testConnection(context);
      } else if (item && (action === 'toggle' || action === 'toggle-auto')) {
        toggleItem(pid, item, action === 'toggle-auto' ? 'autoInvoke' : 'enabled');
      } else if (item && action === 'delete') {
        confirmDelete(pid, item);
      }
    }

    async function toggleItem(pid, item, field = 'enabled') {
      const key = itemKey(pid, item.id);
      if (pending.has(key)) return;
      if (
        field === 'autoInvoke' &&
        (item.kind !== 'skill' || !allowsAuto(item) || item.supported === false)
      )
        return;
      const enabled = field === 'autoInvoke' ? autoEnabled(item) : item.enabled;
      pending.add(key);
      operationErrors.delete(key);
      refreshSurfaces();
      try {
        const result = await api(endpoint(pid, item.id), {
          method: 'PATCH',
          body: { version: item.version, [field]: !enabled },
        });
        rememberItem(pid, returnedItem(result));
        await load(pid, true);
        notify(
          field === 'autoInvoke'
            ? enabled
              ? '已关闭自动调用'
              : '已允许自动调用，下一轮对话生效'
            : enabled
              ? '扩展已停用'
              : '扩展已启用',
        );
      } catch (error) {
        operationErrors.set(key, messageOf(error));
        if (error.status === 409) await load(pid, true);
        notify(messageOf(error));
      } finally {
        pending.delete(key);
        refreshSurfaces();
      }
    }

    function showDialog(title, html, wide = true) {
      const id = `${prefix}-dialog-${++dialogSequence}`;
      openDialog(title, `<div class="ext-dialog" id="${id}">${html}</div>`, wide);
      const root = document.getElementById(id);
      const context = { root, busy: false };
      dialogContext = context;
      // Local delegation also shields controls nested inside a host data-action ancestor.
      root.addEventListener('click', (event) => {
        if (event.target.closest('[data-ext-action]')) event.stopPropagation();
      });
      return context;
    }

    function live(context) {
      const dialog = context.root.closest('dialog');
      return dialogContext === context && context.root.isConnected && (!dialog || dialog.open);
    }

    function closeOwnDialog(context) {
      if (!live(context)) return;
      dialogContext = null;
      closeDialog();
    }

    function sourceLink(url, label) {
      try {
        const parsed = new URL(url);
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
          return esc(label);
        return `<a href="${esc(parsed.href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
      } catch {
        return esc(label);
      }
    }

    function marketSourceHTML(skill) {
      const repository = skill.repository || '';
      const repositoryURL = /^[\w.-]+\/[\w.-]+$/.test(repository)
        ? `https://github.com/${repository}`
        : repository;
      return `<details class="ext-preview ext-source-details"><summary>来源与版本</summary><dl class="ext-source-list">
        <div><dt>发布者</dt><dd>${esc(skill.publisher)}</dd></div>
        <div><dt>仓库</dt><dd>${sourceLink(repositoryURL, repository || '未提供')}</dd></div>
        <div><dt>文件</dt><dd>${sourceLink(skill.url, skill.path || '查看固定来源')}</dd></div>
        <div><dt>上游名称</dt><dd>${esc(skill.upstreamName || skill.name)}</dd></div>
        <div><dt>Commit</dt><dd>${esc(skill.commit || '未提供')}</dd></div>
        <div><dt>SHA-256</dt><dd>${esc(skill.sha256 || '未提供')}</dd></div>
        <div><dt>目录修订</dt><dd>${esc(skill.revision || '未提供')}</dd></div>
        ${skill.installedVersion != null ? `<div><dt>项目版本</dt><dd>v${esc(skill.installedVersion)}</dd></div>` : ''}
        ${skill.installedRevision ? `<div><dt>已装修订</dt><dd>${esc(skill.installedRevision)}</dd></div>` : ''}
        <div><dt>许可证</dt><dd>${sourceLink(skill.license?.url, skill.license?.name || '未提供')}</dd></div>
      </dl></details>`;
    }

    function marketStatusHTML(skill) {
      const labels = new Set([marketLabels[skill.status] || '状态未知']);
      if (skill.legacy) labels.add(marketLabels.legacy);
      if (skill.updateAvailable) labels.add(marketLabels['update-available']);
      if (skill.localModified) labels.add(marketLabels['local-modified']);
      if (typeof skill.enabled === 'boolean') labels.add(skill.enabled ? '已启用' : '已停用');
      return `<div class="ext-market-status" data-ext-market-status="${esc(skill.status)}">${[...labels].map((label) => `<span>${esc(label)}</span>`).join('')}</div>`;
    }

    function capabilitiesHTML(skill) {
      return skill.capabilities?.length
        ? `<ul class="ext-capabilities">${skill.capabilities.map((text) => `<li>${esc(text)}</li>`).join('')}</ul>`
        : '';
    }

    async function fetchMarket(pid) {
      if (!markets.has(pid)) markets.set(pid, { items: null, sequence: 0 });
      const state = markets.get(pid);
      const sequence = ++state.sequence;
      const response = await api(`${endpoint(pid)}/market`);
      if (!Array.isArray(response?.items)) throw new Error('精选目录响应缺少 items，请重试。');
      if (sequence === state.sequence) state.items = response.items;
      return response.items;
    }

    function openMarket(pid) {
      const projectName = allProjects().find((item) => item.id === pid)?.name || pid;
      const context = showDialog(
        'Skill 市场',
        `<div class="ext-market">
        <p class="ext-help">当前项目 · ${esc(projectName)}。精选 Skill 来自公开仓库的固定版本，仅导入 Markdown 指令；所需工具请另行配置。</p>
        <div class="ext-market-filters">
          <label class="ext-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="搜索名称、发布者或仓库" aria-label="搜索精选 Skill"></label>
          <label class="ext-filter">分类 <select aria-label="按分类筛选"><option value="">全部</option></select></label>
          ${button('market-refresh', '刷新目录')}
        </div>
        <p class="ext-save-state" role="status" aria-live="polite"></p><p class="ext-form-error" role="alert" hidden></p>
        <div class="ext-card-grid ext-market-grid" data-ext-market-cards></div>
      </div>`,
      );
      const search = context.root.querySelector('input[type=search]');
      const category = context.root.querySelector('select');
      const cards = context.root.querySelector('[data-ext-market-cards]');
      const status = context.root.querySelector('.ext-save-state');
      const refresh = context.root.querySelector('[data-ext-action="market-refresh"]');
      let skills = markets.get(pid)?.items || [];
      let loading = false;
      let installing = '';
      let ready = false;

      function draw() {
        if (!live(context)) return;
        refresh.disabled = loading || Boolean(installing);
        cards.setAttribute('aria-busy', String(loading || Boolean(installing)));
        const selectedCategory = category.value;
        category.innerHTML =
          '<option value="">全部</option>' +
          [...new Set(skills.map((skill) => skill.category))]
            .map((value) => `<option value="${esc(value)}">${esc(value)}</option>`)
            .join('');
        category.value = selectedCategory;
        if (loading && !skills.length) {
          cards.innerHTML = '<p class="ext-loading">正在读取精选目录…</p>';
          return;
        }
        const saved = focusSnapshot(cards);
        const query = search.value.trim().toLocaleLowerCase();
        const results = skills.filter(
          (skill) =>
            (!category.value || skill.category === category.value) &&
            `${skill.title} ${skill.name} ${skill.description} ${skill.publisher} ${skill.repository} ${skill.upstreamName}`
              .toLocaleLowerCase()
              .includes(query),
        );
        cards.innerHTML =
          results
            .map((skill) => {
              const review = needsMarketReview(skill);
              const disabled =
                !ready || loading || installing || ['enabled', 'conflict'].includes(skill.status);
              const previewLabel =
                skill.legacy || skill.status === 'legacy'
                  ? '预览迁移'
                  : review
                    ? '预览更新'
                    : '查看正文';
              const attrs = `data-ext-id="${esc(skill.id)}"`;
              return `<article class="ext-card ext-market-card">
            <p class="ext-card-kind">${esc(skill.category)} · ${esc(skill.publisher)}</p>
            <h3>${esc(skill.title)}</h3><code>/${esc(skill.name)}</code>
            <p class="ext-market-description">${esc(skill.description)}</p>
            ${marketStatusHTML(skill)}
            ${skill.installedVersion != null ? `<p class="ext-help">项目 v${esc(skill.installedVersion)}${skill.installedRevision ? ` · ${esc(skill.installedRevision.slice(0, 12))}` : ''}</p>` : ''}
            <p class="ext-card-source">${esc(skill.repository || '公开仓库')}${skill.commit ? `<span title="${esc(skill.commit)}">${esc(skill.commit.slice(0, 12))}</span>` : ''}</p>
            ${capabilitiesHTML(skill)}${marketSourceHTML(skill)}
            ${skill.status === 'conflict' ? '<p class="ext-compatibility">项目中已有同名扩展。请先在项目扩展中重命名或删除冲突项，再刷新目录。</p>' : ''}
            <div class="ext-market-actions">
              ${button('market-preview', previewLabel, `${attrs} data-ext-focus="preview-${esc(skill.id)}" ${loading || installing ? 'disabled' : ''}`, review ? 'ext-button-primary' : '')}
              ${!review ? button('market-install', installing === skill.id ? '正在处理…' : skill.status === 'disabled' ? '启用' : skill.status === 'enabled' ? '已启用' : skill.status === 'conflict' ? '同名冲突' : '安装并启用', `${attrs} data-ext-focus="install-${esc(skill.id)}" ${disabled ? 'disabled' : ''}`, skill.status === 'available' ? 'ext-button-primary' : '') : ''}
            </div></article>`;
            })
            .join('') || '<p class="ext-help">没有匹配的 Skill。</p>';
        restoreFocus(cards, saved);
      }

      async function refreshMarket() {
        if (!live(context) || loading) return;
        loading = true;
        ready = false;
        formError(context, '');
        status.textContent = skills.length
          ? '正在刷新目录，保留上次显示的内容…'
          : '正在读取精选目录…';
        draw();
        try {
          const items = await fetchMarket(pid);
          if (!live(context)) return;
          skills = items;
          ready = true;
          status.textContent = '';
        } catch (error) {
          formError(context, `${messageOf(error)} 可点击“刷新目录”重试。`);
          if (live(context))
            status.textContent = skills.length ? '当前显示上次成功读取的目录，安装前请刷新。' : '';
        } finally {
          loading = false;
          draw();
        }
      }

      search.addEventListener('input', draw);
      category.addEventListener('change', draw);
      context.root.addEventListener('click', async (event) => {
        const selected = event.target.closest('[data-ext-action]');
        if (!selected || !live(context) || loading || installing) return;
        const action = selected.dataset.extAction;
        if (action === 'market-refresh') return refreshMarket();
        const skill = skills.find((value) => value.id === selected.dataset.extId);
        if (!skill) return;
        if (action === 'market-preview') return openMarketPreview(pid, skill.id, skill.installedId);
        if (
          action !== 'market-install' ||
          !ready ||
          !['available', 'disabled'].includes(skill.status)
        )
          return;
        if (needsMarketReview(skill)) return openMarketPreview(pid, skill.id, skill.installedId);
        if (!skill.revision) return formError(context, '目录缺少修订号，请刷新目录后重试。');
        installing = skill.id;
        formError(context, '');
        status.textContent = '';
        draw();
        try {
          const result = await api(`${endpoint(pid)}/market`, {
            method: 'POST',
            body: { id: skill.id, revision: skill.revision },
          });
          const item = returnedItem(result);
          rememberItem(pid, item);
          // Discard cached status after a mutation, even if this dialog was closed.
          markets.delete(pid);
          if (live(context)) {
            await refreshMarket();
            if (live(context))
              status.textContent = `已启用 /${item?.name || skill.name}，可以回到该项目的对话使用。`;
          }
          await load(pid, true);
        } catch (error) {
          if (error.status === 409 && live(context)) await refreshMarket();
          formError(context, messageOf(error));
        } finally {
          installing = '';
          draw();
          refreshSurfaces();
        }
      });
      draw();
      void refreshMarket();
    }

    function openInstalledMarketPreview(pid, item) {
      if (item.marketId) return openMarketPreview(pid, item.marketId, item.id);
      const context = showDialog(
        '检查 Skill 更新',
        `<p class="ext-save-state" role="status" aria-live="polite"></p><p class="ext-form-error" role="alert" hidden></p><div class="ext-dialog-actions">${button('cancel', '取消')}${button('market-resolve', '重新检查')}</div>`,
      );
      async function resolve() {
        if (!live(context) || context.busy) return;
        formError(context, '');
        setBusy(context, true, '正在核对市场来源…');
        const retry = context.root.querySelector('[data-ext-action="market-resolve"]');
        retry.disabled = true;
        try {
          const skills = await fetchMarket(pid);
          if (!live(context)) return;
          const skill = skills.find((value) => value.installedId === item.id);
          if (skill) return openMarketPreview(pid, skill.id, item.id);
          if (item.origin) return openPublicImport(pid, item.kind, item, true);
          formError(
            context,
            '此 Skill 尚未关联公开来源。可在“查看与编辑”中检查正文，或从 Skill 市场导入。',
          );
        } catch (error) {
          formError(context, `${messageOf(error)} 无法核对来源，请重试。`);
        } finally {
          setBusy(context, false);
          if (live(context)) retry.disabled = false;
        }
      }
      context.root.addEventListener('click', (event) => {
        const action = event.target.closest('[data-ext-action]')?.dataset.extAction;
        if (action === 'cancel') closeOwnDialog(context);
        if (action === 'market-resolve') void resolve();
      });
      void resolve();
    }

    function openMarketPreview(pid, id, installedId) {
      const projectName = allProjects().find((item) => item.id === pid)?.name || pid;
      const context = showDialog(
        'Skill 市场 · 预览',
        `<div class="ext-market-preview">
        <p class="ext-editor-scope">当前项目 · ${esc(projectName)}</p>
        <p class="ext-save-state" role="status" aria-live="polite"></p><p class="ext-form-error" role="alert" hidden></p>
        <div data-ext-market-preview></div>
        <div class="ext-dialog-actions">${button('market-back', '返回市场')}${button('market-preview-reload', '重新读取预览')}${button('market-apply', '应用更新', 'disabled', 'ext-button-primary')}</div></div>`,
      );
      const content = context.root.querySelector('[data-ext-market-preview]');
      const apply = context.root.querySelector('[data-ext-action="market-apply"]');
      const reload = context.root.querySelector('[data-ext-action="market-preview-reload"]');
      let preview = null;
      let localBody = '';
      let stale = true;
      let sequence = 0;

      function replacementRequired() {
        return Boolean(preview?.requiresReplacement || preview?.skill.localModified);
      }
      function updateActions() {
        if (!live(context)) return;
        reload.disabled = context.busy;
        const confirmed = context.root.querySelector('[data-ext-replace-local]')?.checked;
        apply.disabled =
          context.busy ||
          stale ||
          !preview ||
          Boolean(preview.entry.issue) ||
          preview.skill.status === 'conflict' ||
          (replacementRequired() && !confirmed);
        apply.textContent = preview?.update
          ? replacementRequired()
            ? '替换本地正文并应用更新'
            : '应用审核更新'
          : '安装并启用';
      }
      async function readPreview() {
        if (!live(context) || context.busy) return;
        const request = ++sequence;
        stale = true;
        formError(context, '');
        setBusy(context, true, '正在读取固定版本并校验来源…');
        updateActions();
        try {
          const response = await api(`${endpoint(pid)}/market-preview`, {
            method: 'POST',
            body: { id },
          });
          if (!live(context) || request !== sequence) return;
          if (
            response?.skill?.id !== id ||
            !response.skill.revision ||
            typeof response.entry?.body !== 'string'
          )
            throw new Error('市场预览响应不完整，请重新读取。');
          if (installedId && response.update?.id !== installedId)
            throw new Error('安装关联已变化，请返回市场刷新后重新预览。');
          if (
            response.update &&
            (!response.update.id ||
              !Number.isInteger(response.update.version) ||
              !response.update.revision)
          )
            throw new Error('市场预览缺少更新版本，请重新读取。');
          let oldBody = response.localBody;
          if (response.update && typeof oldBody !== 'string') {
            let item = cache(pid).items?.find(
              (value) =>
                value.id === response.update.id && value.version === response.update.version,
            );
            if (!item) {
              await load(pid, true);
              if (!live(context) || request !== sequence) return;
              item = cache(pid).items?.find(
                (value) =>
                  value.id === response.update.id && value.version === response.update.version,
              );
            }
            oldBody = item?.body;
            if (typeof oldBody !== 'string')
              throw new Error('无法读取与预览版本一致的本地正文，请重新读取预览。');
          }
          preview = response;
          localBody = typeof oldBody === 'string' ? oldBody : '';
          stale = false;
          const skill = response.skill;
          content.innerHTML = `<h3>${esc(skill.title || skill.name)}</h3><p class="ext-help">安装别名 /${esc(skill.name)} · ${esc(skill.publisher)}</p>
            ${marketStatusHTML(skill)}${capabilitiesHTML(skill)}${marketSourceHTML(skill)}
            ${response.entry.issue ? `<p class="ext-compatibility">${esc(response.entry.issue)}</p>` : ''}
            ${response.update ? '<p class="ext-help">应用后保留项目中的调用名、启停选择和记录 ID。请比较当前正文与审核后的新正文。</p>' : '<p class="ext-help">确认正文与来源后，安装到当前项目。</p>'}
            <div class="ext-preview-columns">
              ${response.update ? `<section class="ext-preview-pane"><h4>当前项目正文 · v${esc(response.update.version)}</h4><pre class="ext-body-preview" tabindex="0">${esc(localBody)}</pre><div class="ext-backup-actions">${button('market-copy-local', '复制本地正文')}${button('market-backup-local', '下载 Markdown 备份')}</div><p class="ext-help" data-ext-backup-state role="status" aria-live="polite"></p></section>` : ''}
              <section class="ext-preview-pane"><h4>审核后的正文 · ${esc(skill.commit?.slice(0, 12) || skill.revision.slice(0, 12))}</h4><pre class="ext-body-preview" tabindex="0">${esc(response.entry.body)}</pre><details class="ext-preview"><summary>阅读渲染后的内容</summary><div class="ext-prose">${previewHTML(response.entry.body)}</div></details></section>
            </div>
            ${replacementRequired() ? '<fieldset class="ext-replacement" data-ext-fields><p>当前正文包含本地修改，应用将覆盖这些修改。可先复制或下载备份。</p><label><input type="checkbox" data-ext-replace-local> 我已检查新旧正文，确认替换本地修改</label></fieldset>' : ''}`;
        } catch (error) {
          formError(context, messageOf(error));
        } finally {
          if (live(context) && request === sequence) {
            setBusy(context, false);
            updateActions();
          }
        }
      }

      context.root.addEventListener('change', (event) => {
        if (event.target.matches('[data-ext-replace-local]')) updateActions();
      });
      context.root.addEventListener('click', async (event) => {
        const action = event.target.closest('[data-ext-action]')?.dataset.extAction;
        if (!live(context)) return;
        if (action === 'market-back') return openMarket(pid);
        if (context.busy) return;
        if (action === 'market-preview-reload') return readPreview();
        if (!preview) return;
        if (action === 'market-copy-local' || action === 'market-backup-local') {
          const request = sequence;
          try {
            if (action === 'market-copy-local') {
              if (!navigator.clipboard?.writeText)
                throw new Error('当前浏览器无法复制，请下载 Markdown 备份。');
              await navigator.clipboard.writeText(localBody);
            } else {
              const url = URL.createObjectURL(
                new Blob([localBody], { type: 'text/markdown;charset=utf-8' }),
              );
              const link = document.createElement('a');
              link.href = url;
              link.download = `${preview.skill.name.replace(/[^\p{L}\p{N}_-]/gu, '-')}-local-v${preview.update.version}.md`;
              context.root.append(link);
              link.click();
              link.remove();
              window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
            if (live(context) && request === sequence)
              context.root.querySelector('[data-ext-backup-state]').textContent =
                action === 'market-copy-local' ? '已复制本地正文。' : '已发起 Markdown 备份下载。';
          } catch (error) {
            if (live(context) && request === sequence) formError(context, messageOf(error));
          }
          return;
        }
        if (action !== 'market-apply' || apply.disabled || stale) return;
        const snapshot = preview;
        const replaceLocal = replacementRequired();
        if (replaceLocal && !context.root.querySelector('[data-ext-replace-local]')?.checked)
          return;
        const key = snapshot.update && itemKey(pid, snapshot.update.id);
        if (key && pending.has(key))
          return formError(context, '此扩展正在保存，请完成后重新读取预览。');
        if (key) pending.add(key);
        formError(context, '');
        setBusy(context, true, snapshot.update ? '正在应用审核更新…' : '正在安装…');
        updateActions();
        refreshSurfaces();
        try {
          const response = await api(
            `${endpoint(pid)}/${snapshot.update ? 'market-update' : 'market'}`,
            {
              method: 'POST',
              body: snapshot.update
                ? {
                    id,
                    update: {
                      id: snapshot.update.id,
                      version: snapshot.update.version,
                      revision: snapshot.update.revision,
                      ...(replaceLocal ? { replaceLocal: true } : {}),
                    },
                  }
                : { id, revision: snapshot.skill.revision },
            },
          );
          rememberItem(pid, returnedItem(response));
          markets.delete(pid);
          stale = true;
          await load(pid, true);
          closeOwnDialog(context);
          notify(snapshot.update ? '审核更新已应用' : 'Skill 已安装并启用');
        } catch (error) {
          if (error.status === 409) {
            stale = true;
            markets.delete(pid);
            await load(pid, true);
          }
          formError(
            context,
            `${messageOf(error)}${stale ? ' 请重新读取预览、核对新旧正文后再应用。' : ' 可重试，或重新读取预览。'}`,
          );
        } finally {
          if (key) pending.delete(key);
          setBusy(context, false);
          updateActions();
          refreshSurfaces();
        }
      });
      void readPreview();
    }

    function openPublicImport(pid, kind, updating, marketChecked = false) {
      if (updating && kind === 'skill' && (!marketChecked || updating.marketId))
        return openInstalledMarketPreview(pid, updating);
      const officialSkill =
        'https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md';
      const formLabel =
        kind === 'mcp' ? 'MCP Registry 搜索词或 GitHub 配置链接' : 'GitHub 仓库或文件链接';
      const context = showDialog(
        updating ? '同步公开来源' : '从公开来源导入',
        `<form data-ext-public>
        ${field(formLabel, 'source', updating?.origin?.location || '', `${updating ? 'readonly' : 'required'} autocomplete="off" maxlength="4096"`)}
        <div class="ext-dialog-actions">${!updating && kind === 'skill' ? button('public-preset', 'Anthropic Frontend Design') : ''}${!updating && kind === 'mcp' ? button('public-preset', '搜索 Context7') : ''}<button type="submit" class="ext-button">${updating ? '检查更新' : '查询'}</button></div>
        <p class="ext-save-state" role="status"></p><p class="ext-form-error" role="alert" hidden></p>
        <div data-ext-public-results></div>
        </form>`,
        true,
      );
      const form = context.root.querySelector('form');
      const results = form.querySelector('[data-ext-public-results]');
      let entries = [];
      async function loadPublic(source) {
        if (context.busy) return;
        formError(context, '');
        setBusy(context, true, '正在读取公开来源…');
        try {
          const response = await api(`${endpoint(pid)}/public-preview`, {
            method: 'POST',
            body: { source, kind },
          });
          entries = updating
            ? response.items.filter((item) => item.key === updating.origin.key)
            : response.items;
          if (!live(context)) return;
          results.innerHTML =
            entries
              .map((item, index) => {
                const unchanged =
                  updating?.origin.revision && updating.origin.revision === item.revision;
                const detail = item.body
                  ? `<details class="ext-preview"><summary>预览 Markdown</summary><div class="markdown-body">${previewHTML(item.body)}</div></details>`
                  : item.transport
                    ? `<pre class="safe-pre">${esc(JSON.stringify(item.transport, null, 2))}</pre>`
                    : '';
                const label = item.revision
                  ? updating
                    ? '应用更新'
                    : '导入到当前项目'
                  : '查看文件';
                return `<article class="ext-card"><strong>${esc(item.name)}</strong><p>${esc(item.description)}</p>${detail}
              ${item.issue ? `<p class="ext-compatibility">${esc(item.issue)}</p>` : unchanged ? '<p class="ext-help">当前已是此来源的最新版本。</p>' : button('public-select', label, `data-ext-index="${index}"`, 'ext-button-primary')}</article>`;
              })
              .join('') || '<p class="ext-help">未找到匹配的扩展。</p>';
        } catch (error) {
          formError(context, messageOf(error));
        } finally {
          setBusy(context, false);
        }
      }
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = form.elements.source.value.trim();
        if (value)
          void loadPublic(
            kind === 'mcp' && !value.includes('://') && !value.startsWith('registry:')
              ? `registry:${value}`
              : value,
          );
      });
      context.root.addEventListener('click', async (event) => {
        if (context.busy) return;
        const button = event.target.closest('[data-ext-action]');
        if (button?.dataset.extAction === 'public-preset') {
          form.elements.source.value = kind === 'mcp' ? 'context7' : officialSkill;
          form.requestSubmit();
        }
        if (button?.dataset.extAction !== 'public-select') return;
        const item = entries[Number(button.dataset.extIndex)];
        if (!item) return;
        if (!item.revision) return loadPublic(item.location);
        setBusy(context, true);
        formError(context, '');
        try {
          const response = await api(`${endpoint(pid)}/public-import`, {
            method: 'POST',
            body: {
              source: item.location,
              key: item.key,
              revision: item.revision,
              kind,
              ...(updating ? { update: { id: updating.id, version: updating.version } } : {}),
            },
          });
          rememberItem(pid, returnedItem(response));
          await load(pid, true);
          closeOwnDialog(context);
          notify(updating ? '同步已完成' : '已导入当前项目');
        } catch (error) {
          formError(context, messageOf(error));
        } finally {
          setBusy(context, false);
          refreshSurfaces();
        }
      });
      if (updating) void loadPublic(updating.origin.location);
    }

    function confirmDelete(pid, item) {
      const context = showDialog(
        '删除扩展',
        `<p>删除 <strong>${esc(item.name)}</strong>？后续会话将无法再选择这个扩展。</p><p class="ext-help">已有草稿中的选择会标记为不可用，可手动移除。</p><p class="ext-form-error" role="alert" hidden></p><div class="ext-dialog-actions">${button('cancel', '取消')}${button('confirm-delete', '确认删除', '', 'ext-button-danger')}</div>`,
        false,
      );
      context.root.addEventListener('click', async (event) => {
        const action = event.target.closest('[data-ext-action]')?.dataset.extAction;
        if (action === 'cancel') return closeOwnDialog(context);
        if (action !== 'confirm-delete' || context.busy) return;
        setBusy(context, true);
        const key = itemKey(pid, item.id);
        try {
          await api(endpoint(pid, item.id), { method: 'DELETE' });
          cache(pid).items = cache(pid).items?.filter((value) => value.id !== item.id) || null;
          tests.delete(key);
          operationErrors.delete(key);
          await load(pid, true);
          closeOwnDialog(context);
          notify('扩展已删除');
        } catch (error) {
          formError(context, messageOf(error));
        } finally {
          setBusy(context, false);
          refreshSurfaces();
        }
      });
    }

    function previewHTML(body) {
      return previewRenderer
        ? previewRenderer.render(body || '')
        : `<pre>${esc(body || '暂无内容')}</pre>`;
    }

    function field(label, name, value, extra = '', help = '') {
      return `<label class="ext-field"><span>${label}</span><input name="${name}" value="${esc(value)}" ${extra}>${help ? `<small>${help}</small>` : ''}</label>`;
    }

    function openEditor(pid, item, requestedKind) {
      const kind = item?.kind || requestedKind;
      const isMCP = kind === 'mcp';
      const type = item?.transport?.type || 'http';
      const transport = item?.transport || {};
      const context = showDialog(
        item ? `编辑 ${kinds[kind]}` : `新建 ${kinds[kind]}`,
        `<form class="ext-editor" data-ext-form="editor">
        <p class="ext-editor-scope">项目 · ${esc(allProjects().find((value) => value.id === pid)?.name || pid)}</p>
        <fieldset class="ext-editor-fields" data-ext-fields>
          <div class="ext-field-pair">${field('名称', 'name', item?.name || '', 'required maxlength="100" autocomplete="off" data-ext-focus="editor-name"', isMCP ? '在 # 菜单中显示的服务名称' : '在 / 菜单中显示；使用字母、数字、短横线、下划线或冒号')}
            <label class="ext-enable-field"><input type="checkbox" name="enabled" ${!item || item.enabled ? 'checked' : ''}> 启用此扩展</label></div>
          <label class="ext-field"><span>描述</span><textarea name="description" rows="2" maxlength="2000" data-ext-focus="editor-description">${esc(item?.description || '')}</textarea></label>
          ${
            isMCP
              ? `<label class="ext-field"><span>连接方式</span><select name="transportType"><option value="http" ${type === 'http' ? 'selected' : ''}>HTTP</option><option value="stdio" ${type === 'stdio' ? 'selected' : ''}>本地进程 · stdio</option></select></label>
            <fieldset class="ext-transport" data-ext-transport="http" ${type !== 'http' ? 'hidden disabled' : ''}>
              ${field('服务 URL', 'url', transport.url || '', 'type="url" required placeholder="https://…" autocomplete="off"')}
              ${field('令牌环境变量名（可选）', 'tokenEnv', transport.tokenEnv || '', 'pattern="[A-Za-z_][A-Za-z0-9_]*" autocomplete="off"', '填写本地服务端读取的变量名称。')}</fieldset>
            <fieldset class="ext-transport" data-ext-transport="stdio" ${type !== 'stdio' ? 'hidden disabled' : ''}>
              ${field('可执行命令', 'command', transport.command || '', 'required autocomplete="off" spellcheck="false"')}
              <label class="ext-field"><span>参数 · JSON 字符串数组</span><textarea class="ext-code-input" name="args" rows="3" spellcheck="false">${esc(JSON.stringify(transport.args || [], null, 2))}</textarea></label>
              <label class="ext-field"><span>环境变量名 · 每行一个</span><textarea class="ext-code-input" name="envNames" rows="3" spellcheck="false">${esc((transport.envNames || []).join('\n'))}</textarea><small>仅填写变量名，值由本地服务端提供。</small></label></fieldset>
            <div class="ext-connection-result" role="status" aria-live="polite"></div>
            <section class="ext-tool-section"><div class="ext-tool-heading"><h3>允许的工具</h3><span class="ext-tool-count"></span></div><p class="ext-help">勾选项目可以使用的工具，并设置访问方式。新发现的工具默认不勾选。</p><div class="ext-tool-list"></div></section>`
              : `${field('来源', 'source', item?.source || 'manual', 'maxlength="500"')}
              <div class="ext-markdown-toolbar"><span>Markdown 指令</span><label class="ext-file-button">导入文件<input type="file" name="markdownFile" accept=".md,.markdown,text/markdown,text/plain" aria-label="导入 Markdown 文件"></label></div>
              <textarea class="ext-code-input ext-body-input" name="body" rows="12" required spellcheck="false" aria-label="Markdown 指令正文" data-ext-focus="editor-body">${esc(item?.body || '')}</textarea>
              <details class="ext-preview"><summary>预览内容</summary><div class="ext-prose">${previewHTML(item?.body || '')}</div></details>
              ${kind === 'skill' ? `<label class="ext-auto-field"><input type="checkbox" name="autoInvoke" ${autoEnabled(item) ? 'checked' : ''} ${!allowsAuto(item) ? 'disabled' : ''}><span>允许自动调用<small>${!allowsAuto(item) ? '上游声明禁止模型调用，当前自动调用已关闭。' : '启用后，模型可在当前项目中按需加载。保存后从下一轮对话生效。'}</small></span></label><p class="ext-help">手动调用与兼容性由服务端解析 Markdown 元数据。${item?.userInvocable === false ? '当前不支持 / 手动调用。' : '关闭自动调用后，仍可使用 / 手动选择兼容的 Skill。'}</p>` : ''}`
          }
          ${item?.compatibility ? `<p class="ext-compatibility">${esc(item.compatibility)}</p>` : ''}
        </fieldset>
        <p class="ext-form-error" role="alert" hidden></p>
        <div class="ext-dialog-actions">${button('cancel', '取消')}<span class="ext-save-state" role="status" aria-live="polite"></span>${isMCP ? '<button type="submit" class="ext-button" name="intent" value="test">保存并测试</button>' : ''}<button type="submit" class="ext-button ext-button-primary" name="intent" value="save">保存</button></div>
      </form>`,
      );
      Object.assign(context, {
        pid,
        kind,
        item,
        tools: isMCP ? discoveredTools(pid, item || {}).slice() : [],
        fileSequence: 0,
      });
      const form = context.root.querySelector('form');
      context.form = form;
      if (isMCP) {
        renderTools(context, item?.allowedTools || []);
        renderConnection(context);
      }
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        event.stopPropagation();
        saveEditor(context, event.submitter?.value === 'test');
      });
      context.root.addEventListener('click', (event) => {
        if (event.target.closest('[data-ext-action="cancel"]')) closeOwnDialog(context);
      });
      form.addEventListener('input', (event) => {
        if (event.target.name === 'body')
          form.querySelector('.ext-prose').innerHTML = previewHTML(event.target.value);
      });
      form.addEventListener('change', (event) => {
        if (event.target.name === 'transportType') {
          for (const group of form.querySelectorAll('[data-ext-transport]')) {
            group.hidden = group.dataset.extTransport !== event.target.value;
            group.disabled = group.hidden;
          }
        } else if (event.target.name === 'markdownFile') {
          importMarkdown(context, event.target);
        } else if (event.target.matches('[data-ext-tool-check]')) {
          const row = event.target.closest('.ext-tool');
          row.querySelector('select').disabled = !event.target.checked;
          updateToolCount(context);
        }
      });
      return context;
    }

    async function importMarkdown(context, input) {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      const sequence = ++context.fileSequence;
      try {
        if (!/\.(md|markdown)$/i.test(file.name))
          throw new Error('请选择 Markdown 文件（.md 或 .markdown）。');
        if (file.size > 1048576) throw new Error('Markdown 文件不能超过 1 MiB。');
        const body = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        if (!live(context) || sequence !== context.fileSequence) return;
        const form = context.form;
        if (!form.elements.name.value.trim())
          form.elements.name.value = file.name
            .replace(/\.(md|markdown)$/i, '')
            .replace(/[^\p{L}\p{N}_:-]+/gu, '-');
        form.elements.source.value = file.name;
        form.elements.body.value = body;
        form.querySelector('.ext-prose').innerHTML = previewHTML(body);
        form.querySelector('.ext-preview').open = true;
        formError(context, '');
      } catch (error) {
        if (live(context) && sequence === context.fileSequence)
          formError(
            context,
            error instanceof TypeError ? '文件不是有效的 UTF-8 文本。' : messageOf(error),
          );
      }
    }

    function renderTools(context, allowed) {
      if (!live(context)) return;
      const byName = new Map(context.tools.map((tool) => [tool.name, tool]));
      const permissions = new Map(allowed.map((tool) => [tool.name, tool.access]));
      for (const tool of allowed)
        if (!byName.has(tool.name))
          byName.set(tool.name, { name: tool.name, description: '已保存的工具；本次尚未发现。' });
      const list = context.root.querySelector('.ext-tool-list');
      list.innerHTML =
        [...byName.values()]
          .map(
            (tool, index) =>
              `<div class="ext-tool" data-ext-tool="${esc(tool.name)}"><label><input type="checkbox" data-ext-tool-check ${permissions.has(tool.name) ? 'checked' : ''}><span><strong>${esc(tool.name)}</strong><small>${esc(tool.description || '暂无描述')}</small></span></label><select aria-label="${esc(tool.name)} 访问方式" data-ext-focus="tool-access-${index}" ${permissions.has(tool.name) ? '' : 'disabled'}><option value="approval" ${permissions.get(tool.name) !== 'read' ? 'selected' : ''}>每次审批</option><option value="read" ${permissions.get(tool.name) === 'read' ? 'selected' : ''}>只读</option></select></div>`,
          )
          .join('') || '<p class="ext-tool-empty">保存并测试连接后，在这里选择工具。</p>';
      updateToolCount(context);
    }

    function readPermissions(context) {
      return [...context.root.querySelectorAll('[data-ext-tool]')]
        .filter((row) => row.querySelector('input').checked)
        .map((row) => ({ name: row.dataset.extTool, access: row.querySelector('select').value }));
    }

    function updateToolCount(context) {
      context.root.querySelector('.ext-tool-count').textContent =
        `已选择 ${readPermissions(context).length} 个`;
    }

    function renderConnection(context) {
      if (!live(context) || context.kind !== 'mcp') return;
      const result = context.item && connection(context.pid, context.item);
      const box = context.root.querySelector('.ext-connection-result');
      box.innerHTML = result
        ? `<div class="ext-test-result" data-ext-status="${esc(result.status)}"><strong>${esc(testLabels[result.status])}</strong><p>${esc(result.message || (result.status === 'connected' ? `发现 ${result.tools.length} 个工具` : '请检查连接配置后重试。'))}</p></div>`
        : '<p class="ext-help">连接尚未测试。测试会由本地服务端发起。</p>';
    }

    function editorPayload(context) {
      const values = new FormData(context.form);
      const name = String(values.get('name') || '').trim();
      const validName = context.kind === 'mcp' ? /^[\p{L}\p{N}_.:-]+$/u : /^[\p{L}\p{N}_:-]+$/u;
      if (!name || !validName.test(name))
        throw new Error('名称请使用字母、数字、短横线、下划线或冒号；MCP 名称也可以包含句点。');
      const fields = {
        kind: context.kind,
        name,
        description: String(values.get('description') || '').trim(),
        enabled: values.has('enabled'),
      };
      if (context.kind !== 'mcp') {
        return {
          ...fields,
          source: String(values.get('source') || '').trim(),
          body: String(values.get('body') || ''),
          ...(context.kind === 'skill'
            ? { autoInvoke: allowsAuto(context.item) && values.has('autoInvoke') }
            : {}),
        };
      }
      let transport;
      if (values.get('transportType') === 'http') {
        const url = String(values.get('url') || '').trim();
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error('请输入完整的 HTTP 或 HTTPS 服务 URL。');
        }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
          throw new Error('服务 URL 需使用 HTTP 或 HTTPS，且不能包含用户名或密码。');
        const tokenEnv = String(values.get('tokenEnv') || '').trim();
        transport = { type: 'http', url, ...(tokenEnv ? { tokenEnv } : {}) };
      } else {
        let args;
        try {
          args = JSON.parse(String(values.get('args') || '[]'));
        } catch {
          throw new Error('参数必须是 JSON 字符串数组。');
        }
        if (!Array.isArray(args) || !args.every((value) => typeof value === 'string'))
          throw new Error('参数必须是 JSON 字符串数组。');
        const envNames = [
          ...new Set(
            String(values.get('envNames') || '')
              .split(/\s+/)
              .filter(Boolean),
          ),
        ];
        if (envNames.some((value) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)))
          throw new Error('环境变量名只能包含字母、数字和下划线，且不能以数字开头。');
        const command = String(values.get('command') || '').trim();
        if (!command) throw new Error('请填写可执行命令。');
        transport = { type: 'stdio', command, args, envNames };
      }
      return { ...fields, transport, allowedTools: readPermissions(context) };
    }

    function formError(context, message) {
      if (!live(context)) return;
      const element = context.root.querySelector('.ext-form-error');
      element.textContent = message;
      element.hidden = !message;
    }

    function setBusy(context, busy, label = '正在保存…') {
      context.busy = busy;
      if (!live(context)) return;
      if (busy) context.focus = focusSnapshot(context.root);
      context.root.setAttribute('aria-busy', String(busy));
      const fields = context.root.querySelector('[data-ext-fields]');
      if (fields) fields.disabled = busy;
      for (const control of context.root.querySelectorAll(
        'button[type="submit"], [data-ext-action="confirm-delete"]',
      ))
        control.disabled = busy;
      const status = context.root.querySelector('.ext-save-state');
      if (status) status.textContent = busy ? label : '';
      if (
        !busy &&
        (document.activeElement === document.body || context.root.contains(document.activeElement))
      )
        restoreFocus(context.root, context.focus);
    }

    async function saveEditor(context, andTest) {
      if (!live(context) || context.busy || !context.form.reportValidity()) return;
      let payload;
      try {
        payload = editorPayload(context);
      } catch (error) {
        return formError(context, messageOf(error));
      }
      formError(context, '');
      setBusy(context, true);
      const oldId = context.item?.id;
      try {
        const result = await api(endpoint(context.pid, oldId), {
          method: oldId ? 'PATCH' : 'POST',
          body: { ...payload, ...(oldId ? { version: context.item.version } : {}) },
        });
        const savedItem = returnedItem(result);
        rememberItem(context.pid, savedItem);
        await load(context.pid, true);
        const resolved = cache(context.pid).items?.find(
          (value) => value.id === (savedItem?.id || oldId),
        );
        // A create response may be empty; resolve only an unambiguous server-listed identity.
        const created =
          !oldId && !resolved
            ? cache(context.pid).items?.filter(
                (value) => value.kind === context.kind && value.name === payload.name,
              )
            : [];
        context.item = resolved || savedItem || (created.length === 1 ? created[0] : null);
        if (andTest) {
          if (!context.item)
            throw new Error('扩展已保存，但响应未提供可用于测试的扩展 ID。请重新加载列表。');
          if (live(context)) {
            const allowed = readPermissions(context);
            context.tools = discoveredTools(context.pid, context.item).slice();
            renderTools(context, allowed);
            await performTest(context);
          }
        } else {
          closeOwnDialog(context);
          notify('扩展已保存');
        }
      } catch (error) {
        if (error.status === 409) {
          await load(context.pid, true);
          formError(
            context,
            `${messageOf(error)} 当前编辑内容已保留，请关闭后重新打开最新版本再保存。`,
          );
        } else {
          formError(context, messageOf(error));
        }
      } finally {
        setBusy(context, false);
        refreshSurfaces();
      }
    }

    async function performTest(context) {
      const item = context.item;
      const key = itemKey(context.pid, item.id);
      if (pending.has(key)) return;
      pending.add(key);
      refreshSurfaces();
      const permissions = live(context) ? readPermissions(context) : item.allowedTools || [];
      if (live(context))
        context.root.querySelector('.ext-save-state').textContent = '正在测试连接…';
      try {
        const result = await api(`${endpoint(context.pid, item.id)}/test`, { method: 'POST' });
        if (!Object.hasOwn(testLabels, result?.status) || !Array.isArray(result.tools))
          throw new Error('连接测试响应格式不正确。');
        tests.set(key, {
          status: result.status,
          tools: result.tools,
          message: result.message || '',
          transport: transportKey(item),
          version: result.item?.version ?? item.version,
        });
        rememberItem(context.pid, result.item);
        await load(context.pid, true);
        context.item =
          cache(context.pid).items?.find((value) => value.id === item.id) || result.item || item;
        // Some APIs persist the test and increment version without returning item.
        if (transportKey(context.item) === transportKey(item))
          tests.get(key).version = context.item.version;
        if (live(context)) {
          context.tools = result.tools;
          renderConnection(context);
          renderTools(context, permissions);
        }
      } catch (error) {
        tests.set(key, {
          status: 'failed',
          tools: [],
          message: messageOf(error),
          transport: transportKey(item),
          version: context.item?.version ?? item.version,
        });
        if (live(context)) renderConnection(context);
        formError(context, messageOf(error));
      } finally {
        pending.delete(key);
        refreshSurfaces();
      }
    }

    async function testConnection(context) {
      if (context.busy || !context.item) return;
      setBusy(context, true, '正在测试连接…');
      formError(context, '');
      try {
        await performTest(context);
      } finally {
        setBusy(context, false);
      }
    }

    // Only a standalone token is eligible. Paths, Markdown links and code stay literal.
    function triggerAt(input) {
      const { value, selectionStart: caret, selectionEnd } = input;
      if (caret == null || caret !== selectionEnd) return null;
      let start = caret;
      let end = caret;
      while (start > 0 && !/\s/u.test(value[start - 1])) start--;
      while (end < value.length && !/\s/u.test(value[end])) end++;
      const word = value.slice(start, end);
      const before = value.slice(start, caret);
      if (!/^(?:\/[\p{L}\p{N}_:-]*|#[\p{L}\p{N}_:.-]*(?:\/[\p{L}\p{N}_:.-]*)?)$/u.test(word))
        return null;
      if (!before || inCode(value.slice(0, start))) return null;
      return { start, end, symbol: word[0], query: before.slice(1).toLocaleLowerCase(), word };
    }

    function inCode(text) {
      let fence = null;
      let ticks = 0;
      const lines = text.split('\n');
      for (const line of lines) {
        const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
          if (
            match &&
            match[1][0] === fence.marker &&
            match[1].length >= fence.length &&
            !match[2].trim()
          )
            fence = null;
          continue;
        }
        if (match && !ticks) {
          fence = { marker: match[1][0], length: match[1].length };
          continue;
        }
        // Backticks inside a fenced block never affect later inline code detection.
        for (const run of line.matchAll(/(?<!\\)(`+)/g)) {
          if (!ticks) ticks = run[0].length;
          else if (ticks === run[0].length) ticks = 0;
        }
      }
      return Boolean(fence) || ticks !== 0 || /^(?: {4}|\t)/.test(lines.at(-1));
    }

    function choices(pid, trigger) {
      const list = cache(pid).items || [];
      const rows = [];
      for (const item of list) {
        if (!item.enabled || item.supported === false) continue;
        if (trigger.symbol === '/') {
          if (item.kind === 'command' && composer.input.value.slice(0, trigger.start).trim())
            continue;
          if (item.kind !== 'command' && !(item.kind === 'skill' && item.userInvocable !== false))
            continue;
          if (!/^[\p{L}\p{N}_:-]+$/u.test(item.name)) continue;
          rows.push({
            item,
            label: `/${item.name}`,
            description: item.description || '',
            kind: kinds[item.kind],
          });
        } else if (item.kind === 'mcp') {
          const allowed = allowedTools(pid, item);
          if (!allowed.length) continue;
          rows.push({
            item,
            label: `#${item.name}`,
            description: `${allowed.length} 个已允许的工具`,
            kind: 'MCP',
            tools: allowed.map((tool) => tool.name),
          });
          const descriptions = new Map(
            discoveredTools(pid, item).map((tool) => [tool.name, tool.description]),
          );
          for (const tool of allowed)
            rows.push({
              item,
              label: `#${item.name}/${tool.name}`,
              description: descriptions.get(tool.name) || '',
              kind: tool.access === 'read' ? '只读工具' : '需审批工具',
              tools: [tool.name],
            });
        }
      }
      const query = trigger.query;
      return rows
        .filter((row) =>
          `${row.label.slice(1)} ${row.description}`.toLocaleLowerCase().includes(query),
        )
        .sort(
          (a, b) =>
            Number(b.label.slice(1).toLocaleLowerCase().startsWith(query)) -
            Number(a.label.slice(1).toLocaleLowerCase().startsWith(query)),
        );
    }

    function makeComposer(input, chips) {
      const menu = document.createElement('div');
      menu.className = 'ext-completion';
      menu.id = `${prefix}-completion`;
      menu.hidden = true;
      const record = {
        input,
        chips,
        menu,
        rows: [],
        index: 0,
        trigger: null,
        composing: false,
        imeUntil: 0,
        dismissed: '',
        signature: '',
        applying: false,
        pid: '',
        activeDraft: null,
      };
      composerBindings.set(input, record);
      menu.addEventListener('pointerdown', (event) => {
        if (event.button === 0) event.preventDefault();
      });
      menu.addEventListener('click', (event) => {
        const option = event.target.closest('[data-ext-choice]');
        if (!option) return;
        event.preventDefault();
        event.stopPropagation();
        choose(record, Number(option.dataset.extChoice));
      });
      menu.addEventListener('pointermove', (event) => {
        const option = event.target.closest('[data-ext-choice]');
        if (option) markChoice(record, Number(option.dataset.extChoice), false);
      });
      // Capture is essential: the host's textarea Enter handler must never submit a choice.
      input.addEventListener(
        'keydown',
        (event) => {
          if (
            record.composing ||
            event.isComposing ||
            event.keyCode === 229 ||
            Date.now() < record.imeUntil
          ) {
            if (event.key === 'Enter') event.stopImmediatePropagation();
            return;
          }
          if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
          if (record.menu.hidden) return;
          if (['ArrowDown', 'ArrowUp'].includes(event.key) && record.rows.length) {
            event.preventDefault();
            event.stopImmediatePropagation();
            markChoice(
              record,
              (record.index + (event.key === 'ArrowDown' ? 1 : -1) + record.rows.length) %
                record.rows.length,
            );
          } else if (['Enter', 'Tab'].includes(event.key) && record.rows.length) {
            event.preventDefault();
            event.stopImmediatePropagation();
            choose(record, record.index);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            record.dismissed = completionKey(record);
            hideMenu(record);
          }
        },
        true,
      );
      input.addEventListener('input', () => {
        if (record.applying) return;
        record.dismissed = '';
        record.index = 0;
        updateComposer(record);
      });
      input.addEventListener('compositionstart', () => {
        record.composing = true;
        hideMenu(record);
      });
      input.addEventListener('compositionend', () => {
        record.composing = false;
        record.imeUntil = Date.now() + 50;
        updateComposer(record);
      });
      input.addEventListener('focus', () => updateComposer(record));
      input.addEventListener('click', () => updateComposer(record));
      input.addEventListener('keyup', (event) => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) updateComposer(record);
      });
      input.addEventListener('blur', () => hideMenu(record));
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-haspopup', 'listbox');
      input.setAttribute('aria-expanded', 'false');
      return record;
    }

    function bindChips(chips) {
      chips.classList.add('ext-chips');
      if (chipsBindings.has(chips)) return;
      chipsBindings.add(chips);
      chips.addEventListener('click', (event) => {
        const target = event.target.closest('[data-ext-action="remove-selection"]');
        if (!target || !chips.contains(target)) return;
        event.stopPropagation();
        const record = composer;
        const current = draft();
        if (!record || record.chips !== chips || !current || current !== record.activeDraft) return;
        current.extensionSelections = (current.extensionSelections || []).filter(
          (item) => item.id !== target.dataset.extId,
        );
        saveDraft();
        renderChips(record);
        record.input.focus({ preventScroll: true });
      });
    }

    function renderComposer(input, chips) {
      let record = composerBindings.get(input);
      if (!record) record = makeComposer(input, chips);
      if (composer && composer !== record) {
        hideMenu(composer);
        composer.menu.remove();
      }
      composer = record;
      record.chips = chips;
      bindChips(chips);
      if (!record.menu.isConnected) document.body.append(record.menu);
      updateComposer(record);
      if (record.pid && record.activeDraft) load(record.pid);
    }

    function completionKey(record) {
      const token = record.trigger;
      return JSON.stringify([
        record.pid,
        record.input.value,
        token?.start,
        token?.end,
        record.input.selectionStart,
      ]);
    }

    function updateComposer(record) {
      if (record !== composer) return;
      const pid = project()?.id || '';
      const current = draft();
      if (pid !== record.pid || current !== record.activeDraft) {
        hideMenu(record);
        record.index = 0;
        record.dismissed = '';
        record.pid = pid;
        record.activeDraft = current;
      }
      renderChips(record);
      if (
        !current ||
        !pid ||
        record.input.disabled ||
        record.input.readOnly ||
        record.composing ||
        document.activeElement !== record.input
      )
        return hideMenu(record);
      record.trigger = triggerAt(record.input);
      if (!record.trigger || record.dismissed === completionKey(record)) return hideMenu(record);
      const entry = cache(pid);
      const rows = choices(pid, record.trigger);
      record.rows = rows;
      record.index = Math.min(record.index, Math.max(0, rows.length - 1));
      // Unmatched names stay literal, including commands typed directly for the server.
      if (!rows.length && record.trigger.query && !entry.loading && !entry.error)
        return hideMenu(record);
      const signature = JSON.stringify([
        rows.map((row) => [row.item.id, row.item.version, row.label, row.description]),
        entry.loading,
        entry.error,
        record.trigger.symbol,
      ]);
      if (record.signature !== signature) {
        record.signature = signature;
        record.menu.innerHTML = `<div class="ext-completion-head"><strong>${record.trigger.symbol === '/' ? 'Commands & Skills' : 'MCP 工具'}</strong><span>当前项目</span></div><div class="ext-completion-list" role="listbox" aria-label="${record.trigger.symbol === '/' ? '选择命令或 Skill' : '选择 MCP 工具'}">${rows.map((row, index) => `<button type="button" role="option" tabindex="-1" id="${prefix}-option-${index}" data-ext-choice="${index}" aria-selected="false"><span class="ext-option-mark" aria-hidden="true">${marks[row.item.kind]}</span><span class="ext-option-copy"><strong>${esc(row.label)}</strong><small>${esc(row.description || row.kind)}</small></span><span class="ext-option-kind">${esc(row.kind)}</span></button>`).join('') || `<p class="ext-completion-empty">${esc(entry.error || (entry.loading || entry.items === null ? '正在读取项目扩展…' : record.trigger.symbol === '#' ? '没有可用工具。请先测试 MCP 并允许工具。' : '此项目暂无已启用的命令或可手动调用的 Skill。'))}</p>`}</div><div class="ext-completion-footer"><span>↑ ↓ 选择</span><span>Enter / Tab 确认</span><span>Esc 关闭</span></div>`;
      }
      record.menu.hidden = false;
      record.input.setAttribute('aria-controls', record.menu.id);
      record.input.setAttribute('aria-expanded', 'true');
      markChoice(record, record.index, false);
      positionMenu(record);
    }

    function renderChips(record) {
      const current = record.activeDraft;
      const list = current?.extensionSelections || [];
      const entry = cache(record.pid);
      const html = list
        .map((selection) => {
          const item = entry.items?.find((value) => value.id === selection.id);
          let reason = '';
          if (!item && entry.items !== null) reason = '已不可用';
          else if (item && !item.enabled) reason = '已停用';
          else if (item?.supported === false) reason = '暂不兼容';
          else if (item && item.version !== selection.version) reason = '版本已变化，请重新选择';
          else if (item?.kind === 'mcp') {
            const available = new Set(allowedTools(record.pid, item).map((tool) => tool.name));
            if (!available.size || selection.tools?.some((name) => !available.has(name)))
              reason = '请测试连接或重新选择工具';
          }
          const tools = selection.tools?.length ? ` · ${selection.tools.length} 个工具` : '';
          return `<span class="ext-chip ${reason ? 'ext-chip-unavailable' : ''}" title="${esc(reason || (selection.tools || []).join(', ') || item?.description || '')}"><span aria-hidden="true">${marks[item?.kind] || '+'}</span><span>${esc(item?.name || selection.id)}${esc(tools)}${reason ? `<small>${esc(reason)}</small>` : ''}</span><button type="button" data-ext-action="remove-selection" data-ext-id="${esc(selection.id)}" aria-label="移除 ${esc(item?.name || selection.id)}">×</button></span>`;
        })
        .join('');
      if (record.chips.innerHTML !== html) record.chips.innerHTML = html;
      record.chips.hidden = !list.length;
    }

    function markChoice(record, index, scroll = true) {
      record.index = index;
      for (const option of record.menu.querySelectorAll('[data-ext-choice]')) {
        option.setAttribute('aria-selected', String(Number(option.dataset.extChoice) === index));
      }
      const option = record.menu.querySelector(`[data-ext-choice="${index}"]`);
      if (option) {
        record.input.setAttribute('aria-activedescendant', option.id);
        if (scroll) option.scrollIntoView({ block: 'nearest' });
      } else record.input.removeAttribute('aria-activedescendant');
    }

    function hideMenu(record) {
      record.menu.hidden = true;
      record.input.setAttribute('aria-expanded', 'false');
      record.input.removeAttribute('aria-activedescendant');
    }

    function positionMenu(record) {
      if (record.menu.hidden || !record.input.isConnected) return;
      const rect = record.input.getBoundingClientRect();
      const viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft || 0;
      const topEdge = viewport?.offsetTop || 0;
      const width = viewport?.width || window.innerWidth;
      const height = viewport?.height || window.innerHeight;
      const menuWidth = Math.min(Math.max(rect.width, 320), 520, width - 32);
      const above = rect.top - topEdge - 16;
      const below = topEdge + height - rect.bottom - 16;
      const openAbove = above >= Math.min(280, below);
      const maxHeight = Math.max(100, Math.min(380, openAbove ? above : below));
      Object.assign(record.menu.style, {
        width: `${menuWidth}px`,
        left: `${Math.max(leftEdge + 16, Math.min(rect.left, leftEdge + width - menuWidth - 16))}px`,
        maxHeight: `${maxHeight}px`,
        top: openAbove ? 'auto' : `${rect.bottom + 8}px`,
        bottom: openAbove ? `${window.innerHeight - rect.top + 8}px` : 'auto',
      });
    }

    function choose(record, index) {
      const row = record.rows[index];
      const current = draft();
      const trigger = triggerAt(record.input);
      if (
        !row ||
        !current ||
        current !== record.activeDraft ||
        project()?.id !== record.pid ||
        !trigger ||
        trigger.start !== record.trigger?.start ||
        trigger.word !== record.trigger?.word
      )
        return hideMenu(record);
      const latest = cache(record.pid).items?.find((item) => item.id === row.item.id);
      if (!latest?.enabled || latest.version !== row.item.version || latest.supported === false)
        return updateComposer(record);
      if (latest.kind === 'mcp') {
        const allowed = new Set(allowedTools(record.pid, latest).map((tool) => tool.name));
        if (row.tools.some((name) => !allowed.has(name))) return updateComposer(record);
      }
      if (latest.kind !== 'command') {
        const selections = [...(current.extensionSelections || [])];
        const previous = selections.findIndex((item) => item.id === latest.id);
        const old = selections[previous];
        const selection = { id: latest.id, version: latest.version };
        if (latest.kind === 'mcp') {
          const allowed = new Set(allowedTools(record.pid, latest).map((tool) => tool.name));
          const previousTools =
            old?.version === latest.version
              ? (old.tools || []).filter((name) => allowed.has(name))
              : [];
          selection.tools = [...new Set([...previousTools, ...row.tools])];
        }
        if (previous < 0) selections.push(selection);
        else selections[previous] = selection;
        current.extensionSelections = selections;
      }
      const replacement = latest.kind === 'command' ? `/${latest.name} ` : '';
      record.input.setRangeText(replacement, trigger.start, trigger.end, 'end');
      const caret = trigger.start + replacement.length;
      current.text = record.input.value;
      record.applying = true;
      hideMenu(record);
      try {
        saveDraft();
        record.input.dispatchEvent(new Event('input', { bubbles: true }));
      } finally {
        record.applying = false;
      }
      record.dismissed = completionKey(record);
      renderChips(record);
      // The host may redraw on input. Restore only while this very draft is still active.
      if (draft() === current && record.input.isConnected) {
        record.input.focus({ preventScroll: true });
        record.input.setSelectionRange(caret, caret);
      }
    }

    window.addEventListener('resize', () => {
      if (composer) positionMenu(composer);
    });
    window.addEventListener(
      'scroll',
      () => {
        if (composer) positionMenu(composer);
      },
      true,
    );
    window.visualViewport?.addEventListener('resize', () => {
      if (composer) positionMenu(composer);
    });
    window.visualViewport?.addEventListener('scroll', () => {
      if (composer) positionMenu(composer);
    });

    return { renderPage, renderComposer };
  };
})();

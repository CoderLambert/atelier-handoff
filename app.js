const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v = '') => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const enc = encodeURIComponent;
const markdown = globalThis.markdownit?.({ html: false, linkify: true });
if (markdown) {
 markdown.renderer.rules.image = (tokens, index) => esc(tokens[index].content || '图片');
 markdown.validateLink = url => /^(https?:\/\/|mailto:)/i.test(url);
 markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
 };
 const fence = markdown.renderer.rules.fence;
 markdown.renderer.rules.fence = (tokens, index, options, env, renderer) => {
  const language = tokens[index].info.trim().split(/\s+/)[0] || '代码';
  return `<div class="code-panel"><div class="code-toolbar"><span>${esc(language)}</span><button data-action="copy-code">复制代码</button></div>${fence(tokens, index, options, env, renderer)}</div>`;
 };
 markdown.renderer.rules.table_open = () => '<div class="table-scroll" tabindex="0" role="region" aria-label="表格"><table>';
 markdown.renderer.rules.table_close = () => '</table></div>';
}
const active = r => r && ['queued','running','awaiting_permission','stopping'].includes(r.status);
const labels = {queued:'排队中',running:'执行中',awaiting_permission:'等待审批',stopping:'正在停止',completed:'已完成',stopped:'已停止',failed:'失败',interrupted:'已中断',pending:'待审批',allowed:'已允许',denied:'已拒绝',expired:'已过期',canceled:'已取消',archived:'已归档',active:'进行中'};
const state = {token:'', cursor:0, projects:[], sessions:[], runs:[], artifacts:[], snapshot:null, current:null, view:'chat', tab:'conversation', side:'context', config:{}, connection:{}, drafts:new Map(), saving:new Map(), pending:new Map(), uploading:new Map(), sse:false, search:'', dialogTrigger:null};
let refreshTimer, searchTimer, toastTimer, source, unseen = false, listSequence=0, snapshotSequence=0, drawerTrigger=null;
const pages={sessions:0,runs:0,artifacts:0}, pageInfo={}, filters={runStatus:'',projectId:'',sessionId:''}, deleted=new Set(), openTools=new Set(), submitting=new Set();
const storage={get:key=>{try{return localStorage.getItem(key);}catch{return null;}},set:(key,value)=>{try{localStorage.setItem(key,value);}catch{}},remove:key=>{try{localStorage.removeItem(key);}catch{}}};
function toast(message) { const el=$('#toast'); el.textContent=message; el.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.hidden=true,4500); }
async function api(path, options={}) {
 const init={method:options.method || 'GET', headers:{}, signal:options.signal};
 if(init.method!=='GET') { init.headers={'Content-Type':'application/json','X-Atelier-Token':state.token}; init.body=JSON.stringify(options.body || {}); }
 let response; try { response=await fetch(path,init); } catch { throw new Error('网络连接失败，请检查本地服务。'); }
 const data=await response.json().catch(()=>({}));
 if(response.status===403 && data.error?.code==='TOKEN_REQUIRED' && !options.tokenRetried) { const fresh=await api('/api/bootstrap'); state.token=fresh.csrfToken; return api(path,{...options,tokenRetried:true}); }
 if(!response.ok) { const error=new Error(data.error?.message || `请求失败 (${response.status})`); error.code=data.error?.code; error.status=response.status; throw error; } return data;
}
const items = data => Array.isArray(data) ? data : data?.items || [];
const draftDefault = () => ({text:'',contextPaths:[],attachmentIds:[],mode:'readonly'});
function getDraft(id=state.current) { if(!state.drafts.has(id)) { let saved; try { saved=JSON.parse(storage.get('atelier-draft:'+id)); } catch {} state.drafts.set(id,{...draftDefault(),...((state.snapshot?.session?.id===id ? state.snapshot.session : state.sessions.find(s=>s.id===id))?.draft || {}),...saved}); } return state.drafts.get(id); }
function persistDraft(id=state.current) { if(!id || deleted.has(id)) return; const d=getDraft(id); storage.set('atelier-draft:'+id,JSON.stringify(d)); clearTimeout(state.saving.get(id)); state.saving.set(id,setTimeout(async()=>{ state.saving.delete(id); if(deleted.has(id)) return; const copy=JSON.stringify(d); try { await api('/api/sessions/'+enc(id),{method:'PATCH',body:{draft:JSON.parse(copy)}}); if(!deleted.has(id) && JSON.stringify(getDraft(id))===copy) storage.remove('atelier-draft:'+id); } catch(e) { if(!deleted.has(id)) toast('草稿已尝试保存在本机：'+e.message); } },500)); }
async function refreshLists() { const seq=++listSequence; const [s,r,a,...running]=await Promise.all([api('/api/sessions?includeArchived=true&query='+enc(state.search)+'&limit=50&offset='+pages.sessions),api('/api/runs?limit=50&offset='+pages.runs+'&status='+enc(filters.runStatus)),api('/api/artifacts?limit=50&offset='+pages.artifacts+'&projectId='+enc(filters.projectId)+'&sessionId='+enc(filters.sessionId)),...['queued','running','awaiting_permission','stopping'].map(status=>api('/api/runs?limit=500&status='+status))]); if(seq!==listSequence)return; state.sessions=items(s); state.runs=items(r); state.artifacts=items(a); state.activeRuns=running.flatMap(items); Object.assign(pageInfo,{sessions:s,runs:r,artifacts:a}); }
async function loadSnapshot(id=state.current) { const seq=++snapshotSequence; if(!id) { state.snapshot=null; return; } const data=await api('/api/sessions/'+enc(id)); if(seq!==snapshotSequence || state.current!==id) return; state.snapshot=data; if(!state.drafts.has(id)) getDraft(id); const dialog=$('#detail-dialog'), permissionId=dialog.dataset.permissionId; if(dialog.open && permissionId) { const permission=(data.permissions || []).find(p=>p.id===permissionId); if(!permission || permission.status!=='pending') { closeDialog(); toast('审批状态已变化，请重新查看'); } } }
async function refresh() { await Promise.all([refreshLists(),loadSnapshot()]); render(); }
function scheduleRefresh() { if(refreshTimer) return; refreshTimer=setTimeout(()=>{refreshTimer=null;refresh().catch(e=>toast(e.message));},250); }
function connect() {
 source?.close();
 source = new EventSource('/api/events?after=' + enc(state.cursor));
 source.onopen = () => {
  state.sse = true;
  renderConnection();
  api('/api/bootstrap').then(bootstrap => {
   state.token = bootstrap.csrfToken;
   state.projects = bootstrap.projects || [];
   state.config = bootstrap.config || state.config;
   state.connection = bootstrap.connection || {};
   scheduleRefresh();
  }).catch(error => toast(error.message));
 };
 source.onerror = () => { state.sse = false; renderConnection(); };
 source.addEventListener('cursor-reset', event => {
  state.cursor = Number(event.lastEventId);
  traceCache.clear();
  scheduleRefresh();
 });
 source.onmessage = event => {
  const id = Number(event.lastEventId);
  if (id && id <= state.cursor) return;
  if (id) state.cursor = id;
  scheduleRefresh();
 };
}
function renderConnection() { const el=$('.connection-state'); el.textContent=state.sse?'事件流已连接':'事件流重连中'; el.title=state.connection.message || ''; }
function badge(status) { return `<span class="status-badge ${status==='failed'?'error':status==='completed'?'success':active({status})?'running':'neutral'}"><span class="status-dot"></span>${esc(labels[status] || status || '准备就绪')}</span>`; }
function currentProject() { return state.snapshot?.project || state.projects.find(p=>p.id===state.sessions.find(s=>s.id===state.current)?.projectId); }
function currentRun() { return state.snapshot?.runs?.find(r=>r.id===state.selectedRun) || state.snapshot?.runs?.find(active) || state.snapshot?.runs?.at(-1); }
function date(value) { return value ? new Date(value).toLocaleString('zh-CN') : ''; }
function renderHistory() {
 $('#session-count').textContent=pageInfo.sessions?.total ?? state.sessions.length; $('#deliverable-count').textContent=pageInfo.artifacts?.total ?? state.artifacts.length;
 $('#history-list').innerHTML=state.sessions.length?state.sessions.map(s=>`<button class="history-item ${s.id===state.current&&state.view==='chat'?'selected':''}" data-action="session" data-id="${esc(s.id)}"><span class="history-title od-truncate">${esc(s.title || '新会话')}</span><span class="history-meta">${esc(labels[(state.activeRuns || []).find(r=>r.sessionId===s.id)?.status] || (s.status==='archived'?'已归档':date(s.updatedAt)))}</span></button>`).join(''):'<p class="search-empty">没有会话</p>';
 $('#history-list').insertAdjacentHTML('beforeend',pagination('sessions'));
 $$('.nav-item[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===state.view);b.setAttribute('aria-current',b.dataset.view===state.view?'page':'false');});
}
function render() {
 renderHistory(); renderConnection(); $('#composer-model').textContent=state.config.model || '模型设置'; const snap=state.snapshot, s=snap?.session, p=currentProject(), run=currentRun();
 $('#workspace-name').textContent=p?.name || '绑定项目'; $('#workspace-branch').textContent=p?.branch || '本地目录'; $('#breadcrumb-project').textContent=p?.name || '工作空间'; $('#breadcrumb-session').textContent=state.view==='chat'?(s?.title || '新会话'):state.view==='runs'?'执行记录':'交付物';
 $('#conversation-screen').hidden=state.view!=='chat'; $('#collection-screen').hidden=state.view==='chat';
 if(state.view!=='chat') renderCollection(); else {
  $('#session-title').textContent=s?.title || '开始工作'; $('#session-status').innerHTML=run?badge(run.status):''; $('#session-branch').textContent=p?.branch || ''; $('#session-runtime').textContent=s?.status==='archived'?'已归档':'本地工作空间'; $('#stage-hint').textContent=run?labels[run.status] || run.status:'';
  $('#trace-count').textContent=snap?.tools?.length || 0; $('#artifact-count').textContent=snap?.artifacts?.length || 0;
  $$('.session-tab').forEach(b=>{let on=b.dataset.tab===state.tab;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on)); b.tabIndex=on?0:-1;});
  renderConversation(); renderComposer();
 }
 renderAside();
}
const traceCache = new Map();
const eventNames = {
 'run.created':'创建运行', 'run.status_changed':'运行状态更新', 'run.finished':'运行结束',
 'process.spawned':'启动 SDK 进程', 'process.exited':'SDK 进程退出', 'sdk.initialized':'SDK 初始化',
 'sdk.first_text':'收到首段文本', 'sdk.api_retry':'模型请求重试', 'sdk.error':'SDK 错误',
 'sdk.result':'SDK 返回结果', 'sdk.notice':'SDK 通知', 'sdk.context_restarted':'重新建立 SDK 上下文',
 'tool.started':'工具开始', 'tool.finished':'工具结束', 'tool.blocked':'工具被拦截', 'permission.requested':'等待审批',
 'permission.resolved':'审批结束', 'usage.updated':'用量已更新', 'plan.updated':'计划已更新', 'artifact.created':'交付物已生成',
};
function elapsed(ms) {
 if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
 return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} 秒`;
}
function traceEvents(snap, run) {
 const recent = snap.events.filter(event => event.runId === run.id);
 const revision = recent.at(-1)?.id ?? 0;
 let cached = traceCache.get(run.id);
 if (cached?.revision !== revision) {
  cached = { revision, data: cached?.data };
  traceCache.set(run.id, cached);
  const request = cached;
  api(`/api/runs/${enc(run.id)}/trace`).then(data => { request.data = data; }).catch(error => {
   request.error = error.message;
  }).finally(() => {
   if (traceCache.get(run.id) === request && state.tab === 'trace' && currentRun()?.id === run.id) renderConversation();
  });
 }
 return { events: cached.data?.events ?? recent.filter(event => event.type !== 'message.delta'), total: cached.data?.eventCount, error: cached.error };
}
function renderConversation() {
 const el=$('#conversation-content'), snap=state.snapshot, oldScroll=el.scrollTop, near=el.scrollHeight-el.scrollTop-el.clientHeight<100;
 if(!snap) {el.innerHTML='<div class="welcome"><h2>开始你的工作</h2><p>绑定本机项目目录，然后新建会话。</p><button class="btn btn-primary" data-action="project">绑定项目</button></div>';return;}
 if (state.tab === 'trace') {
  const run = currentRun();
  if (!run) { el.innerHTML = '<p class="empty-text">发送任务后，这里会显示本轮调用详情。</p>'; return; }
  const tools = snap.tools.filter(tool => tool.runId === run.id);
  const { events, total, error } = traceEvents(snap, run);
  const result = events.findLast(event => event.type === 'sdk.result')?.payload;
  const init = events.findLast(event => event.type === 'sdk.initialized')?.payload;
  const exit = events.findLast(event => event.type === 'process.exited')?.payload;
  const firstText = events.find(event => event.type === 'sdk.first_text')?.payload;
  const retries = events.filter(event => event.type === 'sdk.api_retry').length;
  const duration = run.startedAt && run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : null;
  let gateway = '—';
  try { gateway = new URL(run.config.gateway).origin; } catch { /* Older or invalid configuration. */ }
  const facts = [
   ['模型', init?.model ?? run.config?.model], ['网关', gateway],
   ['权限模式', run.mode === 'edit' ? '受控修改' : '只读'], ['SDK CLI', init?.version],
   ['开始时间', date(run.startedAt)], ['结束时间', date(run.endedAt)],
   ['总耗时', elapsed(duration)], ['首段文本', elapsed(firstText?.elapsedMs)],
   ['API 耗时', elapsed(result?.apiDurationMs)], ['SDK 轮次', result?.turns],
   ['HTTP 状态', result?.httpStatus], ['停止原因', result?.terminalReason || result?.stopReason || run.reason],
   ['进程退出', exit ? (exit.signal || (exit.code ?? '—')) : null],
   ['输入 / 输出 tokens', run.usage ? `${run.usage.inputTokens ?? '—'} / ${run.usage.outputTokens ?? '—'}` : null],
   ['已记录重试', retries || (result ? 0 : null)], ['运行 ID', run.id],
  ];
  const pickerFocused = document.activeElement === $('#trace-run', el);
  const toolLabels = {Read:'读取文件', list_files:'列出文件', search_files:'搜索项目', edit_file:'编辑文件', write_file:'写入文件', delete_file:'删除文件', run_command:'运行命令', update_plan:'更新计划', publish_artifact:'发布交付物'};
  el.innerHTML = `<section class="trace-overview">
   <div class="trace-run-bar"><label for="trace-run">运行</label><select id="trace-run">${snap.runs.slice().reverse().map(item => `<option value="${esc(item.id)}" ${item.id === run.id ? 'selected' : ''}>${esc(date(item.createdAt))} · ${esc(item.prompt?.slice(0, 42) || '运行')}</option>`).join('')}</select>${badge(run.status)}<a class="btn btn-secondary trace-download" href="/api/runs/${enc(run.id)}/diagnostics.json" download>下载诊断 JSON</a></div>
   ${run.error ? `<p class="trace-error" role="status">${esc(run.error)}</p>` : ''}
   <dl class="trace-facts">${facts.map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value === '' || value == null ? '—' : value)}</dd></div>`).join('')}</dl>
   </section><div class="trace-heading"><h2>工具调用 <span class="count-badge">${tools.length}</span></h2></div>${tools.map(tool => {
   const name = tool.name.replace(/^mcp__atelier__/, '');
   return `<details class="trace-item" data-tool="${esc(tool.id)}" ${openTools.has(tool.id) ? 'open' : ''}>
    <summary><strong>${esc(toolLabels[name] || name)}</strong>${badge(tool.status)}</summary>
    <p class="trace-label">${esc(tool.id)} · ${esc(date(tool.startedAt))} · ${elapsed(tool.endedAt ? Date.parse(tool.endedAt) - Date.parse(tool.startedAt) : null)}</p>
    <p class="trace-label">参数</p><pre>${esc(tool.inputSummary)}</pre>
    ${tool.output ? `<p class="trace-label">输出</p><pre>${esc(tool.output)}</pre>` : ''}
    ${tool.outputTruncated ? `<button class="btn btn-secondary" data-action="tool-output" data-id="${esc(tool.id)}">查看完整输出</button>` : ''}</details>`;
  }).join('') || '<p class="empty-text">本会话还没有调用工具。</p>'}
   <details class="trace-item trace-events" ${openTools.has('events:' + run.id) ? 'open' : ''} data-tool="${esc('events:' + run.id)}">
    <summary><strong>运行事件</strong> <span class="count-badge">${events.length}</span></summary>
    ${error ? `<p class="trace-error">${esc(error)}</p>` : ''}
    ${total > events.length ? `<p class="trace-label">共 ${total} 条。已折叠文本增量，最多显示最近 600 条诊断事件。</p>` : ''}
    ${events.map(event => `<details class="trace-event" data-tool="event:${event.id}" ${openTools.has('event:' + event.id) ? 'open' : ''}>
     <summary><span>${esc(eventNames[event.type] || event.type)}</span><time datetime="${esc(event.at)}">${esc(date(event.at))}</time></summary>
     <pre>${esc(JSON.stringify({ event: event.type, sequence: event.seq, timestamp: event.at, ...event.payload }, null, 2))}</pre>
    </details>`).join('') || '<p class="muted">暂无运行事件</p>'}
   </details>`;
  if (pickerFocused) $('#trace-run', el)?.focus({preventScroll:true});
  el.scrollTop = oldScroll;
  return;
 }
 if(state.tab==='artifacts') {el.innerHTML=artifactList(snap.artifacts || []);return;}
 const messages = snap.messages || [];
 if (!messages.length) {
  el.innerHTML = '<div class="welcome"><h2>这次想做什么？</h2><p>描述任务，或先添加要讨论的项目文件。</p></div>';
  return;
 }
 let thread = $('.message-thread', el);
 const fresh = !thread || thread.dataset.sessionId !== snap.session.id;
 if (fresh) {
  thread = document.createElement('div');
  thread.className = 'message-thread';
  thread.dataset.sessionId = snap.session.id;
  el.replaceChildren(thread);
 }
 const existing = new Map(Array.from(thread.children, node => [node.dataset.messageId, node]));
 const runs = new Map(snap.runs.map(run => [run.id, run]));
 let changed = false;
 for (const [index, message] of messages.entries()) {
  const assistant = message.role === 'assistant';
  let row = existing.get(message.id);
  existing.delete(message.id);
  if (!row) {
   row = document.createElement('article');
   row.className = `message ${assistant ? 'assistant-message' : 'user-message'}`;
   row.dataset.messageId = message.id;
   row.dataset.runId = message.runId;
   row.innerHTML = `<div class="avatar ${assistant ? 'ai-avatar' : 'user-avatar'}" aria-hidden="true">${assistant ? '✳' : '我'}</div>
    <div class="message-body"><div class="message-meta"><strong>${assistant ? 'atelier' : '你'}</strong><time datetime="${esc(message.createdAt)}">${esc(date(message.createdAt))}</time></div><div class="${assistant ? 'markdown-body' : 'message-text'}"></div></div>`;
  }
  if (thread.children[index] !== row) thread.insertBefore(row, thread.children[index] || null);
  row.classList.toggle('selected-run', state.selectedRun === message.runId);
  const content = $('.markdown-body, .message-text', row);
  const text = message.text || '';
  const run = runs.get(message.runId);
  if (!assistant && run) {
   const files = (run.contextPaths || []).map(path => ['项目文件', path]);
   for (const id of run.attachmentIds || []) {
    const attachment = snap.attachments.find(item => item.id === id);
    files.push(['附件', attachment?.name || id]);
   }
   const references = JSON.stringify(files);
   if (row.dataset.references !== references) {
    $('.message-context', row)?.remove();
    if (files.length) {
     const list = document.createElement('ul');
     list.className = 'message-context';
     list.setAttribute('aria-label', '本轮已读取的上下文');
     for (const [kind, name] of files) {
      const item = document.createElement('li');
      item.textContent = `已读取 · ${kind} · ${name}`;
      list.append(item);
     }
     content.after(list);
    }
    row.dataset.references = references;
   }
  }
  const placeholder = assistant && !text ? (active(run) ? (run.status === 'awaiting_permission' ? '等待你确认操作…' : '正在处理…') : '本轮没有文字回复') : '';
  const value = text || placeholder;
  if (content.renderedText === value && content.renderedPlaceholder === Boolean(placeholder)) continue;
  changed ||= Boolean(text);
  content.renderedText = value;
  content.renderedPlaceholder = Boolean(placeholder);
  content.classList.toggle('message-placeholder', Boolean(placeholder));
  if (assistant && text && markdown) content.innerHTML = markdown.render(text);
  else content.textContent = value;
 }
 for (const row of existing.values()) row.remove();
 if (near || fresh) { if (changed || fresh) el.scrollTop = el.scrollHeight; unseen = false; }
 else { el.scrollTop = oldScroll; if (changed) unseen = true; }
 const jump = $('.new-messages', el);
 if (unseen && !jump) el.insertAdjacentHTML('beforeend','<button class="new-messages btn btn-secondary" data-action="scroll-bottom">查看新消息 ↓</button>');
 else if (!unseen) jump?.remove();
}
function renderComposer() {
 const s=state.snapshot?.session, d=s?getDraft(s.id):draftDefault(); const input=$('#prompt-input'); if((input.dataset.sessionId!==s?.id || document.activeElement!==input) && input.value!==d.text) input.value=d.text; input.dataset.sessionId=s?.id || '';
 const run = state.snapshot?.runs?.find(active);
 const sending = submitting.has(s?.id);
 input.disabled = !s || s.status === 'archived';
 $('#send-button').disabled = input.disabled || !d.text.trim() || Boolean(run) || sending;
 const stop = $('#composer-stop');
 stop.hidden = !run;
 stop.disabled = run?.status === 'stopping';
 stop.dataset.id = run?.id || '';
 const progress = $('#composer-run-status');
 const label = sending ? '正在发送…' : run ? labels[run.status] : '';
 if (progress.textContent !== label) progress.textContent = label;
 progress.hidden = !label;
 $('#composer-policy').textContent=d.mode==='edit'?'受控修改 · 逐次审批':'只读'; $('#mode-toggle').textContent=d.mode==='edit'?'模式：受控修改（逐次审批）':'模式：只读'; $('#mode-toggle').setAttribute('aria-pressed',String(d.mode==='edit')); $('#mode-toggle').disabled=!s;
 const attachments=state.snapshot?.attachments || []; const upload=state.uploading.get(s?.id) || [];
 $('#context-chips').innerHTML=d.contextPaths.map(p=>`<button class="context-chip" data-action="remove-context" data-path="${esc(p)}" title="移除">上下文 · ${esc(p)} ×</button>`).join('')+d.attachmentIds.map(id=>{const a=attachments.find(x=>x.id===id);return `<button class="context-chip" data-action="remove-attachment" data-id="${esc(id)}" title="移除">附件 · ${esc(a?.name || id)} · 已附加 ×</button>`;}).join('')+upload.map((x,i)=>`<button class="context-chip" data-action="dismiss-upload" data-id="${i}">${esc(x.name)} · ${esc(x.status)}${x.status.startsWith('失败')?' ×':''}</button>`).join('');
}
function artifactList(list) {return list.length?list.map(a=>`<button class="artifact-card" data-action="artifact" data-id="${esc(a.id)}"><span class="file-tile">▤</span><span class="od-field od-fill"><strong>${esc(a.name)}</strong><span>${esc(a.availability)} · ${esc(date(a.createdAt))}</span></span><span>预览 ›</span></button>`).join(''):'<p class="empty-text">暂无交付物</p>';}
function pagination(kind) { const info=pageInfo[kind]; if(!info || (info.total<=50 && !pages[kind])) return ''; return `<div class="pagination"><button class="btn btn-secondary" data-action="page" data-kind="${kind}" data-offset="${Math.max(0,pages[kind]-50)}" ${pages[kind]===0?'disabled':''}>上一页</button><span>${pages[kind]+1}–${Math.min(pages[kind]+50,info.total)} / ${info.total}</span><button class="btn btn-secondary" data-action="page" data-kind="${kind}" data-offset="${info.nextOffset ?? pages[kind]}" ${info.nextOffset==null?'disabled':''}>下一页</button></div>`; }
function renderCollection() { const el=$('#collection-screen'); if(state.view==='artifacts') el.innerHTML=`<div class="collection-head"><h1>交付物</h1><p>来自所有会话的成果</p></div><div class="collection-filters"><label>项目 <select id="filter-project"><option value="">全部项目</option>${state.projects.map(p=>`<option value="${esc(p.id)}" ${filters.projectId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label>会话 ID <input id="filter-session" value="${esc(filters.sessionId)}" placeholder="全部会话"></label><button class="btn btn-secondary" data-action="artifact-filter">筛选</button></div>`+artifactList(state.artifacts)+pagination('artifacts'); else el.innerHTML=`<div class="collection-head"><h1>执行记录</h1><p>每轮运行独立记录</p></div><label>状态 <select id="filter-status"><option value="">全部状态</option>${['queued','running','awaiting_permission','stopping','completed','stopped','failed','interrupted'].map(x=>`<option value="${x}" ${filters.runStatus===x?'selected':''}>${labels[x]}</option>`).join('')}</select></label><div class="run-list">`+(state.runs.map(r=>`<button class="run-row" data-action="run-source" data-id="${esc(r.sessionId)}" data-run="${esc(r.id)}"><span class="od-field od-fill"><strong>${esc(r.prompt || '运行')}</strong><span>${esc(date(r.createdAt))}</span></span>${badge(r.status)}</button>`).join('') || '<p class="empty-text">暂无运行记录</p>')+'</div>'+pagination('runs'); }
function renderUsage(run) {
 const usage = run?.usage;
 if (!usage) return '<p class="muted">用量暂无。</p>';
 const values = [
  ['模型', usage.model], ['输入 tokens', usage.inputTokens], ['输出 tokens', usage.outputTokens],
  ['缓存读取 tokens', usage.cacheReadTokens], ['缓存写入 tokens', usage.cacheCreationTokens],
 ];
 const estimate = Number.isFinite(usage.sdkEstimateUsd) ? `$${Number(usage.sdkEstimateUsd).toFixed(6)} USD` : '暂无';
 return `<dl class="trace-facts">${values.map(([label,value]) => `<div><dt>${label}</dt><dd>${esc(value ?? '暂无')}</dd></div>`).join('')}</dl>
  <p class="aside-description">${usage.complete ? '本轮报告' : '本轮用量报告不完整'} · SDK 估算 ${estimate} · 网关实际费用未知</p>`;
}
function renderAside() {
 const snap=state.snapshot, run=currentRun(), p=currentProject(), el=$('#aside-body'); $$('.aside-tab').forEach(b=>{let on=b.dataset.side===state.side;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;});
 if(!snap) {el.innerHTML='<p class="empty-text">选择会话查看详情</p>';return;}
 const permissions=(snap.permissions || []).filter(x=>x.status==='pending');
 const cards=permissions.map(x=>`<div class="approval-card"><div class="approval-eyebrow">需要你的决定</div><div class="approval-title">${esc(x.kind)} ${esc(x.path || x.command || '')}</div><button class="diff-link" data-action="permission" data-id="${esc(x.id)}">查看详情与审批 ›</button></div>`).join('');
 if(state.side==='changes') el.innerHTML=(snap.permissions || []).map(x=>`<div class="approval-card"><div class="approval-eyebrow">${esc(labels[x.status] || x.status)}</div><div class="approval-title">${esc(x.kind)} ${esc(x.path || x.command || '')}</div><button class="diff-link" data-action="permission" data-id="${esc(x.id)}">查看真实差异 ›</button></div>`).join('') || '<p class="empty-text">暂无操作记录</p>';
 else if(state.side==='events') el.innerHTML=(snap.events || []).slice().reverse().map(e=>`<div class="event-list"><div><span>${esc(date(e.at))}</span><span>${esc(e.type)}</span></div></div>`).join('') || '<p class="empty-text">暂无事件</p>';
 else {el.innerHTML=cards+`<section class="aside-section"><div class="section-label">项目</div><strong>${esc(p?.name || '')}</strong><div class="project-path">${esc(p?.path || '')}</div></section><section class="aside-section"><div class="section-label">当前运行</div>${run?badge(run.status):'暂无运行'}<p class="aside-description">${esc(run?.error?.message || run?.error || run?.reason || '')}</p><div class="action-row">${active(run)?`<button class="btn btn-secondary" data-action="stop" data-id="${esc(run.id)}">停止</button>`:''}${run&&['failed','stopped','interrupted'].includes(run.status)?`<button class="btn btn-secondary" data-action="retry" data-id="${esc(run.id)}">只读重试</button>`:''}</div></section>${run?.plan?.length?`<section class="aside-section"><div class="section-label">计划</div>${run.plan.map(x=>`<p>${esc(({pending:'待执行',in_progress:'进行中',completed:'已完成'})[x.status] || x.status)} · ${esc(x.content)}</p>`).join('')}</section>`:''}<section class="aside-section"><div class="section-label">用量</div>${renderUsage(run)}</section><section class="aside-section"><div class="section-label">会话管理</div><div class="action-row"><button class="btn btn-secondary" data-action="rename">重命名</button><button class="btn btn-secondary" data-action="archive">${snap.session.status==='archived'?'恢复':'归档'}</button><button class="btn btn-secondary" data-action="delete-session">删除</button></div></section>`; }
}
function openDialog(title, html, wide=false) {if(!$('#detail-dialog').open) state.dialogTrigger=document.activeElement; delete $('#detail-dialog').dataset.permissionId; $('#dialog-title').textContent=title; $('#dialog-body').innerHTML=html; const d=$('#detail-dialog'); d.classList.toggle('wide-dialog',wide); if(!d.open)d.showModal();}
function closeDialog() { $('#detail-dialog').close(); }
$('#detail-dialog').addEventListener('close',()=>{ const target=state.dialogTrigger; if(target?.isConnected && target.getClientRects().length && !target.closest('[inert]')) target.focus(); else (document.querySelector('.main:not([inert]) [data-action="new"]') || document.querySelector('.sidebar:not([inert]) [data-action="new"]') || document.querySelector('.main:not([inert]) [data-action="toggle-aside"]') || $('#prompt-input')).focus(); });
async function switchSession(id) {
 if ($('#detail-dialog').open) closeDialog();
 if (state.current) persistDraft();
 state.current = id;
 state.snapshot = null;
 storage.set('atelier-last-session', id);
 state.view = 'chat';
 state.tab = 'conversation';
 closeDrawers();
 render();
 await loadSnapshot(id);
 if (state.current === id) render();
}
function closeDrawers() {const hadDrawer=document.body.classList.contains('nav-open') || document.body.classList.contains('drawer-aside'); document.body.classList.remove('nav-open','drawer-aside'); if(innerWidth<1024) document.body.classList.add('aside-closed'); setInert(); if(hadDrawer && drawerTrigger?.isConnected && drawerTrigger.getClientRects().length) drawerTrigger.focus();}
function setInert() {const nav=document.body.classList.contains('nav-open'), aside=document.body.classList.contains('drawer-aside'); $('.main').inert=nav||aside; $('.sidebar').inert=aside; $('.right-panel').inert=nav; $('.nav-scrim').style.display=aside?'block':''; $('.mobile-menu').setAttribute('aria-expanded',String(nav)); $$('.topbar [data-action=toggle-aside]').forEach(b=>b.setAttribute('aria-expanded',String(innerWidth<1024?aside:!document.body.classList.contains('aside-closed'))));}
async function projectDialog() {
 openDialog('项目目录',`
  <button class="btn btn-secondary" data-action="pick-project-directory" autofocus>选择文件夹…</button>
  <p id="project-picker-status" role="status" class="muted"></p>
  <label>目录路径（也可手动输入）<input id="project-path" class="field" placeholder="/home/your/project"></label>
  <div class="dialog-actions"><button class="btn btn-primary" data-action="bind-project">绑定项目</button></div>
  <div class="context-options">${state.projects.map(p=>`<button class="context-option" data-action="choose-project" data-id="${esc(p.id)}">${esc(p.name)} · ${esc(p.path)}</button>`).join('')}</div>`);
}
async function chooseProjectDirectory(button) {
 const dialog = $('#detail-dialog');
 const input = $('#project-path');
 const status = $('#project-picker-status');
 const controller = new AbortController();
 const cancel = () => controller.abort();
 dialog.addEventListener('close', cancel, { once: true });
 button.disabled = true;
 status.textContent = '请在系统窗口中选择文件夹。';
 try {
  const {path} = await api('/api/projects/pick-directory', {method:'POST', signal:controller.signal});
  if (!input.isConnected || !dialog.open) return;
  status.textContent = '';
  if (path !== null) {
   input.value = path;
   $('[data-action=bind-project]', dialog).focus();
  } else {
   button.disabled = false;
   button.focus();
  }
 } catch (error) {
  if (input.isConnected && dialog.open && !controller.signal.aborted) {
   status.textContent = error.message;
   input.focus();
  }
 } finally {
  dialog.removeEventListener('close', cancel);
  button.disabled = false;
 }
}
async function browse(path='') {const sessionId=state.current, p=state.snapshot?.project; if(!p) return toast('请先选择会话'); const data=await api(`/api/projects/${enc(p.id)}/files?path=${enc(path)}`); if(state.current!==sessionId) return; openDialog('选择项目上下文',`<div class="dialog-actions"><button class="btn btn-secondary" data-action="browse" data-path="${esc(path.split('/').slice(0,-1).join('/'))}">上一级</button><span>${esc(path || '/')}</span></div><div class="context-options">${data.items.map(f=>`<div class="file-choice"><button class="context-option" data-action="${f.isDirectory?'browse':'preview-file'}" data-path="${esc(f.path)}">${f.isDirectory?'📁':'▤'} ${esc(f.name)}</button>${!f.isDirectory?`<button class="btn btn-secondary" data-action="select-context" data-path="${esc(f.path)}">选择</button>`:''}</div>`).join('') || '<p>目录为空</p>'}</div>`,true); }
async function settings() { const data=await api('/api/config'); state.config=data.config; state.connection=data.connection || {}; const c=state.config; openDialog('模型与网关设置',`<p class="settings-intro">${esc(state.connection.message || '')}</p><label>网关<input class="field" id="config-gateway" value="${esc(c.gateway)}"></label><label>模型<input class="field" id="config-model" value="${esc(c.model)}"></label><label>最大轮数<input class="field" type="number" id="config-turns" value="${esc(c.maxTurns)}"></label><label>超时（毫秒）<input class="field" type="number" id="config-timeout" value="${esc(c.timeoutMs)}"></label><div class="dialog-actions"><button class="btn btn-primary" data-action="save-settings">保存</button></div>`); }
async function send() {
 const id = state.current;
 if (!id || $('#send-button').disabled || submitting.has(id)) return;
 const draft = getDraft(id);
 if ((state.uploading.get(id) || []).some(item => item.status === '上传中')) return toast('请等待附件上传完成');
 const payload = structuredClone(draft);
 const fingerprint = JSON.stringify(payload);
 let pending = state.pending.get(id);
 if (pending?.fingerprint !== fingerprint) {
  pending = { fingerprint, key: crypto.randomUUID() };
  state.pending.set(id, pending);
 }
 submitting.add(id);
 renderComposer();
 try {
  await api(`/api/sessions/${enc(id)}/messages`, {method:'POST', body:{...payload, idempotencyKey:pending.key}});
 } catch (error) {
  toast('发送未确认，可使用相同内容重试：' + error.message);
  return;
 } finally {
  submitting.delete(id);
  if (id === state.current) renderComposer();
 }
 state.pending.delete(id);
 if (JSON.stringify(draft) === fingerprint) {
  Object.assign(draft, draftDefault(), {mode:draft.mode});
  if (id === state.current) $('#prompt-input').value = '';
  persistDraft(id);
 }
 if (id === state.current) { state.selectedRun = null; renderComposer(); }
 await refresh();
}
async function upload(files) {const id=state.current;if(!id)return toast('请先选择会话'); const list=state.uploading.get(id)||[]; state.uploading.set(id,list); for(const file of files) {const entry={name:file.name,status:'上传中'};list.push(entry);renderComposer();try {if(file.size>1048576 || !/\.(txt|md|json|csv|js|ts|jsx|tsx|css|html|yaml|yml|log|py)$/i.test(file.name)) throw new Error('仅支持 1 MiB 以内的文本文件'); const bytes=new Uint8Array(await file.arrayBuffer()); new TextDecoder('utf-8',{fatal:true}).decode(bytes); let binary=''; for(let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192)); const res=await api(`/api/sessions/${enc(id)}/attachments`,{method:'POST',body:{name:file.name,mime:file.type || 'text/plain',contentBase64:btoa(binary)}}); getDraft(id).attachmentIds.push(res.attachment.id);persistDraft(id);list.splice(list.indexOf(entry),1); if(id===state.current) await loadSnapshot(id); } catch(e) {entry.status='失败：'+e.message;} if(id===state.current)renderComposer();} }
document.addEventListener('click',async e=>{const b=e.target.closest('[data-action]');if(!b)return; const a=b.dataset.action, id=b.dataset.id, path=b.dataset.path; try {
 if(a==='copy-code') {
  const code = $('pre code', b.closest('.code-panel'));
  if (code) { await navigator.clipboard.writeText(code.textContent); toast('代码已复制'); }
 }
 else if(a==='close') closeDialog();
 else if(a==='project') await projectDialog();
 else if(a==='pick-project-directory') await chooseProjectDirectory(b);
 else if(a==='bind-project') {state.selectedRun=null;const result=await api('/api/projects',{method:'POST',body:{path:$('#project-path').value.trim()}}); state.projects.push(result.project); closeDialog(); const s=await api('/api/sessions',{method:'POST',body:{projectId:result.project.id}});await refreshLists();await switchSession(s.session.id);}
 else if(a==='choose-project') {state.selectedRun=null;closeDialog();const s=await api('/api/sessions',{method:'POST',body:{projectId:id}});await refreshLists();await switchSession(s.session.id);}
 else if(a==='new') {state.selectedRun=null;const p=currentProject() || state.projects[0]; if(!p)return projectDialog(); const result=await api('/api/sessions',{method:'POST',body:{projectId:p.id}});await refreshLists();await switchSession(result.session.id);}
 else if(a==='session'||a==='run-source') {state.selectedRun=a==='run-source'?b.dataset.run:null; await switchSession(id); if(state.selectedRun) {const target=$$('.message[data-run-id]').find(el=>el.dataset.runId===state.selectedRun); if(target) target.scrollIntoView({block:'center'}); else toast('已选择来源运行；该轮暂无消息');}}
 else if(a==='page') {pages[b.dataset.kind]=Number(b.dataset.offset);await refreshLists();render();}
 else if(a==='artifact-filter') {filters.projectId=$('#filter-project').value;filters.sessionId=$('#filter-session').value.trim();pages.artifacts=0;await refreshLists();render();}
 else if(a==='view') {state.view=b.dataset.view;closeDrawers();await refreshLists();render();}
 else if(a==='tab') {state.tab=b.dataset.tab;render();}
 else if(a==='side') {state.side=b.dataset.side;renderAside();}
 else if(a==='menu') {drawerTrigger=b;document.body.classList.remove('drawer-aside');document.body.classList.add('aside-closed');document.body.classList.toggle('nav-open');setInert();if(document.body.classList.contains('nav-open'))$('.sidebar button').focus();}
 else if(a==='close-nav') closeDrawers();
 else if(a==='toggle-aside') {if(innerWidth<1024) {const opening=!document.body.classList.contains('drawer-aside');closeDrawers();if(opening){drawerTrigger=b;document.body.classList.remove('aside-closed');document.body.classList.add('drawer-aside');setInert();$('.right-panel button').focus();}}else {document.body.classList.toggle('aside-closed');setInert();}}
 else if(a==='scroll-bottom') {const el=$('#conversation-content');el.scrollTop=el.scrollHeight;unseen=false;b.remove();}
 else if(a==='send') await send();
 else if(a==='policy') {const d=getDraft();d.mode=d.mode==='readonly'?'edit':'readonly';persistDraft();renderComposer();toast(d.mode==='edit'?'受控修改：每次操作仍需审批':'只读模式');}
 else if(a==='add-context') await browse();
 else if(a==='browse') await browse(path);
 else if(a==='preview-file') {const sessionId=state.current, p=state.snapshot?.project; if(!p) return; const data=await api(`/api/projects/${enc(p.id)}/file?path=${enc(path)}`); if(state.current!==sessionId) return; openDialog(data.path,`<div class="document-preview"><pre>${esc(data.text)}</pre></div><div class="dialog-actions"><button class="btn btn-secondary" data-action="browse" data-path="${esc(path.split('/').slice(0,-1).join('/'))}">返回</button><button class="btn btn-primary" data-action="select-context" data-path="${esc(path)}">选择文件</button></div>`,true);}
 else if(a==='select-context') {const d=getDraft();if(!d.contextPaths.includes(path))d.contextPaths.push(path);persistDraft();closeDialog();renderComposer();}
 else if(a==='remove-context') {const d=getDraft();d.contextPaths=d.contextPaths.filter(x=>x!==path);persistDraft();renderComposer();}
 else if(a==='dismiss-upload') {const list=state.uploading.get(state.current)||[];if(list[Number(id)]?.status.startsWith('失败'))list.splice(Number(id),1);renderComposer();}
 else if(a==='attach') {if(state.current)$('#file-input').click();else toast('请先选择会话');}
 else if (a === 'remove-attachment') {
  const sessionId = state.current;
  b.disabled = true;
  try {
   await api(`/api/sessions/${enc(sessionId)}/attachments/${enc(id)}`, {method:'DELETE'});
   const draft = getDraft(sessionId);
   draft.attachmentIds = draft.attachmentIds.filter(attachmentId => attachmentId !== id);
   persistDraft(sessionId);
   if (state.current === sessionId) { await loadSnapshot(sessionId); renderComposer(); }
  } finally { b.disabled = false; }
 }
 else if(a==='tool-output') {const data=await api(`/api/tools/${enc(id)}/output`);openDialog('完整工具输出',`<pre id="full-tool-output" class="safe-pre" data-tool="${esc(id)}">${esc(data.text)}</pre><div class="dialog-actions">${data.nextOffset!==null?`<button class="btn btn-secondary" data-action="tool-output-more" data-id="${esc(id)}" data-offset="${data.nextOffset}">加载更多</button>`:''}<a class="btn btn-primary" href="/api/tools/${enc(id)}/output?download=1" download>下载完整输出</a></div>`,true);}
 else if(a==='tool-output-more') {b.disabled=true;try {const data=await api(`/api/tools/${enc(id)}/output?offset=${enc(b.dataset.offset)}`);const pre=$('#full-tool-output');if(pre?.dataset.tool===id){pre.textContent+=data.text;if(data.nextOffset===null)b.remove();else b.dataset.offset=data.nextOffset;}}finally{b.disabled=false;}}
 else if(a==='session-details') {
  const session = state.snapshot?.session;
  if (!session) return toast('请先选择会话');
  openDialog('会话详情', `<dl class="session-facts"><dt>会话</dt><dd>${esc(session.title)}</dd><dt>项目</dt><dd>${esc(currentProject()?.path || '—')}</dd><dt>最近活动</dt><dd>${esc(date(session.updatedAt))}</dd><dt>运行次数</dt><dd>${state.snapshot.runs.length}</dd></dl>`);
 }
 else if(a==='settings') await settings();
 else if(a==='save-settings') {const result=await api('/api/config',{method:'PATCH',body:{gateway:$('#config-gateway').value,model:$('#config-model').value,maxTurns:Number($('#config-turns').value),timeoutMs:Number($('#config-timeout').value)}});state.config=result.config;state.connection=result.connection || {};closeDialog();toast('设置已保存');}
 else if(a==='stop') {await api(`/api/runs/${enc(id)}/stop`,{method:'POST'});await refresh();}
 else if(a==='retry') {if(!confirm('以只读模式恢复分析，不会自动重复上次写入。继续吗？'))return;const key='retry:'+id;let attempt=state.pending.get(key);if(!attempt){attempt=crypto.randomUUID();state.pending.set(key,attempt);}await api(`/api/runs/${enc(id)}/retry`,{method:'POST',body:{idempotencyKey:attempt}});state.pending.delete(key);await refresh();}
 else if(a==='permission') {const [detail,diff]=await Promise.all([api(`/api/permissions/${enc(id)}`),api(`/api/permissions/${enc(id)}/diff`)]);const p=detail.permission;openDialog('审批操作',`<p>${esc(p.kind)} · ${esc(p.path || p.command || '')}</p><p>目的 / 原因：${esc(p.reason || '未提供')}</p>${p.resolutionReason ? `<p>${esc(p.resolutionReason)}</p>` : ''}<p>状态：${esc(labels[p.status] || p.status)} ${p.expiresAt?'· 到期 '+esc(date(p.expiresAt)):''}</p><pre class="safe-pre">${esc(diff.diff || p.command || '无文本差异')}</pre>${p.status==='pending'?`<div class="dialog-actions"><button class="btn btn-secondary" data-action="decide" data-id="${esc(id)}" data-decision="deny" data-version="${esc(diff.version)}">拒绝</button><button class="btn btn-primary" data-action="decide" data-id="${esc(id)}" data-decision="allow" data-version="${esc(diff.version)}">允许</button></div>`:''}`,true); if(p.status==='pending') $('#detail-dialog').dataset.permissionId=id; const latest=state.snapshot?.permissions?.find(x=>x.id===id); if(p.status==='pending' && latest && latest.status!=='pending') {closeDialog();toast('审批状态已变化，请重新查看');}}
 else if (a === 'decide') {
  const sessionId = state.current;
  const dialog = $('#detail-dialog');
  const decisions = $$('[data-action=decide]', dialog);
  decisions.forEach(button => { button.disabled = true; });
  try {
   await api(`/api/permissions/${enc(id)}/decision`, {method:'POST',body:{decision:b.dataset.decision,version:b.dataset.version}});
  } catch (err) {
   if (err.status !== 409) throw err;
   toast(err.message);
  } finally { decisions.forEach(button => { button.disabled = false; }); }
  if (dialog.dataset.permissionId === id && dialog.open) closeDialog();
  await refresh();
  if (state.current === sessionId && !dialog.open && document.activeElement === document.body) {
   const tab = $('.aside-tab[aria-selected=true]');
   (tab?.getClientRects().length ? tab : $('#prompt-input')).focus();
  }
 }
 else if(a==='artifact') {const result=await api(`/api/artifacts/${enc(id)}/content`), art=result.artifact;openDialog(art.name,`<p>${esc(art.mime)} · ${esc(art.availability)}</p>${result.previewable?`<div class="document-preview"><pre>${esc(result.text)}</pre></div>`:'<p>该成果不可预览</p>'}<div class="dialog-actions"><button class="btn btn-secondary" data-action="run-source" data-id="${esc(art.sessionId)}" data-run="${esc(art.runId)}">查看来源运行</button><a class="btn btn-primary" href="/api/artifacts/${enc(id)}/download" download>下载</a></div>`,true);}
 else if(a==='rename') {const title=prompt('会话名称',state.snapshot.session.title);if(title?.trim()) {await api(`/api/sessions/${enc(state.current)}`,{method:'PATCH',body:{title:title.trim()}});await refresh();}}
 else if(a==='archive') {await api(`/api/sessions/${enc(state.current)}`,{method:'PATCH',body:{status:state.snapshot.session.status==='archived'?'active':'archived'}});await refresh();}
 else if(a==='delete-session') {if(!confirm('删除该会话及其历史记录？项目源文件不会被删除。'))return;const old=state.current;deleted.add(old);clearTimeout(state.saving.get(old));state.saving.delete(old);try {await api(`/api/sessions/${enc(old)}`,{method:'DELETE'});} catch(err) {deleted.delete(old);persistDraft(old);throw err;}state.drafts.delete(old);storage.remove('atelier-draft:'+old);storage.remove('atelier-last-session');state.current=null;state.snapshot=null;await refreshLists();if(state.sessions.length)await switchSession(state.sessions[0].id);else render();}
 } catch(err) {toast(err.message || '操作失败');} });
$('#prompt-input').addEventListener('input',e=>{if(!state.current)return;getDraft().text=e.target.value;persistDraft();renderComposer();});
$('#prompt-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();if(!$('#send-button').disabled)send();}});
$('#file-input').addEventListener('change',e=>{const files=[...e.target.files];e.target.value='';upload(files);});
$('#session-search').addEventListener('input',e=>{state.search=e.target.value;pages.sessions=0;++listSequence;clearTimeout(searchTimer);searchTimer=setTimeout(()=>refreshLists().then(renderHistory).catch(err=>toast(err.message)),250);});
document.addEventListener('change', event => {
 if (event.target.id === 'trace-run') { state.selectedRun = event.target.value; render(); }
});
document.addEventListener('toggle',e=>{if(e.target.isConnected && e.target.matches('details[data-tool]')) {if(e.target.open)openTools.add(e.target.dataset.tool);else openTools.delete(e.target.dataset.tool);}},true);
document.addEventListener('change',e=>{if(e.target.id==='filter-status'){filters.runStatus=e.target.value;pages.runs=0;refreshLists().then(render).catch(err=>toast(err.message));}});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'&&!e.isComposing){e.preventDefault();if(!$('#detail-dialog').open) $('[data-action=new]').click();return;} const tab=e.target.closest?.('[role=tab]');if(tab && ['ArrowRight','ArrowLeft','Home','End'].includes(e.key)){const tabs=$$('[role=tab]',tab.closest('[role=tablist]'));let i=tabs.indexOf(tab);i=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;e.preventDefault();tabs[i].focus();tabs[i].click();} if(e.key==='Escape' && !$('#detail-dialog').open)closeDrawers(); if(e.key==='Tab' && !$('#detail-dialog').open && (document.body.classList.contains('nav-open')||document.body.classList.contains('drawer-aside'))){const container=document.body.classList.contains('nav-open')?$('.sidebar'):$('.right-panel');const focus=$$('button:not([disabled]),input:not([disabled]),a[href],select,textarea',container).filter(el=>el.getClientRects().length);if(focus.length && (e.shiftKey&&document.activeElement===focus[0] || !e.shiftKey&&document.activeElement===focus.at(-1))){e.preventDefault();(e.shiftKey?focus.at(-1):focus[0]).focus();}}});
let wasNarrow=innerWidth<1024;
window.addEventListener('resize',()=>{const narrow=innerWidth<1024;if(narrow!==wasNarrow){closeDrawers();document.body.classList.toggle('aside-closed',narrow);wasNarrow=narrow;}if(!narrow)document.body.classList.remove('drawer-aside','nav-open');setInert();});
const symbols={plus:'+',search:'⌕',chat:'◫',grid:'▦',clock:'◷',folder:'▱',branch:'⑂',settings:'⚙',menu:'☰',panel:'◧',chevron:'›',terminal:'›_',file:'▤',shield:'◇',down:'⌄',attach:'⌕',arrow:'↑',info:'ⓘ',x:'×'};
$$('[data-icon]').forEach(el=>{el.textContent=symbols[el.dataset.icon] || '·';el.setAttribute('aria-hidden','true');});
async function start() {try {const b=await api('/api/bootstrap');Object.assign(state,{token:b.csrfToken,cursor:b.cursor || 0,projects:b.projects || [],sessions:b.sessions || [],runs:b.runs || [],artifacts:b.artifacts || [],config:b.config || {},connection:b.connection || {}});await refreshLists(); const savedId=storage.get('atelier-last-session'); if(savedId) { try {const restored=await api('/api/sessions/'+enc(savedId));state.current=restored.session.id;} catch {storage.remove('atelier-last-session');} } state.current=state.current || state.sessions.find(s=>s.status!=='archived')?.id || state.sessions[0]?.id || null;if(innerWidth<1024)document.body.classList.add('aside-closed');setInert();await loadSnapshot();render();connect();if(!state.projects.length)projectDialog();}catch(e){render();toast('无法连接本地服务：'+e.message);}}
start();

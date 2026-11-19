import { useDeferredValue, useId, useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import type { Extension, Project } from '@shared/types';
import { ActionButton, ErrorMessage, FeatureDialog, SourceLink, Switch } from './components';
import {
  autoEnabled,
  allowsAuto,
  extensionKeys,
  kinds,
  marks,
  messageOf,
  testLabels,
  useExtensionMutation,
  useExtensions,
  type ExtensionKind,
} from './api';
import { ExtensionEditor } from './editor';
import { SkillMarket } from './market';
import { PublicImport } from './public-import';
import './extensions.css';

type Modal =
  | {
      type: 'editor';
      kind: ExtensionKind;
      item?: Extension;
      importFile?: boolean;
      testOnOpen?: boolean;
    }
  | { type: 'market' }
  | { type: 'public'; kind: ExtensionKind; item?: Extension }
  | { type: 'delete'; item: Extension };
const tabs: ExtensionKind[] = ['skill', 'command', 'mcp'];
export interface ExtensionsPageProps {
  projects: Project[];
  projectId?: string;
  onStartSkill?: (projectId: string, name: string, editable: boolean) => Promise<void>;
}
export default function ExtensionsPage({ projects, projectId, onStartSkill }: ExtensionsPageProps) {
  const [pinnedId, setPinnedId] = useState<string>();
  const project =
    projects.find((value) => value.id === pinnedId) ??
    projects.find((value) => value.id === projectId) ??
    projects[0];
  return (
    <section className="ext-page" aria-label="项目扩展">
      <header className="ext-heading">
        <div>
          <p className="ext-eyebrow">EXTENSIONS</p>
          <h1>项目扩展</h1>
          <p className="ext-subtitle">为每个项目配置常用指令、Skill 与工具服务。</p>
        </div>
        <label className="ext-project-label">
          当前项目
          <select
            aria-label="选择扩展所属项目"
            value={project?.id ?? ''}
            onChange={(event) => setPinnedId(event.target.value)}
          >
            {projects.length ? (
              projects.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.name || value.path || value.id}
                </option>
              ))
            ) : (
              <option value="">暂无项目</option>
            )}
          </select>
        </label>
      </header>
      <ProjectExtensions
        key={project?.id ?? 'none'}
        project={project}
        onStartSkill={onStartSkill}
      />
    </section>
  );
}
function ProjectExtensions({
  project,
  onStartSkill,
}: {
  project?: Project;
  onStartSkill?: ExtensionsPageProps['onStartSkill'];
}) {
  const projectId = project?.id ?? '';
  const query = useExtensions(projectId);
  const toggle = useExtensionMutation(projectId);
  const pending = useIsMutating({ mutationKey: extensionKeys.mutations(projectId) }) > 0;
  const [kind, setKind] = useState<ExtensionKind>('skill');
  const [search, setSearch] = useState('');
  const searchText = useDeferredValue(search.trim().toLocaleLowerCase());
  const [filter, setFilter] = useState('all');
  const [modal, setModal] = useState<Modal>();
  const [notice, setNotice] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const items = query.data ?? [];
  const visible = items.filter(
    (item) =>
      item.kind === kind &&
      (filter === 'all' || item.enabled === (filter === 'enabled')) &&
      `${item.name} ${item.description} ${item.source}`.toLocaleLowerCase().includes(searchText),
  );
  const close = () => setModal(undefined);
  async function toggleItem(item: Extension, field: 'enabled' | 'autoInvoke') {
    if (
      pending ||
      (field === 'autoInvoke' && (item.kind !== 'skill' || !allowsAuto(item) || !item.supported))
    )
      return;
    const old = field === 'autoInvoke' && item.kind !== 'mcp' ? autoEnabled(item) : item.enabled;
    setErrors((value) => ({ ...value, [item.id]: '' }));
    try {
      await toggle.mutateAsync({
        suffix: encodeURIComponent(item.id),
        method: 'PATCH',
        body: { version: item.version, [field]: !old },
      });
      setNotice(
        field === 'autoInvoke'
          ? old
            ? '已关闭自动调用'
            : '已允许自动调用，下一轮对话生效'
          : old
            ? '扩展已停用'
            : '扩展已启用',
      );
    } catch (cause) {
      setErrors((value) => ({ ...value, [item.id]: messageOf(cause) }));
    }
  }
  return (
    <>
      <div className="ext-tabs" role="tablist" aria-label="扩展类型">
        {tabs.map((value, index) => (
          <button
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            key={value}
            type="button"
            role="tab"
            id={`${id}-${value}`}
            aria-controls={`${id}-results`}
            aria-selected={kind === value}
            tabIndex={kind === value ? 0 : -1}
            onClick={() => setKind(value)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
              setKind(tabs[next]!);
              tabRefs.current[next]?.focus();
            }}
          >
            <span className="ext-tab-mark" aria-hidden="true">
              {marks[value]}
            </span>
            {kinds[value]}
            <span className="ext-count">
              {query.data ? items.filter((item) => item.kind === value).length : '—'}
            </span>
          </button>
        ))}
      </div>
      <div className="ext-toolbar">
        <label className="ext-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            placeholder="搜索名称或描述"
            aria-label="搜索扩展"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="ext-filter">
          状态
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">全部</option>
            <option value="enabled">已启用</option>
            <option value="disabled">已停用</option>
          </select>
        </label>
        <div className="ext-toolbar-actions">
          {kind === 'skill' ? (
            <ActionButton
              primary
              disabled={!projectId || pending}
              onClick={() => setModal({ type: 'market' })}
            >
              Skill 市场
            </ActionButton>
          ) : null}
          <ActionButton
            disabled={!projectId || pending}
            onClick={() => setModal({ type: 'public', kind })}
          >
            从公开来源导入
          </ActionButton>
          {kind !== 'mcp' ? (
            <ActionButton
              disabled={!projectId || pending}
              onClick={() => setModal({ type: 'editor', kind, importFile: true })}
            >
              导入 Markdown
            </ActionButton>
          ) : null}
          <ActionButton
            disabled={!projectId || query.isPending || pending}
            onClick={() => setModal({ type: 'editor', kind })}
          >
            + {kind === 'mcp' ? '添加 MCP' : `新建 ${kinds[kind]}`}
          </ActionButton>
        </div>
      </div>
      <p className="ext-scope-note">
        {kind === 'mcp'
          ? '只在当前项目生效。连接测试通过后，可在会话中输入 # 选择已允许的工具。'
          : kind === 'skill'
            ? '只在当前项目生效。允许自动调用的 Skill 可由模型按需使用；输入 / 可手动选择支持的 Skill。'
            : '只在当前项目生效。在会话中输入 /，选择命令。'}
      </p>
      <div className="ext-page-message" role="status" aria-live="polite">
        {notice}
      </div>
      {query.error ? (
        <div className="ext-error" role="alert">
          {messageOf(query.error)}{' '}
          <ActionButton disabled={query.isFetching} onClick={() => void query.refetch()}>
            重新加载
          </ActionButton>
        </div>
      ) : null}
      <section
        className="ext-results"
        id={`${id}-results`}
        role="tabpanel"
        aria-labelledby={`${id}-${kind}`}
        tabIndex={0}
        aria-busy={query.isFetching}
      >
        {!project ? (
          <div className="ext-empty">
            <span aria-hidden="true">+</span>
            <h2>先绑定一个项目</h2>
            <p>项目绑定后，就可以在这里管理专属扩展。</p>
          </div>
        ) : query.isPending ? (
          <p className="ext-loading" role="status">
            正在读取项目扩展…
          </p>
        ) : !visible.length ? (
          query.isError && !query.data ? null : (
            <div className="ext-empty">
              <span aria-hidden="true">{marks[kind]}</span>
              <h2>
                {searchText || filter !== 'all' ? '没有符合条件的扩展' : `还没有 ${kinds[kind]}`}
              </h2>
              <p>
                {searchText || filter !== 'all'
                  ? '试试其他关键词或状态。'
                  : kind === 'mcp'
                    ? '连接一个工具服务，再选择这个项目可以使用的工具。'
                    : '创建一份常用指令，或导入已有的 Markdown 文件。'}
              </p>
            </div>
          )
        ) : (
          <div className="ext-card-grid">
            {visible.map((item) => (
              <article
                key={item.id}
                className={`ext-card ${item.enabled ? '' : 'ext-card-disabled'}`}
              >
                <div className="ext-card-top">
                  <span className="ext-kind-mark" aria-hidden="true">
                    {marks[item.kind]}
                  </span>
                  <span className="ext-card-kind">{kinds[item.kind]}</span>
                  <Switch
                    checked={item.enabled}
                    label={`${item.enabled ? '停用' : '启用'} ${item.name}`}
                    disabled={pending}
                    onChange={() => void toggleItem(item, 'enabled')}
                  />
                </div>
                <button
                  type="button"
                  className="ext-card-title"
                  onClick={() => setModal({ type: 'editor', kind: item.kind, item })}
                >
                  {item.kind === 'command' ? <span className="ext-name-prefix">/</span> : null}
                  {item.name}
                </button>
                <p className="ext-card-description">{item.description || '暂无描述'}</p>
                <div className="ext-card-meta">
                  <span className={`ext-state-dot ${item.enabled ? 'ext-is-enabled' : ''}`}>
                    {item.enabled ? '已启用' : '已停用'}
                  </span>
                  {item.kind === 'mcp' ? (
                    <span className="ext-status" data-ext-status={item.status || 'untested'}>
                      <span aria-hidden="true" />
                      {item.status ? testLabels[item.status] : '未测试'}
                    </span>
                  ) : (
                    <span>{item.userInvocable === false ? '不支持手动调用' : '可手动调用'}</span>
                  )}
                  <span className="ext-version">v{item.version}</span>
                </div>
                {item.kind !== 'mcp' && (!item.supported || item.compatibility) ? (
                  <p className="ext-compatibility">
                    {item.compatibility || '当前运行环境暂不支持此扩展'}
                  </p>
                ) : null}
                <p className="ext-card-source">
                  {item.kind === 'mcp' ? (
                    <>
                      {item.transport.type === 'stdio'
                        ? item.transport.command
                        : item.transport.url}
                      <span>{item.allowedTools.length} 个允许的工具</span>
                    </>
                  ) : (
                    item.source || '项目内创建'
                  )}
                </p>
                {item.kind === 'skill' ? (
                  <div className="ext-auto-setting">
                    <span>允许自动调用</span>
                    <Switch
                      checked={autoEnabled(item)}
                      label={`${item.name} 允许自动调用`}
                      disabled={pending || !allowsAuto(item) || !item.supported}
                      onChange={() => void toggleItem(item, 'autoInvoke')}
                    />
                    <small>
                      {!allowsAuto(item)
                        ? '上游禁止模型调用，仅可按手动调用声明使用。'
                        : !item.supported
                          ? '当前不兼容，暂不能自动调用。'
                          : !item.enabled
                            ? '启用此扩展后生效。'
                            : autoEnabled(item)
                              ? '模型可按需加载，下一轮对话生效。'
                              : '已关闭自动调用。'}
                    </small>
                  </div>
                ) : null}
                {item.origin ? (
                  <p className="ext-card-source">
                    <SourceLink url={item.origin.location}>公开来源</SourceLink>
                    <span title={item.origin.revision}>{item.origin.revision.slice(0, 12)}</span>
                  </p>
                ) : null}
                {item.kind === 'mcp' && item.statusMessage ? (
                  <p className="ext-test-message" data-ext-status={item.status}>
                    {item.statusMessage}
                  </p>
                ) : null}
                <ErrorMessage error={errors[item.id]} />
                <footer className="ext-card-actions">
                  <ActionButton
                    disabled={pending}
                    onClick={() => setModal({ type: 'editor', kind: item.kind, item })}
                  >
                    查看与编辑
                  </ActionButton>
                  {item.origin ? (
                    <ActionButton
                      disabled={pending}
                      onClick={() => setModal({ type: 'public', kind: item.kind, item })}
                    >
                      检查更新
                    </ActionButton>
                  ) : null}
                  {item.kind === 'mcp' ? (
                    <ActionButton
                      disabled={pending}
                      onClick={() =>
                        setModal({ type: 'editor', kind: 'mcp', item, testOnOpen: true })
                      }
                    >
                      测试连接
                    </ActionButton>
                  ) : null}
                  <ActionButton
                    danger
                    disabled={pending}
                    onClick={() => setModal({ type: 'delete', item })}
                  >
                    删除
                  </ActionButton>
                </footer>
              </article>
            ))}
          </div>
        )}
      </section>
      {modal?.type === 'editor' ? (
        <ExtensionEditor
          projectId={projectId}
          projectName={project?.name ?? projectId}
          initialItem={modal.item}
          kind={modal.kind}
          importFile={modal.importFile}
          testOnOpen={modal.testOnOpen}
          onClose={close}
          onSaved={setNotice}
        />
      ) : modal?.type === 'market' ? (
        <SkillMarket
          projectId={projectId}
          projectName={project?.name ?? projectId}
          onClose={close}
          onSaved={setNotice}
          onStartSkill={onStartSkill}
        />
      ) : modal?.type === 'public' ? (
        <PublicImport
          projectId={projectId}
          projectName={project?.name ?? projectId}
          kind={modal.kind}
          updating={modal.item}
          onClose={close}
          onSaved={setNotice}
        />
      ) : modal?.type === 'delete' ? (
        <DeleteExtension
          projectId={projectId}
          item={modal.item}
          onClose={close}
          onSaved={setNotice}
        />
      ) : null}
    </>
  );
}
function DeleteExtension({
  projectId,
  item,
  onClose,
  onSaved,
}: {
  projectId: string;
  item: Extension;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const mutation = useExtensionMutation(projectId);
  async function remove() {
    if (mutation.isPending) return;
    try {
      await mutation.mutateAsync({
        suffix: encodeURIComponent(item.id),
        method: 'DELETE',
        removeId: item.id,
      });
      onSaved('扩展已删除');
      onClose();
    } catch {
      /* The mutation error is shown in place. */
    }
  }
  return (
    <FeatureDialog title="删除扩展" busy={mutation.isPending} onClose={onClose}>
      <p>
        删除 <strong>{item.name}</strong>？后续会话将无法再选择这个扩展。
      </p>
      <p className="ext-help">已有草稿中的选择会标记为不可用，可手动移除。</p>
      <ErrorMessage error={mutation.error} />
      <div className="ext-dialog-actions">
        <ActionButton disabled={mutation.isPending} onClick={onClose}>
          取消
        </ActionButton>
        <ActionButton danger disabled={mutation.isPending} onClick={() => void remove()}>
          {mutation.isPending ? '正在删除…' : '确认删除'}
        </ActionButton>
      </div>
    </FeatureDialog>
  );
}

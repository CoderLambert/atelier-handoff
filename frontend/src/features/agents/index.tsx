import { useDeferredValue, useRef, useState } from 'react';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Bot, Copy, MessageSquarePlus, Plus, RefreshCw, Search } from 'lucide-react';
import type { AgentCard, Project, Session } from '@shared/types';
import { api } from '@/api/client';
import { keys } from '@/app/events';
import { Button } from '@/components/ui/button';
import { messageOf, useExtensions } from '@/features/extensions/api';
import {
  agentKeys,
  agentsQuery,
  capabilityLabels,
  dependencyIssues,
  useAgentMutation,
} from './api';
import { AgentDialog, AgentProblems } from './components';
import { AgentEditor } from './editor';
import './agents.css';

export interface AgentsPageProps {
  projects: Project[];
  projectId?: string;
  onOpenSession: (id: string) => void;
}
type Modal =
  { type: 'editor'; item?: AgentCard; template?: boolean } | { type: 'archive'; item: AgentCard };

export default function AgentsPage({ projects, projectId, onOpenSession }: AgentsPageProps) {
  const [selection, setSelection] = useState<{ from?: string; id: string }>();
  const project =
    projects.find((value) => selection?.from === projectId && value.id === selection?.id) ??
    projects.find((value) => value.id === projectId) ??
    projects[0];
  const pending = useIsMutating({ mutationKey: ['agents'] }) > 0;
  return (
    <section className="agents-page" aria-label="项目智能体">
      <header className="agents-heading">
        <div>
          <p className="agents-eyebrow">AGENTS</p>
          <h1>项目智能体</h1>
          <p className="agents-subtitle">
            把常用的工作方式、能力与工具，配置成随时可用的专属智能体。
          </p>
        </div>
        <label className="agents-project">
          当前项目
          <select
            aria-label="选择智能体所属项目"
            disabled={!projects.length || pending}
            value={project?.id ?? ''}
            onChange={(event) => setSelection({ from: projectId, id: event.target.value })}
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
      <ProjectAgents key={project?.id ?? 'none'} project={project} onOpenSession={onOpenSession} />
    </section>
  );
}

function ProjectAgents({
  project,
  onOpenSession,
}: {
  project?: Project;
  onOpenSession: (id: string) => void;
}) {
  const projectId = project?.id ?? '';
  const client = useQueryClient();
  const query = useQuery(agentsQuery(projectId));
  const extensions = useExtensions(projectId);
  const operation = useAgentMutation(projectId);
  const [modal, setModal] = useState<Modal>();
  const [search, setSearch] = useState('');
  const searchText = useDeferredValue(search.trim().toLocaleLowerCase());
  const [filter, setFilter] = useState('active');
  const [notice, setNotice] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const lock = useRef(false);
  const start = useMutation({
    mutationKey: agentKeys.mutations(projectId),
    mutationFn: (item: AgentCard) =>
      api<{ session: Session }>('/api/sessions', {
        method: 'POST',
        body: { projectId, agentRevisionId: item.revisionId },
      }),
    onSuccess: ({ session }) => {
      if (!session?.id) throw new Error('创建会话响应缺少会话信息，请刷新会话列表确认结果。');
      void client.invalidateQueries({ queryKey: keys.sessions });
      void client.invalidateQueries({ queryKey: keys.bootstrap });
    },
    onSettled: () => client.invalidateQueries({ queryKey: agentKeys.list(projectId) }),
  });
  const pending = useIsMutating({ mutationKey: agentKeys.mutations(projectId) }) > 0;
  const canManage = Boolean(project?.available);
  const items = query.data ?? [];
  const visible = items.filter(
    (item) =>
      (filter === 'all' || item.archived === (filter === 'archived')) &&
      `${item.config.name} ${item.config.description}`.toLocaleLowerCase().includes(searchText),
  );
  const close = () => setModal(undefined);
  async function duplicate(item: AgentCard) {
    if (lock.current || pending || !canManage) return;
    lock.current = true;
    setErrors((value) => ({ ...value, [item.id]: '' }));
    try {
      const copied = await operation.mutateAsync({
        action: 'duplicate',
        id: item.id,
        baseRevisionId: item.revisionId,
      });
      setModal({ type: 'editor', item: copied });
      setNotice(`已复制为「${copied.config.name}」，可继续调整配置。`);
      setFilter('active');
      setSearch('');
    } catch (cause) {
      setErrors((value) => ({ ...value, [item.id]: messageOf(cause) }));
    } finally {
      lock.current = false;
    }
  }
  async function openSession(item: AgentCard) {
    if (lock.current || pending || !canManage || item.archived) return;
    lock.current = true;
    setErrors((value) => ({ ...value, [item.id]: '' }));
    try {
      const result = await start.mutateAsync(item);
      onOpenSession(result.session.id);
    } catch (cause) {
      setErrors((value) => ({ ...value, [item.id]: messageOf(cause) }));
    } finally {
      lock.current = false;
    }
  }
  return (
    <>
      <div className="agents-toolbar">
        <label className="agents-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索智能体"
            value={search}
            placeholder="搜索名称或介绍"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="agents-filter">
          状态
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="active">可用智能体</option>
            <option value="archived">已归档</option>
            <option value="all">全部</option>
          </select>
        </label>
        <div className="agents-toolbar-actions">
          <Button
            variant="secondary"
            disabled={!projectId || query.isFetching || pending}
            onClick={() => {
              void query.refetch();
              void extensions.refetch();
            }}
          >
            <RefreshCw size={15} aria-hidden="true" />
            刷新
          </Button>
          <Button disabled={!canManage || pending} onClick={() => setModal({ type: 'editor' })}>
            <Plus size={16} aria-hidden="true" />
            创建智能体
          </Button>
        </div>
      </div>
      {project ? (
        <div className="agents-template">
          <div className="agents-template-icon" aria-hidden="true">
            <Bot size={23} />
          </div>
          <div>
            <h2>资料整理助手</h2>
            <p>从一个只读模板开始，整理项目资料、附件和待办。</p>
          </div>
          <Button
            variant="secondary"
            disabled={!canManage || pending}
            onClick={() => setModal({ type: 'editor', template: true })}
          >
            使用模板
          </Button>
        </div>
      ) : null}
      <p className="agents-scope-note">
        智能体仅属于当前项目。每次保存生成新版本，已有会话保留创建时的配置。
      </p>
      {notice ? (
        <p className="agent-notice" role="status">
          {notice}
        </p>
      ) : null}
      {project && !project.available ? (
        <p className="agent-error" role="alert">
          项目路径当前不可用，请先在项目管理中恢复访问。
        </p>
      ) : null}
      {query.isError ? (
        <div className="agent-error" role="alert">
          {messageOf(query.error)}{' '}
          <Button
            variant="secondary"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            重新加载
          </Button>
        </div>
      ) : null}
      {extensions.isError && project ? (
        <p className="agent-error" role="alert">
          无法检查最新项目依赖：{messageOf(extensions.error)} 请刷新后再启动智能体。
        </p>
      ) : null}
      <section className="agents-results" aria-label="智能体列表" aria-busy={query.isFetching}>
        {!project ? (
          <div className="agents-empty">
            <Bot size={30} aria-hidden="true" />
            <h2>先绑定一个项目</h2>
            <p>项目绑定后，就可以为它创建专属智能体。</p>
          </div>
        ) : query.isPending ? (
          <p className="agents-loading" role="status">
            正在读取项目智能体…
          </p>
        ) : !visible.length ? (
          query.isError && !query.data ? null : (
            <div className="agents-empty">
              <Bot size={30} aria-hidden="true" />
              <h2>
                {searchText
                  ? '没有符合条件的智能体'
                  : filter === 'archived'
                    ? '还没有已归档的智能体'
                    : '创建你的第一个项目智能体'}
              </h2>
              <p>
                {searchText
                  ? '试试其他关键词或状态。'
                  : filter === 'archived'
                    ? '归档后的智能体会保留在这里，已有会话可以继续查看。'
                    : '从「资料整理助手」模板开始，或定义一套自己的工作方式。'}
              </p>
            </div>
          )
        ) : (
          <div className="agents-grid">
            {visible.map((item) => {
              const issues = [
                ...new Set([
                  ...item.issues,
                  ...(extensions.data ? dependencyIssues(item.config, extensions.data) : []),
                ]),
              ];
              return (
                <article
                  className={`agent-card${item.archived ? ' agent-card-archived' : ''}`}
                  key={item.id}
                >
                  <div className="agent-card-heading">
                    <span className="agent-card-icon" aria-hidden="true">
                      <Bot size={22} />
                    </span>
                    <span className="agent-card-mode">
                      {item.archived
                        ? '已归档'
                        : item.config.mode === 'readonly'
                          ? '只读模式'
                          : '编辑模式'}
                    </span>
                    <span className="agent-version">v{item.version}</span>
                  </div>
                  <button
                    className="agent-card-title"
                    type="button"
                    disabled={pending}
                    onClick={() => setModal({ type: 'editor', item })}
                  >
                    {item.config.name}
                  </button>
                  <p className="agent-card-description">{item.config.description || '暂无介绍'}</p>
                  <ul className="agent-capability-tags" aria-label={`${item.config.name} 的能力`}>
                    {item.config.capabilities.map((capability) => (
                      <li key={capability}>{capabilityLabels[capability]?.label ?? capability}</li>
                    ))}
                  </ul>
                  <p className="agent-card-dependencies">
                    {item.config.skills.length} 个 Skill ·{' '}
                    {item.config.mcp.reduce((count, server) => count + server.tools.length, 0)} 个
                    MCP 工具
                  </p>
                  {!item.archived ? <AgentProblems issues={issues} label="需要更新配置" /> : null}
                  {errors[item.id] ? (
                    <p className="agent-error" role="alert">
                      {errors[item.id]}
                    </p>
                  ) : null}
                  <footer className="agent-card-actions">
                    {!item.archived ? (
                      <Button
                        disabled={
                          !canManage ||
                          pending ||
                          issues.length > 0 ||
                          extensions.isPending ||
                          extensions.isError ||
                          extensions.isFetching
                        }
                        onClick={() => void openSession(item)}
                      >
                        <MessageSquarePlus size={15} aria-hidden="true" />
                        {start.isPending && start.variables?.id === item.id
                          ? '正在启动…'
                          : '开始会话'}
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      disabled={pending || (!canManage && !item.archived)}
                      onClick={() => setModal({ type: 'editor', item })}
                    >
                      {item.archived ? '查看配置' : '编辑'}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={!canManage || pending}
                      aria-label={`复制 ${item.config.name}`}
                      onClick={() => void duplicate(item)}
                    >
                      <Copy size={15} aria-hidden="true" />
                      复制
                    </Button>
                    {!item.archived ? (
                      <Button
                        variant="ghost"
                        disabled={!canManage || pending}
                        aria-label={`归档 ${item.config.name}`}
                        onClick={() => setModal({ type: 'archive', item })}
                      >
                        <Archive size={15} aria-hidden="true" />
                        归档
                      </Button>
                    ) : null}
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </section>
      {modal?.type === 'editor' ? (
        <AgentEditor
          key={modal.item?.id ?? (modal.template ? 'template' : 'new')}
          projectId={projectId}
          projectName={project?.name || projectId}
          initialItem={modal.item}
          template={modal.template}
          onClose={close}
          onSaved={setNotice}
        />
      ) : modal?.type === 'archive' ? (
        <ArchiveAgent projectId={projectId} item={modal.item} onClose={close} onSaved={setNotice} />
      ) : null}
    </>
  );
}

function ArchiveAgent({
  projectId,
  item,
  onClose,
  onSaved,
}: {
  projectId: string;
  item: AgentCard;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const mutation = useAgentMutation(projectId);
  const lock = useRef(false);
  async function archive() {
    if (lock.current) return;
    lock.current = true;
    try {
      await mutation.mutateAsync({
        action: 'archive',
        id: item.id,
        baseRevisionId: item.revisionId,
      });
      onSaved(`「${item.config.name}」已归档。已有会话与历史版本仍会保留。`);
      onClose();
    } catch {
      // The mutation error stays visible in this confirmation dialog.
    } finally {
      lock.current = false;
    }
  }
  return (
    <AgentDialog
      title="归档智能体"
      description="归档后将无法使用此智能体创建新会话。"
      busy={mutation.isPending}
      onClose={onClose}
    >
      <p>
        确认归档「{item.config.name}」v{item.version}？已有会话与历史版本会保留。
      </p>
      {mutation.error ? (
        <p className="agent-error" role="alert">
          {messageOf(mutation.error)} 请关闭后刷新列表，确认最新状态。
        </p>
      ) : null}
      <footer className="agent-dialog-actions">
        <Button variant="secondary" disabled={mutation.isPending} onClick={onClose}>
          取消
        </Button>
        <Button
          variant="destructive"
          disabled={mutation.isPending || Boolean(mutation.error)}
          onClick={() => void archive()}
        >
          {mutation.isPending ? '正在归档…' : '确认归档'}
        </Button>
      </footer>
    </AgentDialog>
  );
}

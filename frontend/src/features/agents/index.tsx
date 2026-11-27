/**
 * @file 提供按项目管理智能体的目录页面。
 * @implementation 查询并筛选智能体，协调创建、编辑、复制、归档和开启会话等操作。
 * @updated 2026-11-27T22:35:00+08:00
 */
import { useUiTranslation } from '@/i18n';
import { useDeferredValue, useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import { Archive, Bot, Copy, MessageSquarePlus, Plus, RefreshCw } from 'lucide-react';
import { CatalogProjectSelect, CatalogToolbar } from '@/components/catalog-toolbar';
import type { AgentCard, Project } from '@shared/types';
import { Button } from '@/components/ui/button';
import { messageOf, useExtensions } from '@/features/extensions/api';
import { useStartAgentSession } from '@/use-query/agents/use-start-agent-session';
import {
  agentKeys,
  agentIssueMessage,
  capabilityLabels,
  dependencyIssues,
  useAgentMutation,
  useAgents,
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
  const { t } = useUiTranslation('extensions');
  const [selection, setSelection] = useState<{ from?: string; id: string }>();
  const project =
    projects.find((value) => selection?.from === projectId && value.id === selection?.id) ??
    projects.find((value) => value.id === projectId) ??
    projects[0];
  const pending = useIsMutating({ mutationKey: ['agents'] }) > 0;
  return (
    <section className="agents-page" aria-label={t('agents.pageTitle')}>
      <header className="agents-heading">
        <div>
          <p className="agents-eyebrow">{t('agents.eyebrow')}</p>
          <h1>{t('agents.pageTitle')}</h1>
          <p className="agents-subtitle">{t('agents.subtitle')}</p>
        </div>
        <CatalogProjectSelect
          className="agents-project"
          label={t('common.currentProject')}
          selectLabel={t('agents.projectSelector')}
          disabled={!projects.length || pending}
          value={project?.id ?? ''}
          options={projects.map((value) => ({
            value: value.id,
            label: value.name || value.path || value.id,
          }))}
          emptyLabel={t('common.noProjects')}
          onValueChange={(value) => setSelection({ from: projectId, id: value })}
        />
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
  const { t } = useUiTranslation('extensions');
  const projectId = project?.id ?? '';
  const query = useAgents(projectId);
  const extensions = useExtensions(projectId);
  const operation = useAgentMutation(projectId);
  const [modal, setModal] = useState<Modal>();
  const [search, setSearch] = useState('');
  const searchText = useDeferredValue(search.trim().toLocaleLowerCase());
  const [filter, setFilter] = useState('active');
  const [notice, setNotice] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const lock = useRef(false);
  const start = useStartAgentSession(projectId);
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
      setNotice(t('agents.copied', { name: copied.config.name }));
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
      <CatalogToolbar
        className="agents-toolbar"
        search={{
          label: t('agents.searchLabel'),
          placeholder: t('agents.searchPlaceholder'),
          value: search,
          onChange: setSearch,
        }}
        filter={{
          label: t('common.status'),
          value: filter,
          options: [
            { value: 'active', label: t('agents.active') },
            { value: 'archived', label: t('agents.archived') },
            { value: 'all', label: t('common.all') },
          ],
          onChange: setFilter,
        }}
      >
        <Button
          variant="secondary"
          disabled={!projectId || query.isFetching || pending}
          onClick={() => {
            void query.refetch();
            void extensions.refetch();
          }}
        >
          <RefreshCw data-icon="inline-start" aria-hidden="true" />
          {t('common.refresh')}
        </Button>
        <Button disabled={!canManage || pending} onClick={() => setModal({ type: 'editor' })}>
          <Plus data-icon="inline-start" aria-hidden="true" />
          {t('agents.create')}
        </Button>
      </CatalogToolbar>
      {project ? (
        <div className="agents-template">
          <div className="agents-template-icon" aria-hidden="true">
            <Bot aria-hidden="true" />
          </div>
          <div>
            <h2>{t('agents.templateName')}</h2>
            <p>{t('agents.templateDescription')}</p>
          </div>
          <Button
            variant="secondary"
            disabled={!canManage || pending}
            onClick={() => setModal({ type: 'editor', template: true })}
          >
            {t('agents.useTemplate')}
          </Button>
        </div>
      ) : null}
      <p className="agents-scope-note">{t('agents.scope')}</p>
      {notice ? (
        <p className="agent-notice" role="status">
          {notice}
        </p>
      ) : null}
      {project && !project.available ? (
        <p className="agent-error" role="alert">
          {t('agents.pathUnavailable')}
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
            {t('common.reload')}
          </Button>
        </div>
      ) : null}
      {extensions.isError && project ? (
        <p className="agent-error" role="alert">
          {t('agents.dependencyError', { error: messageOf(extensions.error) })}
        </p>
      ) : null}
      <section
        className="agents-results"
        aria-label={t('agents.listLabel')}
        aria-busy={query.isFetching}
      >
        {!project ? (
          <div className="agents-empty">
            <Bot size={30} aria-hidden="true" />
            <h2>{t('common.bindProject')}</h2>
            <p>{t('agents.bindHelp')}</p>
          </div>
        ) : query.isPending ? (
          <p className="agents-loading" role="status">
            {t('agents.loading')}
          </p>
        ) : !visible.length ? (
          query.isError && !query.data ? null : (
            <div className="agents-empty">
              <Bot size={30} aria-hidden="true" />
              <h2>
                {searchText
                  ? t('agents.noMatches')
                  : filter === 'archived'
                    ? t('agents.noArchived')
                    : t('agents.createFirst')}
              </h2>
              <p>
                {searchText
                  ? t('common.trySearch')
                  : filter === 'archived'
                    ? t('agents.archivedHelp')
                    : t('agents.createHelp')}
              </p>
            </div>
          )
        ) : (
          <div className="agents-grid">
            {visible.map((item) => {
              const issues = [
                ...new Set([
                  ...item.issues.map(agentIssueMessage),
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
                      <Bot aria-hidden="true" />
                    </span>
                    <span className="agent-card-mode">
                      {item.archived
                        ? t('agents.archived')
                        : item.config.mode === 'readonly'
                          ? t('agents.readonlyMode')
                          : t('agents.editMode')}
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
                  <p className="agent-card-description">
                    {item.config.description || t('common.noIntroduction')}
                  </p>
                  <ul
                    className="agent-capability-tags"
                    aria-label={t('agents.capabilitiesLabel', { name: item.config.name })}
                  >
                    {item.config.capabilities.map((capability) => (
                      <li key={capability}>{capabilityLabels[capability]?.label ?? capability}</li>
                    ))}
                  </ul>
                  <p className="agent-card-dependencies">
                    {t('agents.skillCount', { count: item.config.skills.length })}
                    {' · '}
                    {t('agents.mcpCount', {
                      count: item.config.mcp.reduce(
                        (count, server) => count + server.tools.length,
                        0,
                      ),
                    })}
                  </p>
                  {!item.archived ? (
                    <AgentProblems issues={issues} label={t('agents.updateConfig')} />
                  ) : null}
                  {errors[item.id] ? (
                    <p className="agent-error" role="alert">
                      {errors[item.id]}
                    </p>
                  ) : null}
                  <footer className="agent-card-actions">
                    {!item.archived ? (
                      <Button
                        size="sm"
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
                        <MessageSquarePlus data-icon="inline-start" aria-hidden="true" />
                        {start.isPending && start.variables?.id === item.id
                          ? t('agents.starting')
                          : t('agents.startSession')}
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={pending || (!canManage && !item.archived)}
                      onClick={() => setModal({ type: 'editor', item })}
                    >
                      {item.archived ? t('agents.viewConfig') : t('agents.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canManage || pending}
                      aria-label={t('agents.copyLabel', { name: item.config.name })}
                      onClick={() => void duplicate(item)}
                    >
                      <Copy data-icon="inline-start" aria-hidden="true" />
                      {t('agents.copy')}
                    </Button>
                    {!item.archived ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canManage || pending}
                        aria-label={t('agents.archiveLabel', { name: item.config.name })}
                        onClick={() => setModal({ type: 'archive', item })}
                      >
                        <Archive data-icon="inline-start" aria-hidden="true" />
                        {t('agents.archive')}
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
  const { t } = useUiTranslation('extensions');
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
      onSaved(t('agents.archivedNotice', { name: item.config.name }));
      onClose();
    } catch {
      // The mutation error stays visible in this confirmation dialog.
    } finally {
      lock.current = false;
    }
  }
  return (
    <AgentDialog
      title={t('agents.archiveTitle')}
      description={t('agents.archiveHelp')}
      busy={mutation.isPending}
      onClose={onClose}
    >
      <p>{t('agents.archiveConfirmation', { name: item.config.name, version: item.version })}</p>
      {mutation.error ? (
        <p className="agent-error" role="alert">
          {t('agents.archiveError', { error: messageOf(mutation.error) })}
        </p>
      ) : null}
      <footer className="agent-dialog-actions">
        <Button variant="secondary" disabled={mutation.isPending} onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="destructive"
          disabled={mutation.isPending || Boolean(mutation.error)}
          onClick={() => void archive()}
        >
          {mutation.isPending ? t('agents.archiving') : t('agents.confirmArchive')}
        </Button>
      </footer>
    </AgentDialog>
  );
}

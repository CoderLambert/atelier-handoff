/**
 * @file 提供项目扩展目录、Skill 继承与内置 Hooks 设置页面。
 * @implementation 按类型、搜索词和状态展示项目扩展，在相应标签内加载 Skill 继承或项目 RTK 设置。
 * @updated 2026-11-26T02:07:02+08:00
 */
import { useUiTranslation } from '@/i18n';
import { useInvalidateSkillCatalogs } from '@/use-query/skill-inheritance/keys';
import { useDeferredValue, useId, useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import type { Extension, Project } from '@shared/types';
import { FolderPlus, Monitor, Plus, RefreshCw, Store, Trash2, Webhook } from 'lucide-react';
import { CatalogProjectSelect, CatalogToolbar } from '@/components/catalog-toolbar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  ActionButton,
  ErrorMessage,
  ExtensionKindIcon,
  FeatureDialog,
  SourceLink,
} from './components';
import {
  autoEnabled,
  allowsAuto,
  extensionKeys,
  extensionDetail,
  kinds,
  messageOf,
  testLabels,
  useExtensionMutation,
  useExtensions,
  useInvalidateExtensionPickers,
  type ExtensionKind,
  type StartSkill,
} from './api';
import { ExtensionEditor } from './editor';
import { GlobalSkillInheritance, ProjectSkillInheritance } from './inheritance-settings';
import { RtkHookSettings } from './rtk-settings';
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
type ExtensionTab = ExtensionKind | 'hook';
const tabs: ExtensionTab[] = ['skill', 'command', 'mcp', 'hook'];
export interface ExtensionsPageProps {
  projects: Project[];
  projectId?: string;
  onStartSkill?: StartSkill;
}
export default function ExtensionsPage({ projects, projectId, onStartSkill }: ExtensionsPageProps) {
  const { t } = useUiTranslation('extensions');
  const [pinnedId, setPinnedId] = useState<string>();
  const [globalSkills, setGlobalSkills] = useState(false);
  const project =
    projects.find((value) => value.id === pinnedId) ??
    projects.find((value) => value.id === projectId) ??
    projects[0];
  return (
    <section className="ext-page" aria-label={t('extensions.pageTitle')}>
      <header className="ext-heading">
        <div>
          <p className="ext-eyebrow">{t('extensions.eyebrow')}</p>
          <h1>{t('extensions.pageTitle')}</h1>
          <p className="ext-subtitle">{t('extensions.subtitle')}</p>
        </div>
        {!globalSkills ? (
          <CatalogProjectSelect
            className="ext-project-label"
            label={t('common.currentProject')}
            selectLabel={t('extensions.projectSelector')}
            value={project?.id ?? ''}
            options={projects.map((value) => ({
              value: value.id,
              label: value.name || value.path || value.id,
            }))}
            emptyLabel={t('common.noProjects')}
            onValueChange={setPinnedId}
          />
        ) : null}
      </header>
      <ProjectExtensions
        key={project?.id ?? 'none'}
        project={project}
        onStartSkill={onStartSkill}
        globalSkills={globalSkills}
        onSkillScopeChange={setGlobalSkills}
      />
    </section>
  );
}
function ProjectExtensions({
  project,
  onStartSkill,
  globalSkills,
  onSkillScopeChange,
}: {
  project?: Project;
  onStartSkill?: ExtensionsPageProps['onStartSkill'];
  globalSkills: boolean;
  onSkillScopeChange: (global: boolean) => void;
}) {
  const { t } = useUiTranslation('extensions');
  const projectId = project?.id ?? '';
  const query = useExtensions(projectId);
  const invalidatePickers = useInvalidateExtensionPickers();
  const toggle = useExtensionMutation(projectId);
  const invalidateSkills = useInvalidateSkillCatalogs(projectId);
  const pending = useIsMutating({ mutationKey: extensionKeys.mutations(projectId) }) > 0;
  const [kind, setKind] = useState<ExtensionTab>('skill');
  const showGlobal = kind === 'skill' && globalSkills;
  function selectKind(value: ExtensionTab) {
    setKind(value);
    if (value !== 'skill') onSkillScopeChange(false);
  }
  const [search, setSearch] = useState('');
  const searchText = useDeferredValue(search.trim().toLocaleLowerCase());
  const [filter, setFilter] = useState('all');
  const [modal, setModal] = useState<Modal>();
  const [notice, setNotice] = useState('');
  const [startingSkill, setStartingSkill] = useState<string>();
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
      if (item.kind === 'skill') await invalidateSkills();
      setNotice(
        field === 'autoInvoke'
          ? old
            ? t('extensions.autoOff')
            : t('extensions.autoOn')
          : old
            ? t('extensions.disabledNotice')
            : t('extensions.enabledNotice'),
      );
    } catch (cause) {
      setErrors((value) => ({ ...value, [item.id]: messageOf(cause) }));
    }
  }
  async function startSkill(item: Extension) {
    if (!onStartSkill || startingSkill) return;
    setStartingSkill(item.id);
    setErrors((value) => ({ ...value, [item.id]: '' }));
    try {
      await onStartSkill(projectId, { id: item.id, version: item.version }, false);
    } catch (cause) {
      setErrors((value) => ({ ...value, [item.id]: messageOf(cause) }));
    } finally {
      setStartingSkill(undefined);
    }
  }
  const navigation = (
    <>
      <div className="ext-tabs" role="tablist" aria-label={t('extensions.tabsLabel')}>
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
            onClick={() => selectKind(value)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
              const nextKind = tabs[next];
              if (nextKind) selectKind(nextKind);
              tabRefs.current[next]?.focus();
            }}
          >
            <span className="ext-tab-mark" aria-hidden="true">
              {value === 'hook' ? <Webhook /> : <ExtensionKindIcon kind={value} />}
            </span>
            {value === 'hook' ? t('hooks.tab') : kinds[value]}
            {value !== 'hook' ? (
              <span className="ext-count">
                {query.data ? items.filter((item) => item.kind === value).length : '—'}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {kind === 'skill' ? (
        <div className="my-4 flex flex-wrap gap-2" role="group" aria-label={t('inheritance.scopeLabel')}>
          <Button type="button" size="sm" variant={showGlobal ? 'ghost' : 'secondary'}
            aria-pressed={!showGlobal} onClick={() => onSkillScopeChange(false)}>
            <FolderPlus data-icon="inline-start" aria-hidden="true" />
            {t('inheritance.projectSkills')}
          </Button>
          <Button type="button" size="sm" variant={showGlobal ? 'secondary' : 'ghost'}
            aria-pressed={showGlobal} onClick={() => onSkillScopeChange(true)}>
            <Monitor data-icon="inline-start" aria-hidden="true" />
            {t('inheritance.local')}
            <Badge variant="outline" aria-hidden="true">{t('inheritance.global')}</Badge>
          </Button>
        </div>
      ) : null}
    </>
  );
  if (kind === 'hook') {
    return (
      <>
        {navigation}
        <section id={`${id}-results`} role="tabpanel" aria-labelledby={`${id}-hook`} tabIndex={0}>
          <RtkHookSettings projectId={project?.id} />
        </section>
      </>
    );
  }
  if (showGlobal) {
    return (
      <>
        {navigation}
        <section id={`${id}-results`} role="tabpanel" aria-labelledby={`${id}-${kind}`} tabIndex={0}>
          <GlobalSkillInheritance />
        </section>
      </>
    );
  }
  return (
    <>
      {navigation}
      <CatalogToolbar
        className="ext-toolbar"
        search={{
          label: t('extensions.searchLabel'),
          placeholder: t('extensions.searchPlaceholder'),
          value: search,
          onChange: setSearch,
        }}
        filter={{
          label: t('common.status'),
          value: filter,
          options: [
            { value: 'all', label: t('common.all') },
            { value: 'enabled', label: t('common.enabled') },
            { value: 'disabled', label: t('common.disabled') },
          ],
          onChange: setFilter,
        }}
      >
        {kind === 'skill' ? (
          <ActionButton
            variant="default"
            disabled={!projectId || pending}
            onClick={() => setModal({ type: 'market' })}
          >
            <Store data-icon="inline-start" aria-hidden="true" />
            {t('extensions.market')}
          </ActionButton>
        ) : null}
        <ActionButton
          disabled={!projectId || pending}
          onClick={() => setModal({ type: 'public', kind })}
        >
          {t('extensions.publicImport')}
        </ActionButton>
        {kind !== 'mcp' ? (
          <ActionButton
            disabled={!projectId || pending}
            onClick={() => setModal({ type: 'editor', kind, importFile: true })}
          >
            {t('extensions.importMarkdown')}
          </ActionButton>
        ) : null}
        <ActionButton
          disabled={!projectId || query.isPending || pending}
          onClick={() => setModal({ type: 'editor', kind })}
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
          {kind === 'mcp'
            ? t('extensions.addMcp')
            : t('extensions.createKind', { kind: kinds[kind] })}
        </ActionButton>
      </CatalogToolbar>
      <p className="ext-scope-note">
        {kind === 'mcp'
          ? t('extensions.mcpScope')
          : kind === 'skill'
            ? t('extensions.skillScope')
            : t('extensions.commandScope')}
      </p>
      <div className="ext-page-message" role="status" aria-live="polite">
        {notice}
      </div>
      {query.error ? (
        <div className="ext-error" role="alert">
          {messageOf(query.error)}{' '}
          <ActionButton
            disabled={query.isFetching}
            onClick={() => {
              void query.refetch();
              void invalidatePickers();
            }}
          >
            <RefreshCw data-icon="inline-start" aria-hidden="true" />
            {t('common.reload')}
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
        {project && kind === 'skill' ? <ProjectSkillInheritance projectId={projectId} /> : null}
        {!project ? (
          <div className="ext-empty">
            <span aria-hidden="true">
              <FolderPlus />
            </span>
            <h2>{t('common.bindProject')}</h2>
            <p>{t('extensions.bindHelp')}</p>
          </div>
        ) : query.isPending ? (
          <p className="ext-loading" role="status">
            {t('extensions.loading')}
          </p>
        ) : !visible.length ? (
          query.isError && !query.data ? null : (
            <div className="ext-empty">
              <span aria-hidden="true">
                <ExtensionKindIcon kind={kind} />
              </span>
              <h2>
                {searchText || filter !== 'all'
                  ? t('extensions.noMatches')
                  : t('extensions.noKind', { kind: kinds[kind] })}
              </h2>
              <p>
                {searchText || filter !== 'all'
                  ? t('common.trySearch')
                  : kind === 'mcp'
                    ? t('extensions.mcpEmptyHelp')
                    : t('extensions.markdownEmptyHelp')}
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
                    <ExtensionKindIcon kind={item.kind} />
                  </span>
                  <span className="ext-card-kind">{kinds[item.kind]}</span>
                  <Switch
                    className="ext-switch"
                    checked={item.enabled}
                    aria-label={`${item.enabled ? t('extensions.disable') : t('extensions.enable')} ${item.name}`}
                    disabled={pending}
                    onCheckedChange={() => void toggleItem(item, 'enabled')}
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
                <p className="ext-card-description">
                  {item.description || t('common.noDescription')}
                </p>
                <div className="ext-card-meta">
                  <span className={`ext-state-dot ${item.enabled ? 'ext-is-enabled' : ''}`}>
                    {item.enabled ? t('common.enabled') : t('common.disabled')}
                  </span>
                  {item.kind === 'mcp' ? (
                    <span className="ext-status" data-ext-status={item.status || 'untested'}>
                      <span aria-hidden="true" />
                      {item.status ? testLabels[item.status] : t('extensions.untested')}
                    </span>
                  ) : (
                    <span>
                      {item.userInvocable === false
                        ? t('extensions.manualUnsupported')
                        : t('extensions.manualAvailable')}
                    </span>
                  )}
                  <span className="ext-version">v{item.version}</span>
                </div>
                {item.kind !== 'mcp' && (!item.supported || item.compatibility) ? (
                  <p className="ext-compatibility">
                    {extensionDetail(item.compatibility) || t('extensions.unsupported')}
                  </p>
                ) : null}
                <p className="ext-card-source">
                  {item.kind === 'mcp' ? (
                    <>
                      {item.transport.type === 'stdio'
                        ? item.transport.command
                        : item.transport.url}
                      <span>
                        {t('extensions.allowedCount', { count: item.allowedTools.length })}
                      </span>
                    </>
                  ) : (
                    item.source || t('extensions.createdLocally')
                  )}
                </p>
                {item.kind === 'skill' ? (
                  <div className="ext-auto-setting">
                    <span>{t('extensions.autoLabel')}</span>
                    <Switch
                      className="ext-switch"
                      checked={autoEnabled(item)}
                      aria-label={t('extensions.autoToggleLabel', { name: item.name })}
                      aria-describedby={`${id}-auto-${item.id}`}
                      disabled={pending || !allowsAuto(item) || !item.supported}
                      onCheckedChange={() => void toggleItem(item, 'autoInvoke')}
                    />
                    <small id={`${id}-auto-${item.id}`}>
                      {!allowsAuto(item)
                        ? t('extensions.upstreamForbids')
                        : !item.supported
                          ? t('extensions.incompatibleAuto')
                          : !item.enabled
                            ? t('extensions.enableFirst')
                            : autoEnabled(item)
                              ? t('extensions.modelAutoHelp')
                              : t('extensions.autoOffHelp')}
                    </small>
                  </div>
                ) : null}
                {item.origin ? (
                  <p className="ext-card-source">
                    <SourceLink url={item.origin.location}>
                      {t('extensions.publicSource')}
                    </SourceLink>
                    <span title={item.origin.revision}>{item.origin.revision.slice(0, 12)}</span>
                  </p>
                ) : null}
                {item.kind === 'mcp' && item.statusMessage ? (
                  <p className="ext-test-message" data-ext-status={item.status}>
                    {extensionDetail(item.statusMessage)}
                  </p>
                ) : null}
                <ErrorMessage error={errors[item.id]} />
                <footer className="ext-card-actions">
                  <ActionButton
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => setModal({ type: 'editor', kind: item.kind, item })}
                  >
                    {t('extensions.viewEdit')}
                  </ActionButton>
                  {item.kind === 'skill' && item.origin?.github && item.userInvocable && item.enabled && onStartSkill ? (
                    <ActionButton
                      variant="ghost"
                      size="sm"
                      disabled={pending || Boolean(startingSkill)}
                      onClick={() => void startSkill(item)}
                    >
                      {t('market.useInChat')}
                    </ActionButton>
                  ) : null}
                  {item.origin ? (
                    <ActionButton
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => setModal({ type: 'public', kind: item.kind, item })}
                    >
                      {t('extensions.checkUpdates')}
                    </ActionButton>
                  ) : null}
                  {item.kind === 'mcp' ? (
                    <ActionButton
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        setModal({ type: 'editor', kind: 'mcp', item, testOnOpen: true })
                      }
                    >
                      {t('extensions.testConnection')}
                    </ActionButton>
                  ) : null}
                  <ActionButton
                    variant="destructive"
                    size="sm"
                    className="ms-auto"
                    disabled={pending}
                    onClick={() => setModal({ type: 'delete', item })}
                  >
                    <Trash2 data-icon="inline-start" aria-hidden="true" />
                    {t('extensions.delete')}
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
          onStartSkill={onStartSkill}
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
  const { t } = useUiTranslation('extensions');
  const mutation = useExtensionMutation(projectId);
  async function remove() {
    if (mutation.isPending) return;
    try {
      await mutation.mutateAsync({
        suffix: encodeURIComponent(item.id),
        method: 'DELETE',
        removeId: item.id,
      });
      onSaved(t('extensions.deleted'));
      onClose();
    } catch {
      /* The mutation error is shown in place. */
    }
  }
  return (
    <FeatureDialog title={t('extensions.deleteTitle')} busy={mutation.isPending} onClose={onClose}>
      <p>{t('extensions.deleteConfirmation', { name: item.name })}</p>
      <p className="ext-help">{t('extensions.deleteHelp')}</p>
      <ErrorMessage error={mutation.error} />
      <div className="ext-dialog-actions">
        <ActionButton disabled={mutation.isPending} onClick={onClose}>
          {t('common.cancel')}
        </ActionButton>
        <ActionButton
          variant="destructive"
          disabled={mutation.isPending}
          onClick={() => void remove()}
        >
          {mutation.isPending ? t('extensions.deleting') : t('extensions.confirmDelete')}
        </ActionButton>
      </div>
    </FeatureDialog>
  );
}

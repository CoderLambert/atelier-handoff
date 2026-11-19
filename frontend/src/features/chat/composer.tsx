/**
 * @file 提供聊天任务输入、上下文与附件编辑界面。
 * @implementation 根据会话和智能体状态控制发送及停止，将文件选择、粘贴和拖入交给附件编排 hook，并展示处理状态与错误。
 * @updated 2026-11-20T03:34:05+08:00
 */
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, Paperclip, Plus, X } from 'lucide-react';
import type { Draft } from '@shared/types';
import { attachmentAccept } from '@/use-query/attachments/use-upload-attachment';
import type { Snapshot } from '@/api/types';
import { Button } from '@/components/ui/button';
import { ExtensionPicker } from '@/features/extensions/picker';
import { AttachmentPreview } from './attachment-preview';
import { ContextPicker } from './context-picker';
import { isActive } from './conversation';

import { useComposerAttachments, type DraftChange } from './hooks/use-composer-attachments';

export type { DraftChange } from './hooks/use-composer-attachments';
const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试');

export function Composer({
  snapshot,
  draft,
  onDraftChange,
  onSend,
  onStop,
  submitting,
}: {
  snapshot: Snapshot;
  draft: Draft;
  onDraftChange: DraftChange;
  onSend: () => Promise<void>;
  onStop: (runId: string) => void;
  submitting: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sendLock = useRef(false);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [error, setError] = useState('');
  const sessionId = snapshot.session.id;
  const agent = snapshot.agent;
  const contextAllowed = !agent || agent.capabilities.includes('context');
  const attachmentsAllowed = !agent || agent.capabilities.includes('attachments');
  const archived = snapshot.session.status === 'archived';
  const run = snapshot.runs.find(isActive);
  const {
    uploads,
    removing,
    pendingOperations,
    busy,
    canUpload,
    queueUpload,
    removeAttachment,
    dismissUpload,
  } = useComposerAttachments({
    sessionId,
    draft,
    onDraftChange,
    attachmentsAllowed,
    archived,
    submitting,
    onError: setError,
  });
  const dropAllowed = canUpload && draft.attachmentIds.length < 20;
  const canSend =
    !archived &&
    snapshot.project.available &&
    !run &&
    !submitting &&
    !busy &&
    !agent?.issues.length &&
    Boolean(draft.text.trim());
  const attachments = new Map(
    snapshot.attachments.map((attachment) => [attachment.id, attachment]),
  );

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.max(48, Math.min(240, input.scrollHeight))}px`;
    input.style.overflowY = input.scrollHeight > 240 ? 'auto' : 'hidden';
  }, [draft.text]);

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!canSend || pendingOperations.current || sendLock.current) return;
    sendLock.current = true;
    setError('');
    try {
      await onSend();
    } catch (failure) {
      setError(`发送未确认，可使用相同内容重试：${errorText(failure)}`);
    } finally {
      sendLock.current = false;
    }
  }

  return (
    <form
      className="composer chat-composer"
      aria-label="撰写任务"
      data-file-drag={dragging}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = dropAllowed ? 'copy' : 'none';
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files') && !event.dataTransfer.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = 0;
        setDragging(false);
        if (!canUpload || pendingOperations.current) {
          setError(
            !attachmentsAllowed
              ? '当前智能体未启用附件。'
              : '当前无法添加附件，请等操作结束后重试。',
          );
          return;
        }
        queueUpload(event.dataTransfer.files);
      }}
      onSubmit={(event) => void submit(event)}
    >
      <div className="context-row">
        <div className="context-chips" aria-label="草稿上下文和附件">
          {draft.contextPaths.map((path) => (
            <button
              key={path}
              type="button"
              className="context-chip"
              disabled={archived || submitting}
              aria-label={`移除上下文 ${path}`}
              title={path}
              onClick={() =>
                onDraftChange((previous) => ({
                  ...previous,
                  contextPaths: previous.contextPaths.filter((value) => value !== path),
                }))
              }
            >
              上下文 · {path} ×
            </button>
          ))}
          {draft.attachmentIds.map((id) => {
            const item = attachments.get(id);
            const name = item?.name ?? id;
            const isRemoving = removing.includes(id);
            return (
              <div key={id} className="context-chip attachment-chip">
                {item ? (
                  <AttachmentPreview attachment={item}>
                    <Paperclip size={13} aria-hidden="true" />
                    {name}
                  </AttachmentPreview>
                ) : (
                  <span>{name}</span>
                )}
                <button
                  type="button"
                  className="attachment-remove"
                  disabled={archived || submitting || isRemoving}
                  aria-label={`移除附件 ${name}`}
                  title={isRemoving ? '移除中…' : '移除附件'}
                  onClick={() => removeAttachment(id)}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {uploads.map((entry) =>
            entry.error ? (
              <button
                key={entry.id}
                type="button"
                className="context-chip chat-upload-error"
                aria-label={`移除失败的上传 ${entry.name}：${entry.error}`}
                onClick={() => dismissUpload(entry.id)}
              >
                {entry.name} · 失败：{entry.error} ×
              </button>
            ) : (
              <span key={entry.id} className="context-chip" role="status">
                {entry.name} · 上传中…
              </span>
            ),
          )}
        </div>
        <button
          type="button"
          className="add-context"
          disabled={!contextAllowed || archived || submitting || !snapshot.project.available}
          onClick={() => setContextOpen(true)}
        >
          <Plus size={14} aria-hidden="true" /> 上下文
        </button>
        <button
          type="button"
          className="composer-policy mode-toggle"
          disabled={archived || submitting || agent?.mode === 'readonly'}
          aria-pressed={draft.mode === 'edit'}
          title="受控修改模式中的每次写入操作仍需审批"
          onClick={() =>
            onDraftChange((previous) => ({
              ...previous,
              mode: previous.mode === 'edit' ? 'readonly' : 'edit',
            }))
          }
        >
          {draft.mode === 'edit' ? '模式：受控修改（逐次审批）' : '模式：只读'}
        </button>
      </div>
      {agent?.issues.length ? (
        <p className="text-sm text-destructive" role="status">
          {agent.issues.join('；')}。
          {agent.canUpgrade ? '可从会话顶部使用新版智能体。' : '在智能体管理中检查依赖并发布新版。'}
        </p>
      ) : null}
      {agent?.starters.length && !snapshot.messages.length && !archived ? (
        <div className="mb-2 flex flex-wrap gap-2" aria-label="开场任务">
          {agent.starters.map((starter) => (
            <Button
              key={starter}
              size="sm"
              variant="outline"
              onClick={() => {
                onDraftChange((previous) => ({ ...previous, text: starter }));
                inputRef.current?.focus();
              }}
            >
              {starter}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="composer-box">
        <label className="composer-label" htmlFor="prompt-input">
          {archived ? '已归档的会话' : '继续对话'}
        </label>
        <textarea
          ref={inputRef}
          id="prompt-input"
          rows={2}
          maxLength={32000}
          value={draft.text}
          disabled={archived}
          aria-describedby="input-help chat-composer-error"
          placeholder="输入消息…（/ 调用 Command 或 Skill，# 选择 MCP）"
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
              .filter((file) => file.type === 'image/png' || file.type === 'image/jpeg')
              .map(
                (file, index) =>
                  new File(
                    [file],
                    `截图-${Date.now()}-${index + 1}.${file.type === 'image/png' ? 'png' : 'jpg'}`,
                    { type: file.type },
                  ),
              );
            if (!files.length) return;
            if (!event.clipboardData.getData('text/plain')) event.preventDefault();
            if (
              !attachmentsAllowed ||
              archived ||
              submitting ||
              busy ||
              pendingOperations.current
            ) {
              setError(
                !attachmentsAllowed
                  ? '当前智能体未启用附件。'
                  : '当前无法粘贴截图，请等操作结束后重试。',
              );
              return;
            }
            queueUpload(files);
          }}
          onChange={(event) => {
            const text = event.target.value;
            onDraftChange((previous) => ({ ...previous, text }));
          }}
        />
        <fieldset className="chat-extension-fieldset" disabled={archived || submitting}>
          <legend className="sr-only">任务扩展</legend>
          <ExtensionPicker
            projectId={archived ? undefined : snapshot.project.id}
            agent={agent}
            draft={draft}
            onChange={(next: Draft) => {
              if (!archived && !submitting) onDraftChange(next);
            }}
            inputRef={inputRef}
            onSubmit={() => void submit()}
          />
        </fieldset>
        <div className="composer-toolbar">
          <span className="composer-run-status" role="status">
            {dragging
              ? dropAllowed
                ? '松开以添加附件'
                : '当前无法添加附件'
              : submitting
                ? '正在发送…'
                : busy
                  ? '正在处理附件…'
                  : run
                    ? (
                        {
                          queued: '排队中',
                          running: '执行中',
                          awaiting_permission: '等待审批',
                          stopping: '正在停止',
                        } as Record<string, string>
                      )[run.status]
                    : ''}
          </span>
          {run ? (
            <Button
              type="button"
              variant="outline"
              className="btn btn-secondary composer-stop"
              disabled={run.status === 'stopping'}
              onClick={() => onStop(run.id)}
            >
              {run.status === 'stopping' ? '正在停止…' : '停止'}
            </Button>
          ) : null}
          <button
            type="button"
            className="icon-button attach-button"
            disabled={
              !attachmentsAllowed ||
              archived ||
              submitting ||
              busy ||
              draft.attachmentIds.length >= 20
            }
            aria-label="上传附件"
            title="上传文本或 PNG、JPEG 图片"
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip size={18} aria-hidden="true" />
          </button>
          <span className="send-hint" id="input-help">
            Enter 发送
          </span>
          <button type="submit" className="send-button" disabled={!canSend} aria-label="发送任务">
            <ArrowUp size={20} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="composer-footer">
        <span>Shift + Enter 换行</span>
        <span>
          {draft.mode === 'edit' ? '受控修改 · 每次操作逐次审批' : '只读 · 先讨论，再决定'}
        </span>
      </div>
      <p id="chat-composer-error" className="chat-composer-error" role="alert">
        {error ||
          (archived
            ? '会话已归档，无法发送或修改草稿。'
            : !snapshot.project.available
              ? '项目目录当前不可用，暂时无法发送任务。'
              : '')}
      </p>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={attachmentAccept}
        hidden
        onChange={(event) => {
          queueUpload(event.target.files);
          event.target.value = '';
        }}
      />
      {contextOpen && !archived && !submitting ? (
        <ContextPicker
          projectId={snapshot.project.id}
          selectedPaths={draft.contextPaths}
          onSelect={(path) =>
            onDraftChange((previous) => ({
              ...previous,
              contextPaths: [...new Set([...previous.contextPaths, path])],
            }))
          }
          onClose={() => {
            setContextOpen(false);
            inputRef.current?.focus();
          }}
        />
      ) : null}
    </form>
  );
}

import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Paperclip, Plus } from 'lucide-react';
import type { Attachment, Draft } from '@shared/types';
import { api } from '@/api/client';
import type { Snapshot } from '@/api/types';
import { Button } from '@/components/ui/button';
import { ExtensionPicker } from '@/features/extensions/picker';
import { ContextPicker } from './context-picker';
import { isActive } from './conversation';

export type DraftChange = (draft: Draft | ((previous: Draft) => Draft)) => void;
interface UploadEntry {
  id: string;
  name: string;
  error?: string;
}
type AttachmentOperation = {
  sessionId: string;
  // Capture this callback when queuing, before a session switch can replace props.
  changeDraft: DraftChange;
} & ({ kind: 'upload'; file: File; entryId: string } | { kind: 'remove'; attachmentId: string });
const ACCEPT = '.txt,.md,.json,.csv,.js,.ts,.jsx,.tsx,.css,.html,.yaml,.yml,.log,.py';
const textFile = /\.(txt|md|json|csv|js|ts|jsx|tsx|css|html|yaml|yml|log|py)$/i;
const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作失败，请重试');

async function attachmentOperation(operation: AttachmentOperation): Promise<Attachment | null> {
  const path = `/api/sessions/${encodeURIComponent(operation.sessionId)}/attachments`;
  if (operation.kind === 'remove') {
    await api(`${path}/${encodeURIComponent(operation.attachmentId)}`, { method: 'DELETE' });
    return null;
  }
  const file = operation.file;
  if (file.size > 1024 * 1024 || !textFile.test(file.name))
    throw new Error('仅支持 1 MiB 以内的文本文件');
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (bytes.includes(0)) throw new Error();
  } catch {
    throw new Error('请上传 UTF-8 文本文件');
  }
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  const result = await api<{ attachment: Attachment }>(path, {
    method: 'POST',
    body: { name: file.name, mime: file.type || 'text/plain', contentBase64: btoa(binary) },
  });
  return result.attachment;
}

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
  const pendingOperations = useRef(0);
  const sendLock = useRef(false);
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [removing, setRemoving] = useState<string[]>([]);
  const [contextOpen, setContextOpen] = useState(false);
  const [error, setError] = useState('');
  const queryClient = useQueryClient();
  const sessionId = snapshot.session.id;
  const agent = snapshot.agent;
  const contextAllowed = !agent || agent.capabilities.includes('context');
  const attachmentsAllowed = !agent || agent.capabilities.includes('attachments');
  const archived = snapshot.session.status === 'archived';
  const run = snapshot.runs.find(isActive);
  const attachmentMutations = useIsMutating({ mutationKey: ['chat-attachments', sessionId] });
  const busy =
    attachmentMutations > 0 || uploads.some((entry) => !entry.error) || removing.length > 0;
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

  const mutation = useMutation({
    mutationKey: ['chat-attachments', sessionId],
    scope: { id: `session-attachments:${sessionId}` },
    mutationFn: attachmentOperation,
    retry: false,
    onSuccess: (attachment, operation) => {
      if (operation.kind === 'upload' && attachment) {
        operation.changeDraft((previous) => ({
          ...previous,
          attachmentIds: [...new Set([...previous.attachmentIds, attachment.id])],
        }));
        setUploads((previous) => previous.filter((entry) => entry.id !== operation.entryId));
      } else if (operation.kind === 'remove') {
        operation.changeDraft((previous) => ({
          ...previous,
          attachmentIds: previous.attachmentIds.filter((id) => id !== operation.attachmentId),
        }));
      }
    },
    onError: (failure, operation) => {
      if (operation.kind === 'upload') {
        setUploads((previous) =>
          previous.map((entry) =>
            entry.id === operation.entryId ? { ...entry, error: errorText(failure) } : entry,
          ),
        );
      } else setError(`移除附件失败：${errorText(failure)}`);
    },
    onSettled: (_result, _failure, operation) => {
      pendingOperations.current -= 1;
      if (operation.kind === 'remove')
        setRemoving((previous) => previous.filter((id) => id !== operation.attachmentId));
      void queryClient.invalidateQueries({ queryKey: ['snapshot', operation.sessionId] });
    },
  });

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
  function uploadFiles(files: FileList | null) {
    if (
      !files ||
      !attachmentsAllowed ||
      archived ||
      submitting ||
      busy ||
      pendingOperations.current
    )
      return;
    const available = Math.max(0, 20 - draft.attachmentIds.length);
    if (files.length > available) setError('每条任务最多附加 20 个附件，请移除部分附件后再上传。');
    for (const file of Array.from(files).slice(0, available)) {
      const entryId = crypto.randomUUID();
      pendingOperations.current += 1;
      setUploads((previous) => [...previous, { id: entryId, name: file.name }]);
      mutation.mutate({ kind: 'upload', sessionId, file, entryId, changeDraft: onDraftChange });
    }
  }
  function removeAttachment(attachmentId: string) {
    if (removing.includes(attachmentId) || archived || submitting) return;
    pendingOperations.current += 1;
    setRemoving((previous) => [...previous, attachmentId]);
    mutation.mutate({ kind: 'remove', sessionId, attachmentId, changeDraft: onDraftChange });
  }

  return (
    <form
      className="composer chat-composer"
      aria-label="撰写任务"
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
          {draft.attachmentIds.map((id) => (
            <button
              key={id}
              type="button"
              className="context-chip"
              disabled={archived || submitting || removing.includes(id)}
              aria-label={`移除附件 ${attachments.get(id)?.name || id}`}
              onClick={() => removeAttachment(id)}
            >
              附件 · {attachments.get(id)?.name || id} ·{' '}
              {removing.includes(id) ? '移除中…' : '已附加 ×'}
            </button>
          ))}
          {uploads.map((entry) =>
            entry.error ? (
              <button
                key={entry.id}
                type="button"
                className="context-chip chat-upload-error"
                aria-label={`移除失败的上传 ${entry.name}：${entry.error}`}
                onClick={() =>
                  setUploads((previous) => previous.filter((item) => item.id !== entry.id))
                }
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
          {agent.issues.join('；')}。从会话顶部进入智能体管理修复后，可使用新版本开始会话。
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
            {submitting
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
            aria-label="上传文本附件"
            title="上传 1 MiB 以内的 UTF-8 文本附件"
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
        accept={ACCEPT}
        hidden
        onChange={(event) => {
          uploadFiles(event.target.files);
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

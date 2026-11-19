import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import '@/desktop-files';
import type { ConfigInfo } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { AppConfig } from '@shared/types';
import { ErrorNotice, Icon, Loading, errorMessage, fieldClass } from './shared';

export default function SettingsDialog({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) {
  const settings = useQuery<ConfigInfo>({
    queryKey: ['config'],
    queryFn: ({ signal }) => api<ConfigInfo>('/api/config', { signal }),
    refetchOnWindowFocus: false,
    retry: false,
    gcTime: 0,
  });
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="settings" />
            模型与网关设置
          </DialogTitle>
          <DialogDescription>配置本机模型连接。保存后，新运行会使用这些设置。</DialogDescription>
        </DialogHeader>
        {settings.isPending ? <Loading>正在读取当前配置…</Loading> : null}
        {settings.error ? (
          <ErrorNotice
            message={errorMessage(settings.error)}
            onRetry={() => {
              void settings.refetch();
            }}
          />
        ) : null}
        <DiagnosticExport />
        {settings.data ? (
          <SettingsForm initial={settings.data} onOpenChange={onOpenChange} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
function DiagnosticExport() {
  const native = window.atelierDesktopFiles;
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  if (!native) return null;
  async function save() {
    setPending(true);
    setStatus('');
    try {
      if (await native?.exportDiagnostics()) setStatus('诊断文件已保存。');
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => void save()}
      >
        导出诊断
      </Button>
      {status ? (
        <p className="text-xs text-muted-foreground" role="status">
          {status}
        </p>
      ) : null}
    </div>
  );
}
function SettingsForm({
  initial,
  onOpenChange,
}: {
  initial: ConfigInfo;
  onOpenChange: (open: boolean) => void;
}) {
  const [gateway, setGateway] = useState(initial.config.gateway);
  const [model, setModel] = useState(initial.config.model);
  const [maxTurns, setMaxTurns] = useState(String(initial.config.maxTurns));
  const [timeoutMs, setTimeoutMs] = useState(String(initial.config.timeoutMs));
  const [validation, setValidation] = useState<string>();
  const [saved, setSaved] = useState<ConfigInfo>();
  const lock = useRef(false);
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (config: AppConfig) =>
      api<ConfigInfo>('/api/config', { method: 'PATCH', body: config }),
    onSuccess: (data) => {
      setSaved(data);
      client.setQueryData(['config'], data);
      void client.invalidateQueries({ queryKey: ['bootstrap'] });
    },
  });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) return;
    setValidation(undefined);
    setSaved(undefined);
    let url: URL;
    try {
      url = new URL(gateway.trim());
    } catch {
      setValidation('请输入有效的本机网关 URL。');
      return;
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      setValidation(
        '网关须为 http 或 https 的 localhost / 127.0.0.1 地址，不能包含凭据、查询参数或片段。',
      );
      return;
    }
    const turns = Number(maxTurns);
    const timeout = Number(timeoutMs);
    if (!model.trim() || model.trim().length > 200) {
      setValidation('模型名称须为 1–200 个字符。');
      return;
    }
    if (!Number.isInteger(turns) || turns < 1 || turns > 100) {
      setValidation('最大轮数须为 1–100 的整数。');
      return;
    }
    if (!Number.isInteger(timeout) || timeout < 10000 || timeout > 1800000) {
      setValidation('超时须为 10,000–1,800,000 毫秒的整数。');
      return;
    }
    lock.current = true;
    try {
      await mutation.mutateAsync({
        gateway: gateway.trim().replace(/\/$/, ''),
        model: model.trim(),
        maxTurns: turns,
        timeoutMs: timeout,
      });
    } catch {
      /* The mutation exposes the server error below. */
    } finally {
      lock.current = false;
    }
  }
  const connection = saved?.connection ?? initial.connection;
  const change = () => {
    setSaved(undefined);
    setValidation(undefined);
    mutation.reset();
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-5">
      <div
        role="status"
        className={`rounded-xl border p-3.5 text-xs leading-6 ${connection.available ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-800 dark:text-emerald-200' : 'border-amber-500/20 bg-amber-500/5 text-amber-800 dark:text-amber-200'}`}
      >
        <p className="flex items-center gap-2 font-medium">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
          {connection.available ? '本机网关可访问' : '本机网关未连接'}
        </p>
        <p className="mt-1">{connection.message}</p>
      </div>
      <label className="grid gap-2 text-xs font-medium">
        网关地址
        <input
          autoComplete="url"
          type="url"
          required
          disabled={mutation.isPending}
          className={fieldClass}
          value={gateway}
          onChange={(event) => {
            change();
            setGateway(event.target.value);
          }}
          placeholder="http://127.0.0.1:3001"
        />
        <span className="text-[11px] font-normal text-muted-foreground">使用本机 Shunt 地址。</span>
      </label>
      <label className="grid gap-2 text-xs font-medium">
        模型
        <input
          required
          maxLength={200}
          disabled={mutation.isPending}
          className={fieldClass}
          value={model}
          onChange={(event) => {
            change();
            setModel(event.target.value);
          }}
          placeholder="输入网关支持的模型名称"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-2 text-xs font-medium">
          最大轮数
          <input
            required
            type="number"
            min={1}
            max={100}
            step={1}
            disabled={mutation.isPending}
            className={fieldClass}
            value={maxTurns}
            onChange={(event) => {
              change();
              setMaxTurns(event.target.value);
            }}
          />
          <span className="text-[11px] font-normal text-muted-foreground">1–100 轮</span>
        </label>
        <label className="grid gap-2 text-xs font-medium">
          超时（毫秒）
          <input
            required
            type="number"
            min={10000}
            max={1800000}
            step={1}
            disabled={mutation.isPending}
            className={fieldClass}
            value={timeoutMs}
            onChange={(event) => {
              change();
              setTimeoutMs(event.target.value);
            }}
          />
          <span className="text-[11px] font-normal text-muted-foreground">10 秒至 30 分钟</span>
        </label>
      </div>
      <p className="text-[11px] leading-6 text-muted-foreground">
        命令执行：
        {(saved ?? initial).capabilities.commands ? '可用，仍需逐次审批' : '当前环境不可用'}
      </p>
      {validation ? <ErrorNotice message={validation} /> : null}
      {mutation.error ? <ErrorNotice message={errorMessage(mutation.error)} /> : null}
      {saved ? (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300"
        >
          <Icon name="check" />
          设置已保存{saved.connection.available ? '，网关可访问。' : '，请检查网关连接。'}
        </p>
      ) : null}
      <DialogFooter className="border-t border-border pt-4">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          {saved ? '完成' : '取消'}
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? '正在保存并检测…' : '保存设置'}
        </Button>
      </DialogFooter>
    </form>
  );
}

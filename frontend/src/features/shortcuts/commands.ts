/**
 * @file 定义快捷命令的展示契约。
 * @implementation 用稳定命令标识映射双语标签与图标，业务回调和可用性由工作台适配器注入。
 * @updated 2026-11-26T22:00:00+08:00
 */
import {
  ArrowDown,
  ArrowUp,
  GitBranch,
  Globe,
  Keyboard,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Settings2,
  Terminal,
  TextCursorInput,
  type LucideIcon,
} from 'lucide-react';
import { useUiTranslation } from '@/i18n';

export interface ShortcutCommand {
  id: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  available: boolean;
  run: () => void;
}

export function useShortcutCommandLabels() {
  const { t } = useUiTranslation('shortcuts');
  return {
    'shortcuts.navigator': { label: t('navigatorTitle'), icon: Keyboard },
    'sessions.switch': { label: t('switcherTitle'), icon: MessageSquare },
    'layout.toggleLeft': { label: t('command.toggleLeft'), icon: PanelLeft },
    'layout.toggleRight': { label: t('command.toggleRight'), icon: PanelRight },
    'sessions.previous': { label: t('command.previous'), icon: ArrowUp },
    'sessions.next': { label: t('command.next'), icon: ArrowDown },
    'panels.git': { label: t('command.git'), icon: GitBranch },
    'panels.terminal': { label: t('command.terminal'), icon: Terminal },
    'panels.browser': { label: t('command.browser'), icon: Globe },
    'composer.focus': { label: t('command.focus'), icon: TextCursorInput },
    'shortcuts.settings': { label: t('settingsTitle'), icon: Settings2 },
  };
}

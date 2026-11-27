/**
 * @file 注册随应用编译的受信功能面板。
 * @implementation 三个静态定义分离元数据和组件加载，不执行注册副作用或加载外部代码。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { GitBranch, Globe, TerminalSquare } from 'lucide-react';
import type { PanelDefinition } from '@/panel-sdk';
import type { TerminalPanelProps } from '@/features/terminal';
import type { GitPanelProps } from './git-panel';
import type { BrowserPanelProps } from './browser-panel';

export const panels = {
  browser: {
    manifest: {
      apiVersion: 1,
      id: 'atelier.browser',
      titleKey: 'workbench:browser.title',
      scope: 'project',
      slot: 'right',
    },
    icon: Globe,
    load: () => import('./browser-panel'),
  } satisfies PanelDefinition<BrowserPanelProps>,
  git: {
    manifest: {
      apiVersion: 1,
      id: 'atelier.git',
      titleKey: 'git:title',
      scope: 'project',
      slot: 'right',
    },
    icon: GitBranch,
    load: () => import('./git-panel'),
  } satisfies PanelDefinition<GitPanelProps>,
  terminal: {
    manifest: {
      apiVersion: 1,
      id: 'atelier.terminal',
      titleKey: 'terminal:title',
      scope: 'session',
      slot: 'right',
    },
    icon: TerminalSquare,
    load: () => import('@/features/terminal'),
  } satisfies PanelDefinition<TerminalPanelProps>,
};

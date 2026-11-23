/**
 * @file 编辑桌面工作区的主题皮肤与默认面板宽度。
 * @implementation 提供带有微型预览的主题弹出列表，并校验保存导航栏与浏览器面板的默认宽度。
 * @updated 2026-11-23T13:15:00+08:00
 */
import { useUiTranslation } from '@/i18n';
import { useId, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemePicker } from '@/components/theme-picker';
import { useUiTheme } from '@/theme';
import {
  initialWorkspaceLayout,
  minNavigationWidth,
  maxNavigationWidth,
  minInspectorWidth,
  maxInspectorWidth,
  paneWidthsSchema,
  type WorkspaceLayout,
} from '@shared/workspace-layout';

export interface WorkspaceLayoutFormProps {
  layout: WorkspaceLayout;
  pending: boolean;
  error?: string;
  onApply: (layout: WorkspaceLayout) => void;
}

export function WorkspaceLayoutForm({ layout, pending, error, onApply }: WorkspaceLayoutFormProps) {
  const { t } = useUiTranslation('inspector');
  const { theme, setTheme } = useUiTheme();
  const id = useId();
  const [left, setLeft] = useState(String(layout.defaults.left));
  const [right, setRight] = useState(String(layout.defaults.right));
  const widths = paneWidthsSchema.safeParse({ left: Number(left), right: Number(right) });
  const invalidLeft =
    !Number.isInteger(Number(left)) ||
    Number(left) < minNavigationWidth ||
    Number(left) > maxNavigationWidth;
  const invalidRight =
    !Number.isInteger(Number(right)) ||
    Number(right) < minInspectorWidth ||
    Number(right) > maxInspectorWidth;
  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending && widths.success)
          onApply({ defaults: widths.data, recent: widths.data, collapsed: false });
      }}
    >
      <fieldset className="settings-form-section">
        <legend>{t('layout.themeSection')}</legend>
        <div className="settings-field-row">
          <div className="settings-field-copy">
            <label htmlFor={`${id}-theme`}>{t('layout.themeLabel')}</label>
            <p id={`${id}-theme-help`}>{t('layout.themeHint')}</p>
          </div>
          <ThemePicker triggerId={`${id}-theme`} />
        </div>
      </fieldset>
      <fieldset className="settings-form-section" disabled={pending}>
        <legend>{t('layout.defaultWidths')}</legend>
        <p className="settings-section-description">{t('layout.widthsHint')}</p>
        <div className="settings-field-row" data-invalid={invalidLeft}>
          <div className="settings-field-copy">
            <label htmlFor={`${id}-navigation`}>{t('layout.navigationWidth')}</label>
            <p id={`${id}-navigation-help`}>
              {t('layout.navigationRange', { min: minNavigationWidth, max: maxNavigationWidth })}
            </p>
          </div>
          <input
            id={`${id}-navigation`}
            type="number"
            className="field settings-input"
            min={minNavigationWidth}
            max={maxNavigationWidth}
            step={1}
            value={left}
            disabled={pending}
            aria-invalid={invalidLeft}
            aria-describedby={`${id}-navigation-help`}
            onChange={(event) => setLeft(event.target.value)}
            required
          />
        </div>
        <div className="settings-field-row" data-invalid={invalidRight}>
          <div className="settings-field-copy">
            <label htmlFor={`${id}-inspector`}>{t('layout.browserWidth')}</label>
            <p id={`${id}-inspector-help`}>
              {t('layout.browserRange', { min: minInspectorWidth, max: maxInspectorWidth })}
            </p>
          </div>
          <input
            id={`${id}-inspector`}
            type="number"
            className="field settings-input"
            min={minInspectorWidth}
            max={maxInspectorWidth}
            step={1}
            value={right}
            disabled={pending}
            aria-invalid={invalidRight}
            aria-describedby={`${id}-inspector-help`}
            onChange={(event) => setRight(event.target.value)}
            required
          />
        </div>
        <p className="settings-help">{t('layout.saveHint')}</p>
      </fieldset>
      <div className="settings-save-bar">
        <div className="settings-save-feedback" aria-live="polite">
          {error ? (
            <p role="alert" className="settings-error">
              {error}
            </p>
          ) : !widths.success ? (
            <p role="alert" className="settings-error">
              {t('layout.invalidWidth')}
            </p>
          ) : (
            <p>
              {t('layout.defaults', {
                left: initialWorkspaceLayout.defaults.left,
                right: initialWorkspaceLayout.defaults.right,
              })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => {
              setLeft(String(initialWorkspaceLayout.defaults.left));
              setRight(String(initialWorkspaceLayout.defaults.right));
              onApply(initialWorkspaceLayout);
            }}
          >
            <RotateCcw data-icon="inline-start" aria-hidden="true" />
            {t('layout.reset')}
          </Button>
          <Button type="submit" disabled={pending || !widths.success}>
            {pending ? t('layout.saving') : t('layout.save')}
          </Button>
        </div>
      </div>
    </form>
  );
}

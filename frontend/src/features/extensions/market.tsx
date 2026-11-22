import { useUiTranslation } from '@/i18n';
import { useIsMutating } from '@tanstack/react-query';
import { extensionKeys, type StartSkill } from './api';
import { FeatureDialog } from './components';
import { SkillHubMarket } from './skillhub-market';

export function SkillMarket({
  projectId,
  projectName,
  onClose,
  onSaved,
  onStartSkill,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onSaved: (message: string) => void;
  onStartSkill?: StartSkill;
}) {
  const { t } = useUiTranslation('extensions');
  const busy = useIsMutating({ mutationKey: extensionKeys.mutations(projectId) }) > 0;
  return (
    <FeatureDialog
      title={t('market.title')}
      className="market-catalog-dialog"
      description={t('market.installTo', { name: projectName })}
      busy={busy}
      onClose={onClose}
    >
      <div className="market-catalog-content">
        <SkillHubMarket projectId={projectId} onSaved={onSaved} onStartSkill={onStartSkill} />
      </div>
    </FeatureDialog>
  );
}

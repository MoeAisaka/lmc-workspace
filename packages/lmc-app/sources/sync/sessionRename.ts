import { Modal } from '@/modal';
import { sync } from './sync';
import type { Session } from './storageTypes';
import { getSessionName } from '@/utils/sessionUtils';
import { t } from '@/text';

export async function promptSessionRename(session: Session): Promise<void> {
    const value = await Modal.prompt(t('localFeatures.renameSession'), t('localFeatures.renameHint'), {
        defaultValue: getSessionName(session), placeholder: t('localFeatures.namePlaceholder'), confirmText: t('common.save'),
    });
    if (value === null || value === undefined) return;
    const name = value.trim();
    if (!name || name.length > 200) {
        Modal.alert(t('common.error'), t('localFeatures.invalidName'));
        return;
    }
    sync.applySettings({ sessionNameOverrides: { [session.id]: name } });
}

import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import { t } from '@/text';

export interface AccountProfileUpdate {
    firstName?: string | null;
    lastName?: string | null;
    /** A cropped, resized image as a data URI; null clears the avatar. */
    avatar?: { dataUri: string; width: number; height: number; thumbhash: string } | null;
}

/**
 * Writes the display name and avatar of the signed-in account. Omitted fields
 * are left untouched, so renaming never disturbs the avatar and vice versa.
 */
export async function updateAccountProfile(credentials: AuthCredentials, update: AccountProfileUpdate): Promise<void> {
    const response = await fetch(`${getServerUrl()}/v1/account/profile`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
    });
    if (!response.ok) {
        const detail = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(detail?.error || t('lmc.common.profileUpdateFailed'));
    }
}

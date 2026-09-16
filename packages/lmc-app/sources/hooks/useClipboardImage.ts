import * as React from 'react';
import { AppState, Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { generateThumbhash } from '@/utils/thumbhash';
import { MAX_FILE_SIZE } from '@/sync/attachmentTypes';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { t } from '@/text';

/**
 * Pasting an image into a composer on a phone.
 *
 * React Native's TextInput has no paste event, so the clipboard cannot be
 * intercepted the way the web does it — it has to be asked for. The button is
 * offered only when the clipboard actually holds an image, so it costs nothing
 * the rest of the time; `hasImageAsync` answers that without reading the
 * contents, which is what would make iOS put up its "allow paste" prompt.
 *
 * The check runs when the composer mounts and whenever the app comes back to
 * the foreground, which is when a copy made in another app arrives.
 */
export function useClipboardImage(onAddFiles?: (files: AttachmentPreview[]) => void) {
    const [available, setAvailable] = React.useState(false);

    React.useEffect(() => {
        if (Platform.OS === 'web' || !onAddFiles) return;
        let cancelled = false;
        const check = async () => {
            try {
                const has = await Clipboard.hasImageAsync();
                if (!cancelled) setAvailable(has);
            } catch {
                if (!cancelled) setAvailable(false);
            }
        };
        void check();
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') void check();
        });
        return () => { cancelled = true; subscription.remove(); };
    }, [onAddFiles]);

    const paste = React.useCallback(async () => {
        if (!onAddFiles) return;
        try {
            // Reading is what prompts on iOS, so it happens only on the tap.
            const image = await Clipboard.getImageAsync({ format: 'png' });
            if (!image?.data) {
                setAvailable(false);
                return;
            }
            const uri = image.data.startsWith('data:') ? image.data : `data:image/png;base64,${image.data}`;
            // Base64 is 4 characters per 3 bytes, and the header is not payload.
            const size = Math.floor((uri.length - uri.indexOf(',') - 1) * 0.75);
            if (size > MAX_FILE_SIZE) {
                Modal.alert(
                    t('imageUpload.fileTooLargeTitle'),
                    t('imageUpload.fileTooLargeMessage', { name: 'image', maxMb: 10 }),
                    [{ text: t('common.ok') }],
                );
                return;
            }
            const width = image.size?.width ?? 0;
            const height = image.size?.height ?? 0;
            const thumbhash = width > 0 && height > 0
                ? await generateThumbhash(uri, width, height)
                : undefined;
            onAddFiles([{
                id: `paste_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                uri,
                width,
                height,
                mimeType: 'image/png',
                size,
                name: `paste_${Date.now()}.png`,
                thumbhash,
            }]);
            setAvailable(false);
        } catch {
            Modal.alert(t('lmc.common.pasteFailed'), '', [{ text: t('common.ok') }]);
        }
    }, [onAddFiles]);

    return { available, paste };
}

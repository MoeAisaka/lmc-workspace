import { sessionReadFile } from '@/sync/ops';
import { openSessionFile } from '@/components/lmc/toolOverlayStore';
import { showToast } from '@/components/lmc/Toast';
import { deliverResourceFile } from '@/utils/deliverResourceFile';
import { decodeBase64ToBytes, fileName, isBinaryExtension, looksBinary } from './fileKinds';
import { t } from '@/text';

/**
 * What pressing a file path does.
 *
 * The read happens before anything opens. Opening first and reporting the
 * failure afterwards meant a wrong path — a filename in prose the linkifier
 * took literally — cost the reader their place in the transcript and gave them
 * a full screen that said only ENOENT. Now a path that cannot be read says so
 * in one line and leaves the page alone.
 *
 * A file the viewer could not render is downloaded rather than refused: the
 * reader asked for the file, and a browser can hold what a code viewer cannot.
 */
export async function openFileReference(sessionId: string | undefined, path: string): Promise<void> {
    if (!sessionId) {
        // No session to read from — an embedded transcript, a notification.
        openSessionFile(path);
        return;
    }
    const name = fileName(path);
    try {
        const response = await sessionReadFile(sessionId, path);
        if (!response.success || !response.content) {
            showToast(t('lmc.files.cannotOpen', { name, reason: response.error || t('files.failedToRead') }), 'error');
            return;
        }
        if (isBinaryExtension(name)) {
            await download(name, response.content);
            return;
        }
        const bytes = decodeBase64ToBytes(response.content);
        const decoded = new TextDecoder().decode(bytes);
        if (looksBinary(bytes, decoded)) {
            await download(name, response.content);
            return;
        }
        // The viewer reads it again: it owns editing, conflict detection and
        // polling, and threading one pre-read copy through that is worth less
        // than the second request costs.
        if (!openSessionFile(path)) showToast(t('lmc.files.noViewer'), 'error');
    } catch (error) {
        showToast(t('lmc.files.cannotOpen', { name, reason: error instanceof Error ? error.message : t('files.failedToRead') }), 'error');
    }
}

async function download(name: string, content: string) {
    try {
        await deliverResourceFile({ name, content }, 'download');
        showToast(t('lmc.files.downloaded', { name }));
    } catch (error) {
        showToast(t('lmc.files.downloadFailed', { name: error instanceof Error ? error.message : name }), 'error');
    }
}

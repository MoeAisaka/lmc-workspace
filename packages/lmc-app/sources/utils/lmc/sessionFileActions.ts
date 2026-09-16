import { Modal } from '@/modal';
import { apiSocket } from '@/sync/apiSocket';
import { storage } from '@/sync/storage';
import { deliverResourceFile } from '@/utils/deliverResourceFile';
import { isInsideSessionProject } from '@/utils/resourceFileScope';
import { FileActionSheet, type FileAction } from '@/components/FileActionSheet';
import { openFileReference } from './openFileReference';
import { fileName } from './fileKinds';
import { t } from '@/text';

/**
 * The four things you can do with a file a session knows about.
 *
 * One sheet, wherever the file was named: the resource window lists files, the
 * transcript mentions them in prose, and picking one should not mean two
 * different interactions depending on where you found it. The choice that
 * matters is which device receives the file, and only the sheet states it.
 */

type Delivery = 'open-host' | 'download' | 'share';

const inFlight = new Set<string>();

/** Reads the file off the session's device, following the chunk cursor to the end. */
async function fetchResource(sessionId: string, path: string) {
    const first = await apiSocket.sessionRPC<{ success: boolean; name?: string; content?: string; error?: string; nextOffset?: number | null; revision?: string }, { path: string; action: string }>(
        sessionId, 'resource-file', { path, action: 'download' },
    );
    if (!first.success) throw new Error(first.error || t('lmc.resources.operationFailed'));
    const chunks = [first.content || ''];
    let next = first.nextOffset;
    while (typeof next === 'number') {
        const part = await apiSocket.sessionRPC<any, any>(sessionId, 'resource-file', { path, action: 'download', offset: next, revision: first.revision });
        if (!part.success) throw new Error(part.error || t('lmc.resources.downloadInterrupted'));
        if (typeof part.nextOffset === 'number' && part.nextOffset <= next) throw new Error(t('lmc.resources.downloadOffset'));
        chunks.push(part.content);
        next = part.nextOffset;
    }
    if (!first.name) throw new Error(t('lmc.resources.incompleteResponse'));
    return { name: first.name, content: chunks.join('') };
}

async function deliver(sessionId: string, path: string, action: Delivery, onBusyChange?: (path: string | null) => void) {
    if (inFlight.has(path)) return;
    inFlight.add(path);
    onBusyChange?.(path);
    try {
        if (action === 'open-host') {
            const result = await apiSocket.sessionRPC<{ success: boolean; error?: string }, { path: string; action: string }>(sessionId, 'resource-file', { path, action });
            if (!result.success) throw new Error(result.error || t('lmc.resources.operationFailed'));
            return;
        }
        const file = await fetchResource(sessionId, path);
        if (action === 'share') {
            // A second tap restores the browser user gesture the network request spent.
            Modal.alert(t('lmc.resources.fileReady'), file.name, [
                { text: t('common.cancel'), style: 'cancel' },
                { text: t('lmc.resources.systemShare'), onPress: () => {
                    void deliverResourceFile(file, 'share').catch((error) => Modal.alert(t('lmc.resources.operationFailed'), error.message));
                } },
            ]);
            return;
        }
        await deliverResourceFile(file, 'download');
    } catch (error) {
        Modal.alert(t('lmc.resources.operationFailed'), error instanceof Error ? error.message : t('lmc.resources.retry'));
    } finally {
        inFlight.delete(path);
        onBusyChange?.(null);
    }
}

export function chooseSessionFile({ sessionId, path, onPreview, onBusyChange }: {
    sessionId: string;
    path: string;
    /** Where "preview" goes. Defaults to reading the file and opening the viewer. */
    onPreview?: (path: string) => void;
    onBusyChange?: (path: string | null) => void;
}) {
    const session = storage.getState().sessions[sessionId];
    const supported = session?.metadata?.sessionCapabilities?.resourceFiles === true;
    const root = session?.metadata?.path;
    // The Agent only delivers files inside the project, so say so before the tap.
    const blocked = supported ? undefined : t('lmc.resources.unsupported');
    const actions: FileAction[] = [
        { key: 'preview', title: t('lmc.resources.preview'), subtitle: t('lmc.resources.previewHint'), icon: 'eye-outline', onPress: () => (onPreview ? onPreview(path) : void openFileReference(sessionId, path)) },
        { key: 'host', title: t('lmc.resources.openOnHost'), subtitle: t('lmc.resources.openOnHostHint'), icon: 'desktop-outline', disabledReason: blocked, onPress: () => { void deliver(sessionId, path, 'open-host', onBusyChange); } },
        { key: 'download', title: t('lmc.resources.download'), subtitle: t('lmc.resources.downloadHint'), icon: 'download-outline', disabledReason: blocked, onPress: () => { void deliver(sessionId, path, 'download', onBusyChange); } },
        { key: 'share', title: t('lmc.resources.share'), subtitle: t('lmc.resources.shareHint'), icon: 'share-outline', disabledReason: blocked, onPress: () => { void deliver(sessionId, path, 'share', onBusyChange); } },
    ];
    Modal.show({
        component: FileActionSheet,
        props: {
            name: fileName(path) || t('lmc.resources.unnamedFile'),
            path,
            note: supported && !isInsideSessionProject(path, root) && root ? t('lmc.resources.outsideProject', { root }) : undefined,
            actions,
        },
    });
}

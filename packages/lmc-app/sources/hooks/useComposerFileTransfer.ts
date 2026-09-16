import * as React from 'react';
import { Platform } from 'react-native';
import { Modal } from '@/modal';
import { generateThumbhash } from '@/utils/thumbhash';
import { attachmentSizeLimit, MAX_IMAGES_PER_MESSAGE } from '@/sync/attachmentTypes';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { t } from '@/text';

/**
 * Pasting and dropping files onto a composer.
 *
 * Lived inside the in-session composer, which is why the new-session one — the
 * first thing a session ever sees — could not take a dropped file at all. It is
 * a hook now so both get the same behaviour and neither can quietly drift.
 *
 * Web only: there is no paste event on a React Native TextInput, so the phone
 * pastes through an explicit action instead (see `useClipboardImage`).
 */
export function useComposerFileTransfer(
    onAddFiles: ((files: AttachmentPreview[]) => void) | undefined,
    currentCount: number,
) {
    // Read through a ref so the listeners are attached once rather than being
    // torn down and rebuilt on every keystroke that changes the count.
    const countRef = React.useRef(currentCount);
    countRef.current = currentCount;

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !onAddFiles) return;

        const accept = async (files: File[], source: 'paste' | 'drop') => {
            const remaining = MAX_IMAGES_PER_MESSAGE - countRef.current;
            if (remaining <= 0) {
                Modal.alert(
                    t('imageUpload.limitTitle'),
                    t('imageUpload.limitMessage', { max: MAX_IMAGES_PER_MESSAGE }),
                    [{ text: t('common.ok') }],
                );
                return;
            }
            const { fileToAttachmentPreview } = await import('@/utils/pasteImages.web');
            const previews: AttachmentPreview[] = [];
            for (const file of files.slice(0, remaining)) {
                if (file.size > attachmentSizeLimit(file.type)) {
                    Modal.alert(
                        t('lmc.common.fileTooLarge'),
                        t('lmc.common.fileTooLargeBody', { name: file.name || 'file' }),
                        [{ text: t('common.ok') }],
                    );
                    continue;
                }
                const preview = await fileToAttachmentPreview(file, generateThumbhash);
                if (preview) {
                    previews.push({ ...preview, id: `${source}_${Date.now()}_${Math.random().toString(36).slice(2)}` });
                }
            }
            if (previews.length > 0) onAddFiles(previews);
        };

        const handlePaste = async (event: ClipboardEvent) => {
            // The listener is on the document, so without this a paste in the
            // URL bar, another modal, or any focused-elsewhere input would
            // steal files meant for somewhere else.
            const active = document.activeElement;
            const isEditableTarget = active instanceof HTMLInputElement
                || active instanceof HTMLTextAreaElement
                || (active instanceof HTMLElement && active.isContentEditable);
            if (!isEditableTarget) return;

            const { getFilesFromClipboard } = await import('@/utils/pasteImages.web');
            const files = getFilesFromClipboard(event);
            if (!files.length) return;
            event.preventDefault();
            await accept(files, 'paste');
        };

        // dragover must preventDefault for drop to fire; gated on the drag
        // actually carrying files so dragging text around the app still works.
        const isFileDrag = (event: DragEvent) => {
            const types = event.dataTransfer?.types;
            if (!types) return false;
            for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
            return false;
        };

        const handleDragOver = (event: DragEvent) => {
            if (!isFileDrag(event)) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        };

        const handleDrop = async (event: DragEvent) => {
            if (!isFileDrag(event)) return;
            event.preventDefault();
            const { getFilesFromDrop } = await import('@/utils/pasteImages.web');
            const files = getFilesFromDrop(event);
            if (!files.length) return;
            await accept(files, 'drop');
        };

        document.addEventListener('paste', handlePaste as any);
        document.addEventListener('dragover', handleDragOver);
        document.addEventListener('drop', handleDrop);
        return () => {
            document.removeEventListener('paste', handlePaste as any);
            document.removeEventListener('dragover', handleDragOver);
            document.removeEventListener('drop', handleDrop);
        };
    }, [onAddFiles]);
}

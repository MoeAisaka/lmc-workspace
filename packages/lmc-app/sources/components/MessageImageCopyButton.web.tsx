import { iconActionFrame } from '@/components/interactionGeometry';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { MarkdownView } from './markdown/MarkdownView';
import { canCopyImage } from './markdown/tableCopy';
import { Modal } from '@/modal';
import { t } from '@/text';
import { showToast } from './lmc/Toast';

export function MessageImageCopyButton(props: { text: string; sessionId: string }) {
    const { theme } = useUnistyles();
    const [job, setJob] = React.useState<{ text: string; resolve: (blob: Blob) => void; reject: (error: unknown) => void } | null>(null);
    const busy = React.useRef(false);
    const node = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        if (!job || !node.current) return;
        let cancelled = false;
        import('@/utils/messageImage.web').then(module => module.renderMessageImage(node.current!))
            .then(blob => { if (!cancelled) job.resolve(blob); }, job.reject);
        return () => { cancelled = true; job.reject(new Error(t('lmc.messageImage.cancelled'))); };
    }, [job]);

    const copy = () => {
        if (busy.current) return;
        busy.current = true;
        const image = new Promise<Blob>((resolve, reject) => setJob({ text: props.text, resolve, reject }));
        // Begin the clipboard write in the tap, before rendering/importing. Safari
        // requires user activation here and accepts the PNG as a promise.
        let write: Promise<void>;
        try {
            write = canCopyImage()
                ? navigator.clipboard.write([new ClipboardItem({ 'image/png': image })])
                : Promise.reject(new Error(t('lmc.messageImage.unsupportedBrowser')));
        } catch (error) { write = Promise.reject(error); }
        void (async () => {
            try {
                await write;
                showToast(t('lmc.messageImage.copied'), 'info');
            } catch {
                try {
                    const blob = await image;
                    Modal.alert(t('lmc.messageImage.generatedTitle'), t('lmc.messageImage.generatedBody'), [
                        { text: t('common.cancel'), style: 'cancel' },
                        { text: t('lmc.messageImage.saveImage'), onPress: () => { void import('@/utils/messageImage.web').then(module => module.downloadMessageImage(blob)); } },
                    ]);
                } catch (error) {
                    Modal.alert(t('lmc.messageImage.failedTitle'), error instanceof Error ? error.message : t('lmc.messageImage.retryLater'));
                }
            } finally {
                busy.current = false;
                setJob(null);
            }
        })();
        // The render promise can reject before a browser consumes its ClipboardItem.
        void image.catch(() => {});
    };

    return <>
        <Pressable interaction="control" accessibilityRole="button" accessibilityLabel={job ? t('lmc.messageImage.generatingA11y') : t('lmc.messageImage.copyAsImageA11y')}
            disabled={!!job} onPress={copy} hitSlop={10}
            style={({ pressed }) => ({ ...iconActionFrame, opacity: pressed || job ? 0.5 : 1 })}>
            <Ionicons name="image-outline" size={16} color={theme.colors.text} />
        </Pressable>
        {job && createPortal(<div aria-hidden="true" style={{ position: 'fixed', top: 0, left: -100000, pointerEvents: 'none' }}>
            <div ref={node} data-message-image="true" style={{ width: 760, boxSizing: 'border-box', padding: 24, backgroundColor: theme.colors.surface, color: theme.colors.text }}>
                <MarkdownView markdown={job.text} sessionId={props.sessionId} inferOptions imageExport />
            </div>
        </div>, document.body)}
    </>;
}

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { MarkdownView } from './markdown/MarkdownView';
import { canCopyImage } from './markdown/tableCopy';
import { Modal } from '@/modal';
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
        return () => { cancelled = true; job.reject(new Error('图片生成已取消。')); };
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
                : Promise.reject(new Error('当前浏览器不支持复制图片。'));
        } catch (error) { write = Promise.reject(error); }
        void (async () => {
            try {
                await write;
                showToast('图片已复制', 'info');
            } catch {
                try {
                    const blob = await image;
                    Modal.alert('图片已生成', '未能写入剪贴板，可以保存图片后使用。', [
                        { text: '取消', style: 'cancel' },
                        { text: '保存图片', onPress: () => { void import('@/utils/messageImage.web').then(module => module.downloadMessageImage(blob)); } },
                    ]);
                } catch (error) {
                    Modal.alert('图片生成失败', error instanceof Error ? error.message : '请稍后重试。');
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
        <Pressable accessibilityRole="button" accessibilityLabel={job ? '正在生成图片' : '复制成图片'}
            disabled={!!job} onPress={copy} hitSlop={10}
            style={({ pressed }) => ({ height: 24, width: 28, alignItems: 'center', justifyContent: 'center', opacity: pressed || job ? 0.5 : 1 })}>
            <Ionicons name="image-outline" size={17} color={theme.colors.text} />
        </Pressable>
        {job && createPortal(<div aria-hidden="true" style={{ position: 'fixed', top: 0, left: -100000, pointerEvents: 'none' }}>
            <div ref={node} data-message-image="true" style={{ width: 760, boxSizing: 'border-box', padding: 24, backgroundColor: theme.colors.surface, color: theme.colors.text }}>
                <MarkdownView markdown={job.text} sessionId={props.sessionId} inferOptions imageExport />
            </div>
        </div>, document.body)}
    </>;
}

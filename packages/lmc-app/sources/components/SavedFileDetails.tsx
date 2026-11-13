import { textActionFrame } from '@/components/interactionGeometry';
import React from 'react';
import { View, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { fileSize } from '@/utils/fileSize';
import { FileIcon } from '@/components/FileIcon';
import { SettingsMenuHost, SettingsSelect } from '@/components/lmc/SettingsSelect';
import { useAllSessions } from '@/sync/storage';
import { getFileAsset, downloadFileAsset, fileAssetBlob, deliverFileAsset, getFileDeliveries, decryptFileReceipt, createFileShare, getFileShares, revokeFileShare, FILE_PREVIEW_LIMIT, type OpenFileAsset } from '@/sync/apiFileAssets';
import type { FileDelivery, FileShare } from 'lmc-wire';
import { accountMe } from '@/sync/apiAccounts';
import { openResourceSharing } from '@/components/lmc/ResourceSharingDialog';
import { t, getDateLocale } from '@/text';

function previewTypeOf(file: OpenFileAsset) {
    const mime = file.manifest.mimeType;
    return /^image\/(png|jpeg|webp|gif)$/.test(mime) ? 'image' : mime === 'application/pdf' ? 'pdf'
        : /^(text\/(plain|markdown|csv)|application\/json)$/.test(mime) ? 'text' : null;
}
async function readPreview(file: OpenFileAsset, signal: AbortSignal) {
    const blob = await fileAssetBlob(file, FILE_PREVIEW_LIMIT, undefined, signal);
    return previewTypeOf(file) === 'text' ? { text: await blob.text() } : { url: URL.createObjectURL(blob) };
}

export function SavedFileDetails({ id }: { id: string }) {
    const { theme } = useUnistyles();
    const [tab, setTab] = React.useState<'preview' | 'share' | 'send'>('preview');
    const [accountSharing, setAccountSharing] = React.useState(false);
    React.useEffect(() => { let active = true; void accountMe().then(v => { if (active) setAccountSharing(v.capabilities.fileSharing); }).catch(() => {}); return () => { active = false; }; }, []);
    const sessions = useAllSessions();
    const [file, setFile] = React.useState<OpenFileAsset | null>(null);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState('');
    const [progress, setProgress] = React.useState(0);
    const [selected, setSelected] = React.useState<string | null>(null);
    const [deliveries, setDeliveries] = React.useState<Array<FileDelivery & { detail?: string }>>([]);
    const [preview, setPreview] = React.useState<{ url?: string; text?: string } | null>(null);
    const [notice, setNotice] = React.useState('');
    const [shares, setShares] = React.useState<FileShare[]>([]);
    const [shareLink, setShareLink] = React.useState<(FileShare & { url: string }) | null>(null);
    const [shareHours, setShareHours] = React.useState('24');
    const busyRef = React.useRef(false);
    const controller = React.useRef<AbortController | null>(null);
    const alive = React.useRef(true);
    const currentId = React.useRef(id);
    currentId.current = id;
    const polling = React.useRef(false);
    const loadShares = React.useCallback(async () => {
        const rows = await getFileShares(id);
        if (alive.current && currentId.current === id) setShares(rows);
    }, [id]);
    const loadDeliveries = React.useCallback(async () => {
        if (polling.current) return;
        polling.current = true;
        try {
            const rows = await getFileDeliveries(id);
            const values = await Promise.all(rows.map(async row => {
                const receipt = await decryptFileReceipt(row);
                return { ...row, detail: receipt?.path || receipt?.error };
            }));
            if (alive.current && currentId.current === id) setDeliveries(values);
        } catch { /* Initial load errors are shown by getFileAsset; receipts retry on next refresh. */ }
        finally { polling.current = false; }
    }, [id]);
    React.useEffect(() => {
        alive.current = true;
        setFile(null); setError(''); setPreview(null); setDeliveries([]); setSelected(null); setBusy(''); setNotice(''); setShares([]); setShareLink(null); busyRef.current = false;
        void getFileAsset(id).then(value => { if (alive.current && currentId.current === id) setFile(value); }).catch(error => { if (alive.current && currentId.current === id) setError(error.message); });
        void loadDeliveries();
        void loadShares().catch(() => {});
        const timer = setInterval(() => { void loadDeliveries(); }, 15000);
        return () => { alive.current = false; clearInterval(timer); controller.current?.abort(); };
    }, [id, loadDeliveries, loadShares]);
    React.useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview]);
    const downloadingLabel = t('lmc.savedFiles.downloading');
    const loadingPreviewLabel = t('lmc.savedFiles.loadingPreview');
    const locale = getDateLocale();
    const run = async (label: string, action: () => Promise<void>) => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(label); setError(''); setNotice('');
        try { await action(); }
        catch (error) { if (alive.current && currentId.current === id && (error as Error).name !== 'AbortError') setError(error instanceof Error ? error.message : t('lmc.sharing.actionFailed')); }
        finally { if (alive.current && currentId.current === id) { setBusy(''); busyRef.current = false; } }
    };
    const button = (label: string, action: () => void, disabled = false) => <Pressable key={label} accessibilityRole="button" disabled={!!busy || disabled} onPress={action}
        style={({ pressed }) => ({ minHeight: 36, paddingHorizontal: 14, paddingVertical: 7, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface, opacity: busy || disabled ? 0.45 : 1 })}>
        <Text style={{ color: theme.colors.textLink, fontSize: 13.5, lineHeight: 20, fontWeight: '500' }}>{label}</Text></Pressable>;
    const eligible = sessions.filter(session => !!session.metadata?.sessionCapabilities?.persistentFiles);
    const titleOf = (sessionId: string) => { const session = sessions.find(s => s.id === sessionId); return session?.metadata?.name || session?.metadata?.summary?.text || sessionId; };
    const previewType = file && previewTypeOf(file);
    React.useEffect(() => {
        if (!file || !previewType || Platform.OS !== 'web' || file.manifest.size > FILE_PREVIEW_LIMIT) return;
        const abort = new AbortController();
        controller.current = abort;
        let active = true;
        busyRef.current = true; setBusy(loadingPreviewLabel);
        void readPreview(file, abort.signal).then(value => {
            if (active) setPreview(value); else if (value.url) URL.revokeObjectURL(value.url);
        }).catch(error => { if (active && error.name !== 'AbortError') setError(error.message); })
            .finally(() => { if (active) { busyRef.current = false; setBusy(''); } });
        return () => { active = false; abort.abort(); };
    }, [file, previewType, loadingPreviewLabel]);
    return <SettingsMenuHost><View style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface }}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 20 }}>
            {!file && !error && <ActivityIndicator />}
            {file && <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                    <FileIcon fileName={file.manifest.name} size={36} />
                    <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
                        <Text selectable style={{ fontSize: 18, lineHeight: 25, fontWeight: '600', color: theme.colors.text }}>{file.manifest.name}</Text>
                        <Text style={{ fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary }}>{fileSize(file.manifest.size)} · {new Date(file.createdAt).toLocaleString(locale)}</Text>
                    </View>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                    {accountSharing && !file.shared && button(t('lmc.savedFiles.accountSharing'), () => openResourceSharing('file', id))}
                    {button(t('lmc.savedFiles.download'), () => void run(downloadingLabel, async () => {
                        controller.current = new AbortController(); setProgress(0);
                        await downloadFileAsset(file, bytes => { if (alive.current) setProgress(bytes); }, controller.current.signal);
                        if (alive.current) setNotice(t('lmc.savedFiles.savedByBrowser'));
                    }))}
                    {button(t('lmc.savedFiles.copyLink'), () => void run(t('lmc.savedFiles.copying'), async () => {
                        if (typeof window === 'undefined' || !navigator.clipboard?.writeText) throw new Error(t('lmc.savedFiles.copyFromAddressBar'));
                        await navigator.clipboard.writeText(new URL('/saved-files/' + encodeURIComponent(id), window.location.origin).href);
                        setNotice(t('lmc.savedFiles.linkCopiedNotice'));
                    }))}
                </View>
                {!!busy && <View style={{ gap: 8 }}><Text style={{ color: theme.colors.textSecondary }}>{busy}{busy === downloadingLabel ? ' · ' + fileSize(progress) + ' / ' + fileSize(file.manifest.size) : ''}</Text>
                    {(busy === downloadingLabel || busy === loadingPreviewLabel) && <Pressable style={textActionFrame} accessibilityRole="button" onPress={() => controller.current?.abort()}><Text style={{ color: theme.colors.textLink }}>{t('common.cancel')}</Text></Pressable>}</View>}
                {!!notice && <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textSecondary }}>{notice}</Text>}
                {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
                <View style={{ flexDirection: 'row', gap: 4, borderBottomWidth: 1, borderColor: theme.colors.divider }}>
                    {([['preview', t('lmc.savedFiles.tabPreview')], ['share', t('lmc.savedFiles.tabShare')], ['send', t('lmc.savedFiles.tabSend')]] as const).filter(([value]) => !file.shared || value === 'preview').map(([value, label]) => (
                        <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: tab === value }} onPress={() => setTab(value)}
                            style={{ borderRadius: 8, paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: tab === value ? theme.colors.textLink : 'transparent' }}>
                            <Text style={{ fontSize: 14, color: tab === value ? theme.colors.textLink : theme.colors.textSecondary }}>{label}</Text>
                        </Pressable>
                    ))}
                </View>
                {tab === 'preview' && <View style={{ gap: 16, minHeight: 180 }}>
                {preview?.url && Platform.OS === 'web' && (previewType === 'image'
                    ? React.createElement('img', { src: preview.url, alt: file.manifest.name, style: { maxWidth: '100%', maxHeight: 600, objectFit: 'contain' } })
                    : React.createElement('iframe', { src: preview.url, title: file.manifest.name, sandbox: '', style: { width: '100%', height: 560, border: 0 } }))}
                {preview?.text !== undefined && <Text selectable style={{ color: theme.colors.text, fontSize: 14, lineHeight: 24.5 }}>{preview.text}</Text>}
                    {previewType && Platform.OS === 'web' && file.manifest.size <= FILE_PREVIEW_LIMIT && !preview && !busy && button(t('lmc.savedFiles.loadPreview'), () => void run(loadingPreviewLabel, async () => {
                        if (Platform.OS !== 'web') throw new Error(t('lmc.savedFiles.previewWebOnlyError'));
                        if (file.manifest.size > FILE_PREVIEW_LIMIT) throw new Error(t('lmc.savedFiles.previewLimitError'));
                        controller.current = new AbortController();
                        const value = await readPreview(file, controller.current.signal);
                        if (alive.current) setPreview(value); else if (value.url) URL.revokeObjectURL(value.url);
                    }))}
                    {!previewType && <Text style={{ color: theme.colors.textSecondary, fontSize: 14, lineHeight: 21 }}>{t('lmc.savedFiles.previewUnsupported')}</Text>}
                    {previewType && Platform.OS !== 'web' && <Text style={{ color: theme.colors.textSecondary }}>{t('lmc.savedFiles.previewWebOnly')}</Text>}
                    {previewType && file.manifest.size > FILE_PREVIEW_LIMIT && <Text style={{ color: theme.colors.textSecondary }}>{t('lmc.savedFiles.previewTooLarge')}</Text>}
                </View>}
                {tab === 'share' && <View style={{ gap: 12 }}>
                    <Text style={{ fontSize: 16, fontWeight: '600', color: theme.colors.text }}>{t('lmc.savedFiles.expiringLinkTitle')}</Text>
                    <Text style={{ color: theme.colors.textSecondary }}>{t('lmc.savedFiles.expiringLinkIntro')}</Text>
                    <SettingsSelect value={shareHours} onChange={setShareHours} title={t('lmc.savedFiles.linkValidity')} options={[
                        { value: '1', label: t('lmc.savedFiles.hours1') }, { value: '24', label: t('lmc.savedFiles.hours24') }, { value: '168', label: t('lmc.savedFiles.days7') },
                    ]} />
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                        {button(t('lmc.savedFiles.createExpiringLink'), () => void run(t('lmc.savedFiles.creatingLink'), async () => {
                            const link = await createFileShare(file, Number(shareHours));
                            if (alive.current && currentId.current === id) setShareLink(link);
                            await loadShares();
                        }))}
                        {button(t('lmc.savedFiles.refreshShares'), () => void run(t('lmc.savedFiles.refreshingShares'), loadShares))}
                    </View>
                    {shareLink && !shareLink.revokedAt && <View style={{ padding: 12, gap: 8, borderRadius: 10, backgroundColor: theme.colors.surfaceHigh }}>
                        <Text selectable style={{ color: theme.colors.textLink }}>{shareLink.url}</Text>
                        <Text style={{ color: theme.colors.textSecondary }}>{t('lmc.savedFiles.expiresAt', { time: new Date(shareLink.expiresAt).toLocaleString(locale) })}</Text>
                        <View style={{ alignSelf: 'flex-start' }}>{button(t('lmc.savedFiles.copyShareLink'), () => void run(t('lmc.savedFiles.copyingShareLink'), async () => {
                            if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error(t('lmc.savedFiles.selectAboveLinkToCopy'));
                            await navigator.clipboard.writeText(shareLink.url); setNotice(t('lmc.savedFiles.shareLinkCopiedNotice'));
                        }))}</View>
                    </View>}
                    {shares.map(row => <View key={row.id} style={{ padding: 12, gap: 8, borderRadius: 10, backgroundColor: theme.colors.surfaceHigh }}>
                        <Text style={{ color: theme.colors.text }}>{row.revokedAt ? t('lmc.savedFiles.statusRevoked') : row.expiresAt <= Date.now() ? t('lmc.savedFiles.statusExpired') : t('lmc.savedFiles.statusActive')} · {new Date(row.expiresAt).toLocaleString(locale)}</Text>
                        <Text selectable style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{t('lmc.savedFiles.createdAt', { time: new Date(row.createdAt).toLocaleString(locale), id: row.id.slice(0, 8) })}</Text>
                        {!row.revokedAt && row.expiresAt > Date.now() && <View style={{ alignSelf: 'flex-start' }}>{button(t('lmc.savedFiles.revokeShareLink'), () => void run(t('lmc.savedFiles.revokingShareLink'), async () => {
                            await revokeFileShare(row.id);
                            if (shareLink?.id === row.id) setShareLink(null);
                            await loadShares(); setNotice(t('lmc.savedFiles.shareLinkRevokedNotice'));
                        }))}</View>}
                    </View>)}
                </View>}
                {tab === 'send' && <View style={{ gap: 12 }}>
                    <Text style={{ fontSize: 16, fontWeight: '600', color: theme.colors.text }}>{t('lmc.savedFiles.sendToSessionTitle')}</Text>
                    <Text style={{ color: theme.colors.textSecondary }}>{t('lmc.savedFiles.sendToSessionIntro')}</Text>
                    <SettingsSelect value={selected} onChange={setSelected} title={t('lmc.savedFiles.selectTargetSession')} options={[
                        { value: null, label: t('lmc.savedFiles.selectSessionPlaceholder'), description: t('lmc.savedFiles.selectSessionHint') },
                        ...eligible.map(session => ({ value: session.id, label: titleOf(session.id), description: (session.metadata?.host || '') + ' · ' + (session.active ? t('lmc.savedFiles.connected') : t('lmc.savedFiles.offlineWaiting')) })),
                    ]} />
                    {!eligible.length && <Text style={{ color: theme.colors.textSecondary }}>{t('lmc.savedFiles.noEligibleSessions')}</Text>}
                    <View style={{ alignSelf: 'flex-start' }}>{button(t('lmc.savedFiles.sendFile'), () => void run(t('lmc.savedFiles.queueingDelivery'), async () => {
                        await deliverFileAsset(file, selected!); await loadDeliveries(); setNotice(t('lmc.savedFiles.queuedDeliveryNotice'));
                    }), !selected)}</View>
                    {deliveries.map(row => <View key={row.id} style={{ padding: 12, gap: 5, borderRadius: 10, backgroundColor: theme.colors.surfaceHigh }}>
                        <Text style={{ color: theme.colors.text }}>{titleOf(row.sessionId)} · {{ pending: t('lmc.savedFiles.deliveryPending'), received: t('lmc.savedFiles.deliveryReceived'), failed: t('lmc.savedFiles.deliveryFailed') }[row.state]}</Text>
                        {row.detail && <Text selectable style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{row.detail}</Text>}
                    </View>)}
                </View>}
            </>}
            {!file && !!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
        </ScrollView>
    </View></SettingsMenuHost>;
}


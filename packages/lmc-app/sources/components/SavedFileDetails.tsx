import React from 'react';
import { View, ScrollView, Pressable, ActivityIndicator, Platform } from 'react-native';
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
    const run = async (label: string, action: () => Promise<void>) => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(label); setError(''); setNotice('');
        try { await action(); }
        catch (error) { if (alive.current && currentId.current === id && (error as Error).name !== 'AbortError') setError(error instanceof Error ? error.message : '操作失败，请重试'); }
        finally { if (alive.current && currentId.current === id) { setBusy(''); busyRef.current = false; } }
    };
    const button = (label: string, action: () => void, disabled = false) => <Pressable key={label} accessibilityRole="button" disabled={!!busy || disabled} onPress={action}
        style={{ paddingHorizontal: 16, paddingVertical: 12, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, opacity: busy || disabled ? 0.45 : 1 }}>
        <Text style={{ color: theme.colors.textLink, fontWeight: '500' }}>{label}</Text></Pressable>;
    const eligible = sessions.filter(session => !!session.metadata?.sessionCapabilities?.persistentFiles);
    const titleOf = (sessionId: string) => { const session = sessions.find(s => s.id === sessionId); return session?.metadata?.name || session?.metadata?.summary?.text || sessionId; };
    const previewType = file && previewTypeOf(file);
    React.useEffect(() => {
        if (!file || !previewType || Platform.OS !== 'web' || file.manifest.size > FILE_PREVIEW_LIMIT) return;
        const abort = new AbortController();
        controller.current = abort;
        let active = true;
        busyRef.current = true; setBusy('正在加载预览');
        void readPreview(file, abort.signal).then(value => {
            if (active) setPreview(value); else if (value.url) URL.revokeObjectURL(value.url);
        }).catch(error => { if (active && error.name !== 'AbortError') setError(error.message); })
            .finally(() => { if (active) { busyRef.current = false; setBusy(''); } });
        return () => { active = false; abort.abort(); };
    }, [file, previewType]);
    return <SettingsMenuHost><View style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface }}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 20 }}>
            {!file && !error && <ActivityIndicator />}
            {file && <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                    <FileIcon fileName={file.manifest.name} size={36} />
                    <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
                        <Text selectable style={{ fontSize: 18, lineHeight: 25, fontWeight: '600', color: theme.colors.text }}>{file.manifest.name}</Text>
                        <Text style={{ fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary }}>{fileSize(file.manifest.size)} · {new Date(file.createdAt).toLocaleString()}</Text>
                    </View>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                    {accountSharing && !file.shared && button('账号共享', () => openResourceSharing('file', id))}
                    {button('下载', () => void run('正在下载', async () => {
                        controller.current = new AbortController(); setProgress(0);
                        await downloadFileAsset(file, bytes => { if (alive.current) setProgress(bytes); }, controller.current.signal);
                        if (alive.current) setNotice('文件已交给浏览器保存');
                    }))}
                    {button('复制链接', () => void run('正在复制', async () => {
                        if (typeof window === 'undefined' || !navigator.clipboard?.writeText) throw new Error('请从浏览器地址栏复制链接');
                        await navigator.clipboard.writeText(new URL('/saved-files/' + encodeURIComponent(id), window.location.origin).href);
                        setNotice('链接已复制，打开时需要登录获授权的 LMC 账号');
                    }))}
                </View>
                {!!busy && <View style={{ gap: 8 }}><Text style={{ color: theme.colors.textSecondary }}>{busy}{busy === '正在下载' ? ' · ' + fileSize(progress) + ' / ' + fileSize(file.manifest.size) : ''}</Text>
                    {(busy === '正在下载' || busy === '正在加载预览') && <Pressable accessibilityRole="button" onPress={() => controller.current?.abort()}><Text style={{ color: theme.colors.textLink }}>取消</Text></Pressable>}</View>}
                {!!notice && <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textSecondary }}>{notice}</Text>}
                {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
                <View style={{ flexDirection: 'row', gap: 4, borderBottomWidth: 1, borderColor: theme.colors.divider }}>
                    {([['preview', '预览'], ['share', '分享'], ['send', '发送到会话']] as const).filter(([value]) => !file.shared || value === 'preview').map(([value, label]) => (
                        <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: tab === value }} onPress={() => setTab(value)}
                            style={{ paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: tab === value ? theme.colors.textLink : 'transparent' }}>
                            <Text style={{ fontSize: 14, color: tab === value ? theme.colors.textLink : theme.colors.textSecondary }}>{label}</Text>
                        </Pressable>
                    ))}
                </View>
                {tab === 'preview' && <View style={{ gap: 16, minHeight: 180 }}>
                {preview?.url && Platform.OS === 'web' && (previewType === 'image'
                    ? React.createElement('img', { src: preview.url, alt: file.manifest.name, style: { maxWidth: '100%', maxHeight: 600, objectFit: 'contain' } })
                    : React.createElement('iframe', { src: preview.url, title: file.manifest.name, sandbox: '', style: { width: '100%', height: 560, border: 0 } }))}
                {preview?.text !== undefined && <Text selectable style={{ color: theme.colors.text, lineHeight: 22 }}>{preview.text}</Text>}
                    {previewType && Platform.OS === 'web' && file.manifest.size <= FILE_PREVIEW_LIMIT && !preview && !busy && button('加载预览', () => void run('正在加载预览', async () => {
                        if (Platform.OS !== 'web') throw new Error('请在网页版预览，或下载文件');
                        if (file.manifest.size > FILE_PREVIEW_LIMIT) throw new Error('预览上限为 16 MiB，请下载查看');
                        controller.current = new AbortController();
                        const value = await readPreview(file, controller.current.signal);
                        if (alive.current) setPreview(value); else if (value.url) URL.revokeObjectURL(value.url);
                    }))}
                    {!previewType && <Text style={{ color: theme.colors.textSecondary, lineHeight: 22 }}>此格式暂不支持预览，请下载查看。</Text>}
                    {previewType && Platform.OS !== 'web' && <Text style={{ color: theme.colors.textSecondary }}>请在网页版预览文件。</Text>}
                    {previewType && file.manifest.size > FILE_PREVIEW_LIMIT && <Text style={{ color: theme.colors.textSecondary }}>文件超过 16 MiB，请下载查看。</Text>}
                </View>}
                {tab === 'share' && <View style={{ gap: 12 }}>
                    <Text style={{ fontSize: 16, fontWeight: '600', color: theme.colors.text }}>限时外链</Text>
                    <Text style={{ color: theme.colors.textSecondary }}>默认链接需要登录你的 LMC 账号。需要发给他人或导入其他应用时，可生成限时外链；持有外链的人无需登录即可下载，到期或撤销后失效。</Text>
                    <SettingsSelect value={shareHours} onChange={setShareHours} title="外链有效期" options={[
                        { value: '1', label: '1 小时' }, { value: '24', label: '24 小时' }, { value: '168', label: '7 天' },
                    ]} />
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                        {button('生成限时外链', () => void run('正在生成外链', async () => {
                            const link = await createFileShare(file, Number(shareHours));
                            if (alive.current && currentId.current === id) setShareLink(link);
                            await loadShares();
                        }))}
                        {button('刷新外链记录', () => void run('正在刷新外链', loadShares))}
                    </View>
                    {shareLink && !shareLink.revokedAt && <View style={{ padding: 12, gap: 8, borderRadius: 10, backgroundColor: theme.colors.surfaceHigh }}>
                        <Text selectable style={{ color: theme.colors.textLink }}>{shareLink.url}</Text>
                        <Text style={{ color: theme.colors.textSecondary }}>到期时间：{new Date(shareLink.expiresAt).toLocaleString()}</Text>
                        <View style={{ alignSelf: 'flex-start' }}>{button('复制外链', () => void run('正在复制外链', async () => {
                            if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error('请选中上方外链复制');
                            await navigator.clipboard.writeText(shareLink.url); setNotice('外链已复制，持有链接的人可在有效期内下载');
                        }))}</View>
                    </View>}
                    {shares.map(row => <View key={row.id} style={{ padding: 12, gap: 8, borderRadius: 10, backgroundColor: theme.colors.surfaceHigh }}>
                        <Text style={{ color: theme.colors.text }}>{row.revokedAt ? '已撤销' : row.expiresAt <= Date.now() ? '已到期' : '有效外链'} · {new Date(row.expiresAt).toLocaleString()}</Text>
                        <Text selectable style={{ color: theme.colors.textSecondary, fontSize: 12 }}>创建于 {new Date(row.createdAt).toLocaleString()} · {row.id.slice(0, 8)}</Text>
                        {!row.revokedAt && row.expiresAt > Date.now() && <View style={{ alignSelf: 'flex-start' }}>{button('撤销外链', () => void run('正在撤销外链', async () => {
                            await revokeFileShare(row.id);
                            if (shareLink?.id === row.id) setShareLink(null);
                            await loadShares(); setNotice('外链已撤销，登录后的原文件仍可下载');
                        }))}</View>}
                    </View>)}
                </View>}
                {tab === 'send' && <View style={{ gap: 12 }}>
                    <Text style={{ fontSize: 16, fontWeight: '600', color: theme.colors.text }}>发送到其他会话</Text>
                    <Text style={{ color: theme.colors.textSecondary }}>放入目标会话的收件目录，不自动启动任务。离线时会等待目标会话重新连接。</Text>
                    <SettingsSelect value={selected} onChange={setSelected} title="选择目标会话" options={[
                        { value: null, label: '选择会话', description: '仅显示支持文件接收的 Agent' },
                        ...eligible.map(session => ({ value: session.id, label: titleOf(session.id), description: (session.metadata?.host || '') + ' · ' + (session.active ? '已连接' : '离线，等待上线') })),
                    ]} />
                    {!eligible.length && <Text style={{ color: theme.colors.textSecondary }}>暂无支持的会话，请升级目标设备的 Agent。</Text>}
                    <View style={{ alignSelf: 'flex-start' }}>{button('发送文件', () => void run('正在加入投递队列', async () => {
                        await deliverFileAsset(file, selected!); await loadDeliveries(); setNotice('已加入投递队列，实际收件结果见下方');
                    }), !selected)}</View>
                    {deliveries.map(row => <View key={row.id} style={{ padding: 12, gap: 5, borderRadius: 10, backgroundColor: theme.colors.surfaceHigh }}>
                        <Text style={{ color: theme.colors.text }}>{titleOf(row.sessionId)} · {{ pending: '等待接收', received: '已写入收件目录', failed: '接收失败' }[row.state]}</Text>
                        {row.detail && <Text selectable style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{row.detail}</Text>}
                    </View>)}
                </View>}
            </>}
            {!file && !!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
        </ScrollView>
    </View></SettingsMenuHost>;
}


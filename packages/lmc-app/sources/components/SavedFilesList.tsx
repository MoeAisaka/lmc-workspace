import React from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { SavedFileCard } from '@/components/SavedFileCard';
import { listFileAssets, type OpenFileAsset } from '@/sync/apiFileAssets';

export function SavedFilesList({ onOpen }: { onOpen?: (id: string) => void }) {
    const { theme } = useUnistyles();
    const [files, setFiles] = React.useState<OpenFileAsset[]>([]);
    const [next, setNext] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState('');
    const alive = React.useRef(true);
    const load = async (before?: string) => {
        setLoading(true); setError('');
        try { const page = await listFileAssets(before); if (alive.current) { setFiles(old => before ? [...old, ...page.files] : page.files); setNext(page.next); } }
        catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '无法加载文件'); }
        finally { if (alive.current) setLoading(false); }
    };
    React.useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
    return <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 12, width: '100%', maxWidth: 900, alignSelf: 'center' }}>
            <Text style={{ color: theme.colors.textSecondary }}>已保存的固定版本。源电脑离线后仍可下载，也可转交到其他会话。</Text>
            {files.map(file => <SavedFileCard onOpen={onOpen} key={file.manifest.id} id={file.manifest.id} name={file.manifest.name} size={file.manifest.size} />)}
            {!loading && !files.length && !error && <Text style={{ color: theme.colors.textSecondary }}>还没有已保存文件。可让 Agent 发布交付物，或在会话文件菜单中选择“保存到 LMC”。</Text>}
            {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
            {loading ? <ActivityIndicator /> : <Pressable accessibilityRole="button" onPress={() => void load(next ?? undefined)} style={{ padding: 12 }}><Text style={{ color: theme.colors.textLink }}>{next ? '加载更多' : '刷新'}</Text></Pressable>}
        </ScrollView>
    </View>;
}


import React from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { SavedFileCard } from '@/components/SavedFileCard';
import { listFileAssets, type OpenFileAsset } from '@/sync/apiFileAssets';
import { t } from '@/text';

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
        catch (error) { if (alive.current) setError(error instanceof Error ? error.message : t('lmc.savedFiles.loadFailed')); }
        finally { if (alive.current) setLoading(false); }
    };
    React.useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
    return <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 12, width: '100%', maxWidth: 900, alignSelf: 'center' }}>
            <Text style={{ color: theme.colors.textSecondary }}>{t('lmc.savedFiles.listIntro')}</Text>
            {files.map(file => <SavedFileCard onOpen={onOpen} key={file.manifest.id} id={file.manifest.id} name={file.manifest.name} size={file.manifest.size} />)}
            {!loading && !files.length && !error && <Text style={{ color: theme.colors.textSecondary }}>{t('lmc.savedFiles.emptyList')}</Text>}
            {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{error}</Text>}
            {loading ? <ActivityIndicator /> : <Pressable accessibilityRole="button" onPress={() => void load(next ?? undefined)} style={{ padding: 12 }}><Text style={{ color: theme.colors.textLink }}>{next ? t('lmc.savedFiles.loadMore') : t('lmc.savedFiles.refresh')}</Text></Pressable>}
        </ScrollView>
    </View>;
}


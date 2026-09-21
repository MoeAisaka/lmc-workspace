import { apiSocket } from '@/sync/apiSocket';
import React from 'react';
import { View, Text, Pressable, ScrollView, TextInput, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { resourceExtension, resourcePathMatches, type ResourceSearchMatch, type ResourceSearchScope, type ResourceSearchSkipReason } from 'lmc-wire';
import { useSession, useSessionMessages } from '@/sync/storage';
import { collectSessionResources } from '@/utils/sessionResources';
import { chooseSessionFile } from '@/utils/lmc/sessionFileActions';
import { resourceHighlightParts } from '@/sync/resourceSearch';
import { useResourceSearch } from '@/hooks/useResourceSearch';
import { SettingsMenuHost, SettingsSelect } from '@/components/lmc/SettingsSelect';
import { t } from '@/text';

type Change = { revision: number; path: string; destination?: string; kind: 'add' | 'update' | 'delete' | 'rename'; patch?: string };
type Review = { cursor: number; paths: string[]; scopePaths?: string[]; entries: Change[]; olderCursor?: number };

function Highlight({ text, query }: { text: string; query: string }) {
    const { theme } = useUnistyles();
    return <>{resourceHighlightParts(text, query).map((part, index) => <Text key={index} style={part.match ? { color: theme.dark ? '#8AB4FF' : theme.colors.textLink, fontWeight: '600' } : undefined}>{part.text}</Text>)}</>;
}

function skipLabel(reason: ResourceSearchSkipReason) {
    const labels = {
        unreadable: t('lmc.resources.searchUnreadable'), unsupported: t('lmc.resources.searchUnsupportedFormat'),
        tooLarge: t('lmc.resources.searchTooLarge'), noText: t('lmc.resources.searchNoText'),
        timeout: t('lmc.resources.searchTimeout'), sensitive: t('lmc.resources.searchSensitive'), changed: t('lmc.resources.searchFileChanged'),
    };
    return labels[reason];
}

export function SessionResourceWindow({ sessionId, onOpen, onBrowse, active = true }: { sessionId: string; onOpen: (path: string) => void; onBrowse: () => void; active?: boolean }) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId);
    const [scope, setScope] = React.useState<ResourceSearchScope>('all');
    const [query, setQuery] = React.useState('');
    const [extension, setExtension] = React.useState<string | null>(null);
    const [review, setReview] = React.useState<Review | null>(null);
    const [reviewError, setReviewError] = React.useState('');
    const [selectedChange, setSelectedChange] = React.useState<Change | null>(null);
    const [showSkipped, setShowSkipped] = React.useState(false);
    const reviewGeneration = React.useRef(0);
    const supported = session?.metadata?.sessionCapabilities?.resourceFiles === true;
    const searchable = session?.metadata?.sessionCapabilities?.resourceSearch === true;
    const readReview = React.useCallback(async (before?: number) => {
        if (!supported) return;
        const generation = ++reviewGeneration.current;
        try {
            const result = await apiSocket.sessionRPC<Review & { error?: string }, { scope: ResourceSearchScope; before?: number }>(sessionId, 'resource-review', { scope, before });
            if (generation !== reviewGeneration.current) return;
            if (result.error) throw new Error(result.error);
            setReview(old => before ? { ...result, entries: [...result.entries, ...(old?.entries || [])] } : result);
            setReviewError('');
        } catch (error) {
            if (generation === reviewGeneration.current) setReviewError(error instanceof Error ? error.message : t('lmc.resources.indexUnavailable'));
        }
    }, [sessionId, scope, supported]);
    React.useEffect(() => {
        setReview(null); setSelectedChange(null); setReviewError('');
        if (!active) return;
        void readReview();
        const timer = setInterval(() => void readReview(), 15000);
        return () => { clearInterval(timer); reviewGeneration.current++; };
    }, [readReview, active]);
    const [busy, setBusy] = React.useState<string | null>(null);
    const chooseFile = (path: string) => chooseSessionFile({ sessionId, path, onPreview: onOpen, onBusyChange: setBusy });
    const { messages, hasMoreOlder } = useSessionMessages(sessionId);
    const transcriptPaths = React.useMemo(() => collectSessionResources(messages), [messages]);
    const files = React.useMemo(() => [...new Set(scope === 'all'
        ? [...(review?.paths || []), ...transcriptPaths]
        : review?.scopePaths ?? review?.entries.flatMap(entry => [entry.path, ...(entry.destination ? [entry.destination] : [])]) ?? [])], [scope, review, transcriptPaths]);
    const formats = React.useMemo(() => {
        const counts = new Map<string, number>();
        files.forEach(path => { const ext = resourceExtension(path); counts.set(ext, (counts.get(ext) ?? 0) + 1); });
        if (extension !== null && !counts.has(extension)) counts.set(extension, 0);
        return [...counts].sort(([a], [b]) => a.localeCompare(b));
    }, [files, extension]);
    const formatLabel = (value: string | null) => value === null ? t('lmc.resources.allFormats') : value ? `.${value}` : t('lmc.resources.noExtension');
    const inFormat = (path: string) => extension === null || resourceExtension(path) === extension;
    const needle = query.trim();
    const { state: search, retry } = useResourceSearch(sessionId, {
        query: needle, scope, extension, paths: scope === 'all' ? transcriptPaths.slice(0, 2000) : [],
    }, active && searchable, review?.cursor ?? 0);
    const matches = React.useMemo(() => {
        const result = new Map<string, ResourceSearchMatch>();
        files.filter(path => (extension === null || resourceExtension(path) === extension) && resourcePathMatches(path, needle))
            .forEach(path => result.set(path, { path, nameMatch: true, snippets: [] }));
        search?.matches.forEach(match => result.set(match.path, match));
        return [...result.values()];
    }, [files, extension, needle, search]);
    const filteredEntries = review?.entries.filter(entry => inFormat(entry.destination ?? entry.path)) ?? [];
    const filtering = needle.length > 0 || extension !== null;
    const searching = !!needle && searchable && !search?.complete && !search?.error;
    const partial = !!search?.skipped.length || !!search?.error || (!searchable && !!needle);
    const clear = () => { setQuery(''); setExtension(null); setShowSkipped(false); };
    const linkColor = theme.dark ? '#8AB4FF' : theme.colors.textLink;
    const infoStyle = { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 17 };
    return <SettingsMenuHost><View style={{ flex: 1, minHeight: 0 }}>
        <Text style={{ ...infoStyle, paddingHorizontal: 16, paddingBottom: 10 }}>{supported ? t('lmc.resources.headerSupported') : t('lmc.resources.headerUnsupported')}{!supported && hasMoreOlder ? t('lmc.resources.headerScrollHint') : ''}</Text>
        {supported && <View style={{ flexDirection: 'row', gap: 4, paddingHorizontal: 10, paddingBottom: 10 }}>{(['all', 'turn', 'unseen'] as const).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: scope === value }} onPress={() => { setScope(value); setSelectedChange(null); }} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: scope === value ? theme.colors.surfacePressed : 'transparent' }}><Text style={{ color: scope === value ? theme.colors.text : theme.colors.textSecondary, fontSize: 12 }}>{{ all: t('lmc.resources.tabAll'), turn: t('lmc.resources.tabTurn'), unseen: t('lmc.resources.tabUnseen') }[value]}</Text></Pressable>)}</View>}
        <View style={{ paddingHorizontal: 12, gap: 8, paddingBottom: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: theme.colors.surfacePressed }}>
                <Ionicons name="search" size={16} color={theme.colors.textSecondary} />
                <TextInput value={query} onChangeText={setQuery} maxLength={200} accessibilityLabel={t('lmc.resources.searchPlaceholder')} placeholder={t('lmc.resources.searchPlaceholder')} placeholderTextColor={theme.colors.textSecondary} autoCapitalize="none" autoCorrect={false} style={{ flex: 1, minWidth: 0, height: 40, fontSize: 13, color: theme.colors.text }} />
                {!!query && <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.resources.clearSearch')} onPress={() => setQuery('')} hitSlop={8}><Ionicons name="close" size={18} color={theme.colors.textSecondary} /></Pressable>}
            </View>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <View style={{ borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 8, minHeight: 36, justifyContent: 'center' }}>
                    <SettingsSelect value={extension} onChange={setExtension} title={t('lmc.resources.fileFormat')} options={[
                        { value: null, label: t('lmc.resources.allFormats'), description: t('lmc.resources.searchItemCount', { count: files.length }) },
                        ...formats.map(([value, count]) => ({ value, label: formatLabel(value), description: t('lmc.resources.searchItemCount', { count }) })),
                    ]} />
                </View>
                <Text style={infoStyle}>{t('lmc.resources.searchResultCount', { count: matches.length, total: Math.max(files.length, search?.total ?? 0) })}</Text>
            </View>
            {!!needle && !searchable && <Text style={infoStyle}>{t('lmc.resources.searchUpgrade')}</Text>}
            {!!needle && searchable && <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                {searching && <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
                <Text accessibilityLiveRegion="polite" style={{ ...infoStyle, flex: 1 }}>{searching
                    ? search ? t('lmc.resources.searchProgress', { scanned: search.scanned, total: search.total }) : t('lmc.resources.searchingBody')
                    : search?.error ? t('lmc.resources.searchFailed') : t('lmc.resources.searchComplete', { count: (search?.scanned ?? 0) - (search?.skipped.length ?? 0) })}</Text>
                {!!search?.error && <Pressable accessibilityRole="button" onPress={retry}><Text style={{ color: linkColor, fontSize: 12 }}>{t('common.retry')}</Text></Pressable>}
            </View>}
            {!!needle && scope !== 'all' && <Text style={infoStyle}>{t('lmc.resources.searchCurrentBody')}</Text>}
            {!!needle && transcriptPaths.length > 2000 && <Text style={infoStyle}>{t('lmc.resources.searchPathLimit')}</Text>}
            {!!needle && !!search?.skipped.length && <Pressable accessibilityRole="button" accessibilityState={{ expanded: showSkipped }} onPress={() => setShowSkipped(value => !value)}><Text style={{ color: linkColor, fontSize: 12 }}>{t('lmc.resources.searchSkippedCount', { count: search.skipped.length })} {showSkipped ? '⌃' : '⌄'}</Text></Pressable>}
            {filtering && <Pressable accessibilityRole="button" onPress={clear}><Text style={{ color: linkColor, fontSize: 12 }}>{t('lmc.resources.clearFilters')}</Text></Pressable>}
        </View>
        {busy && <Text style={{ paddingHorizontal: 16, color: theme.colors.textSecondary }}>{t('lmc.resources.working')}</Text>}
        {!!reviewError && <Text style={{ padding: 12, color: theme.colors.textSecondary }}>{reviewError}</Text>}
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 6, paddingBottom: 12 }}>
            {showSkipped && !!needle && search?.skipped.map(item => <View key={item.path} style={{ padding: 10 }}><Text numberOfLines={2} style={infoStyle}>{item.path}</Text><Text style={infoStyle}>{skipLabel(item.reason)}</Text></View>)}
            {(scope === 'all' || !!needle) && <>
                {matches.length === 0 && !searching && <Text style={{ padding: 16, color: theme.colors.textSecondary, lineHeight: 20 }}>{filtering ? partial ? t('lmc.resources.searchEmptyPartial') : t('lmc.resources.searchEmpty') : t('lmc.resources.emptyAll')}</Text>}
                {matches.map(file => <Pressable key={file.path} accessibilityRole="button" accessibilityLabel={t('lmc.resources.openFile', { path: file.path })} disabled={busy !== null} onPress={() => chooseFile(file.path)} style={({ pressed }) => ({ paddingHorizontal: 10, paddingVertical: 10, borderRadius: 10, backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent' })}>
                    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                        <Ionicons name="document-outline" size={20} color={linkColor} />
                        <View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 13 }}><Highlight text={file.path.replace(/\\/g, '/').split('/').pop() ?? file.path} query={needle} /></Text><Text numberOfLines={1} style={infoStyle}><Highlight text={file.path} query={needle} /></Text></View>
                    </View>
                    {file.snippets.map((snippet, index) => <Text key={index} numberOfLines={3} style={{ ...infoStyle, marginTop: 8 }}>{snippet.page ? t('lmc.resources.searchPage', { value: snippet.page }) : snippet.paragraph ? t('lmc.resources.searchParagraph', { value: snippet.paragraph }) : t('lmc.resources.searchLine', { value: snippet.line ?? 1 })} · <Highlight text={snippet.text} query={needle} /></Text>)}
                </Pressable>)}
            </>}
            {scope !== 'all' && !needle && <>
                <Text style={{ padding: 10, ...infoStyle }}>{t('lmc.resources.reviewNote')}</Text>
                {!!review?.olderCursor && <Pressable onPress={() => void readReview(review.olderCursor)}><Text style={{ padding: 10, color: linkColor }}>{t('lmc.resources.loadOlder')}</Text></Pressable>}
                {filteredEntries.map(entry => <Pressable key={entry.revision} onPress={() => setSelectedChange(selectedChange?.revision === entry.revision ? null : entry)} style={{ padding: 10, borderBottomWidth: 1, borderColor: theme.colors.divider }}>
                    <Text style={{ color: theme.colors.text, fontSize: 13 }}>{{ add: t('lmc.resources.kindAdd'), update: t('lmc.resources.kindUpdate'), delete: t('lmc.resources.kindDelete'), rename: t('lmc.resources.kindRename') }[entry.kind]} · {entry.path}{entry.destination ? ' → ' + entry.destination : ''}</Text>
                    {selectedChange?.revision === entry.revision && <Text selectable style={{ fontFamily: 'monospace', fontSize: 11, lineHeight: 17, paddingTop: 8, color: theme.colors.textSecondary }}>{entry.patch || t('lmc.resources.noPatch')}</Text>}
                </Pressable>)}
                {!filteredEntries.length && <Text style={{ padding: 12, color: theme.colors.textSecondary }}>{extension === null ? t('lmc.resources.emptyReview') : t('lmc.resources.searchEmpty')}</Text>}
                {!!review?.entries.length && <Pressable onPress={() => { void apiSocket.sessionRPC(sessionId, 'resource-review', { viewed: review.cursor, scope }).then(() => readReview()).catch(e => setReviewError(e.message)); }}><Text style={{ padding: 12, color: linkColor }}>{t('lmc.resources.markSeen')}</Text></Pressable>}
            </>}
        </ScrollView>
        <Pressable accessibilityRole="button" onPress={onBrowse} style={{ padding: 12, borderTopWidth: 1, borderColor: theme.colors.divider }}><Text style={{ color: linkColor, textAlign: 'center' }}>{t('lmc.resources.browseProject')}</Text></Pressable>
    </View></SettingsMenuHost>;
}

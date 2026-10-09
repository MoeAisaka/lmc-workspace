import { UI_FONT_CHOICES, CODE_FONT_CHOICES, FONT_HINT_KEYS, codeAssetFont, type AssetFont } from '@/sync/personalizationFonts';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { Switch } from '@/components/Switch';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { SettingsSelect, type SelectOption } from '../SettingsSelect';
import { useLocalSettingMutable, useSetting } from '@/sync/storage';
import { PERSONALIZATION_PRESETS, matchingPersonalizationPreset, accentColors, type Personalization, type PersonalizationPreset } from '@/sync/personalization';
import { resolveUserMessageBubbleColor } from '@/utils/userMessageBubbleColor';
import { t } from '@/text';

type LabelKey = keyof typeof import('@/text/_default').en.personalization;
const label = (key: LabelKey) => t(`personalization.${key}`);

export function PersonalizationSettings({ onReset, colors }: { onReset: () => void; colors: React.ReactNode }) {
    const { theme } = useUnistyles();
    const [value, setValue] = useLocalSettingMutable('personalization');
    const [wide, setWide] = useLocalSettingMutable('chatWideMode');
    const [zen, setZen] = useLocalSettingMutable('zenMode');
    const bubbleColor = useSetting('userMessageBubbleColor');
    const palette = resolveUserMessageBubbleColor(bubbleColor, theme.dark);
    const preset = wide ? 'custom' : matchingPersonalizationPreset(value);
    const [replay, setReplay] = React.useState(0);
    const [fontStatus, setFontStatus] = React.useState('loading');
    const [codeFontStatus, setCodeFontStatus] = React.useState('loading');
    React.useEffect(() => {
        const read = () => {
            setFontStatus(document.documentElement.dataset.lmcFontStatus ?? 'loading');
            setCodeFontStatus(document.documentElement.dataset.lmcCodeFontStatus ?? 'loading');
        };
        read(); window.addEventListener('lmc-font-status', read);
        return () => window.removeEventListener('lmc-font-status', read);
    }, []);
    const fontDescription = (font: string) => font in FONT_HINT_KEYS ? t(`personalization.${FONT_HINT_KEYS[font as keyof typeof FONT_HINT_KEYS]}`) : undefined;
    const fontHint = (font: AssetFont, fontStatus: string) => fontStatus === 'loading' ? t('personalization.fontLoading')
        : font === 'claude' ? t(fontStatus === 'original' ? 'personalization.claudeOriginal' : 'personalization.claudeFallback')
        : fontStatus === 'fallback' ? t('personalization.fontFallback')
        : fontDescription(font);
    const update = <K extends keyof Personalization>(key: K, next: Personalization[K]) => setValue({ ...value, [key]: next });
    const option = <T extends keyof typeof import('@/text/_default').en.personalization>(key: T): SelectOption<T> => ({ value: key, label: label(key) });
    const row = <K extends keyof Personalization>(key: K, options: SelectOption<Personalization[K]>[], subtitle?: string) => (
        <Item key={key} title={label(key)} subtitle={subtitle} subtitleLines={key === 'uiFont' || key === 'codeFont' ? 0 : 2} showChevron={false}
            rightElement={<SettingsSelect title={label(key)} value={value[key]} options={options} onChange={next => update(key, next)} />} />
    );
    const button = { minHeight: 44, justifyContent: 'center' as const, paddingHorizontal: 12, borderRadius: 10, backgroundColor: theme.colors.surfaceHigh };
    return <>
        <ItemGroup title={t('personalization.title')} footer={t('personalization.local')}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 12 }}>
                {(Object.keys(PERSONALIZATION_PRESETS) as PersonalizationPreset[]).map(key => <Pressable key={key}
                    accessibilityRole="button" accessibilityLabel={label(key)} accessibilityState={{ selected: preset === key }}
                    onPress={() => { setValue({ ...PERSONALIZATION_PRESETS[key] }); setWide(false); }}
                    style={[button, { flexGrow: 1, flexBasis: 140, paddingVertical: 12, borderWidth: 1, borderColor: preset === key ? theme.colors.textLink : theme.colors.divider }]}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: preset === key ? theme.colors.textLink : theme.colors.text }}>{label(key)}{preset === key ? ' ✓' : ''}</Text>
                    <Text style={{ fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, marginTop: 4 }}>{t(`personalization.${key}Hint`)}</Text>
                </Pressable>)}
            </View>
            {preset === 'custom' && <Text style={{ color: theme.colors.textSecondary, paddingHorizontal: 16, paddingBottom: 8 }}>{t('personalization.custom')}</Text>}
            {row('chrome', [{value: 'standard', label: t('personalization.chromeStandard')}, {value: 'terminal', label: t('personalization.terminal')}], t('personalization.chromeHint'))}
            {row('readingStyle', (['standard', 'editorial', 'academic'] as const).map(key => ({ value: key, label: t(`personalization.reading${key === 'standard' ? 'Standard' : key === 'editorial' ? 'Editorial' : 'Academic'}`), description: t(`personalization.reading${key === 'standard' ? 'Standard' : key === 'editorial' ? 'Editorial' : 'Academic'}Hint`) })), t('personalization.readingStyleHint'))}
            <View style={{ padding: 16, gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.divider }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>{t('personalization.preview')}</Text>
                    <Pressable accessibilityRole="button" onPress={() => setReplay(n => n + 1)} style={button}>
                        <Text style={{ color: theme.colors.textLink, fontSize: 13 }}>{t('personalization.replay')}</Text>
                    </Pressable>
                </View>
                <View key={replay} {...{ dataSet: { lmcMessage: 'true', lmcPersonalizationPreview: 'true' } }} style={{ gap: theme.personalization.messageGap }}>
                    <View {...{dataSet: {lmcSurface: 'panel'}}} style={{ alignSelf: 'flex-end', maxWidth: '95%', backgroundColor: palette.background, borderRadius: 12, paddingHorizontal: 12 }}>
                        <MarkdownView presentation="plain" markdown={t('personalization.previewUser')} />
                    </View>
                    <MarkdownView markdown={t('personalization.previewReply') + '\n\n```ts\n// LMC · 中文注释 / code\nconst workspace = "LMC";\n```'} />
                </View>
            </View>
        </ItemGroup>
        <ItemGroup title={t('personalization.motion')}>
            {row('motion', ['off', 'gentle', 'full'].map(key => option(key as Personalization['motion'])), t('personalization.motionHint'))}
        </ItemGroup>
        <ItemGroup title={t('personalization.typography')}>
            {row('uiFont', UI_FONT_CHOICES.map(key => ({ ...option(key), description: fontDescription(key) })), fontHint(value.uiFont, fontStatus))}
            {row('codeFont', CODE_FONT_CHOICES.map(key => ({ ...option(key), description: fontDescription(key) })), fontHint(codeAssetFont(value.codeFont, value.uiFont), codeFontStatus))}
            {row('textSize', ['small', 'normal', 'large'].map(key => option(key as Personalization['textSize'])))}
            {row('lineHeight', ['compact', 'normal', 'relaxed'].map(key => option(key as Personalization['lineHeight'])))}
        </ItemGroup>
        <ItemGroup title={t('personalization.colors')}>
            {row('accent', (Object.keys(accentColors) as Personalization['accent'][]).map(key => ({ ...option(key), leading: <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: accentColors[key][theme.dark ? 'dark' : 'light'] }} /> })))}
            {colors}
        </ItemGroup>
        <ItemGroup title={t('personalization.layout')}>
            {row('density', ['compact', 'comfortable'].map(key => option(key as Personalization['density'])))}
            {row('sidebarWidth', ['narrow', 'normal', 'wide'].map(key => option(key as Personalization['sidebarWidth'])))}
            <Item title={t('personalization.contentWidth')} showChevron={false} rightElement={<SettingsSelect<'reading' | 'standard' | 'wide'>
                title={t('personalization.contentWidth')} value={wide ? 'wide' : value.contentWidth}
                options={(['reading', 'standard', 'wide'] as const).map(key => key === 'standard' ? { value: key, label: t('personalization.normal') } : option(key))}
                onChange={next => { setWide(next === 'wide'); if (next !== 'wide') update('contentWidth', next); }} />} />
            <Item title={t('personalization.zen')} subtitle={t('personalization.zenHint')} showChevron={false} rightElement={<Switch value={zen} onValueChange={setZen} />} />
        </ItemGroup>
        <ItemGroup>
            <Pressable accessibilityRole="button" accessibilityLabel={t('personalization.reset')} onPress={onReset}>
                <Item title={t('personalization.reset')} subtitle={t('personalization.resetHint')} subtitleLines={0} showChevron={false} titleStyle={{ color: theme.colors.textLink }} />
            </Pressable>
        </ItemGroup>
    </>;
}

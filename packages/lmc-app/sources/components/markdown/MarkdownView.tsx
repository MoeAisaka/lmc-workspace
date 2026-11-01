import { conversationFontSize, conversationLineHeight } from '@/constants/PersonalizationStyles';
import {
    CalloutKind,
    MarkdownBlock,
    MarkdownListItem,
    MarkdownNumberedListItem,
    MarkdownSpan,
    TableColumnAlignment,
    parseMarkdown,
} from './parseMarkdown';
import * as React from 'react';
import { ActivityIndicator, Image, Pressable, View, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { HorizontalScrollView } from '../HorizontalScrollView';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '../StyledText';
import { Typography } from '@/constants/Typography';
import { SimpleSyntaxHighlighter } from '../SimpleSyntaxHighlighter';
import { Modal } from '@/modal';
import { useLocalSetting } from '@/sync/storage';
import { storeTempText } from '@/sync/persistence';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { MermaidRenderer } from './MermaidRenderer';
import { InteractiveBlock } from './InteractiveBlock';
import { t } from '@/text';
import { isHttpMarkdownLink, parseFileReference } from './linkUtils';
import { chooseSessionFile } from '@/utils/lmc/sessionFileActions';
import { openFileReference } from '@/utils/lmc/openFileReference';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { inferQuestionOptions } from './inferQuestionOptions';
import { useMarkdownImage } from '@/hooks/useMarkdownImage';
import { openImagePreview } from '../ImagePreviewModal';
import { parseMarkdownImageSource } from '@/utils/markdownImage';
import { canCopyImage, copyTable, copyTableImage, renderTableImage, saveTableImage } from './tableCopy';
import { showToast } from '../lmc/Toast';
import { currentSavedFileId } from '@/utils/lmc/savedFileLink';
import { openSavedFile } from '@/components/SavedFileDialog';

// Option type for callback
export type Option = {
    title: string;
    /** Follow-up actions show a short label and send the complete prompt. */
    prompt?: string;
};

export const MarkdownView = React.memo((props: {
    markdown: string;
    /** Static whole-reply export: expand disclosures and omit live embedded apps. */
    imageExport?: boolean;
    onOptionPress?: (option: Option) => void;
    /** Recover brief answer lists in assistant prose, never in documents/tool output. */
    inferOptions?: boolean;
    sessionId?: string;
    /** Reading presets apply to replies/documents, while user bubbles stay compact. */
    presentation?: 'prose' | 'plain';
    /**
     * The parent owns long-press copy (see LongPressCopyable). Suppresses native
     * selection and the built-in copy gesture so only one of them fires.
     */
    externalCopyHandler?: boolean;
}) => {
    const blocks = React.useMemo(() => {
        const parsed = parseMarkdown(props.markdown, { followups: props.inferOptions });
        return props.inferOptions ? inferQuestionOptions(parsed) : parsed;
    }, [props.markdown, props.inferOptions]);

    const markdownCopyV2 = useLocalSetting('markdownCopyV2');
    const selectable = Platform.OS === 'web' || !(markdownCopyV2 || props.externalCopyHandler);
    const router = useRouter();

    const handleLinkPress = React.useCallback((url: string) => {
        const savedId = currentSavedFileId(url);
        if (savedId) { openSavedFile(savedId); return; }
        if (isHttpMarkdownLink(url)) {
            void openExternalUrl(url);
            return;
        }
        const image = parseMarkdownImageSource(url);
        if (props.sessionId && image?.kind === 'file') {
            void openFileReference(props.sessionId, image.path);
            return;
        }
        const reference = parseFileReference(url);
        if (!reference) return;
        if (props.sessionId) chooseSessionFile({ sessionId: props.sessionId, path: reference.path });
        else void openFileReference(undefined, reference.path);
    }, [props.sessionId]);

    const handleLongPress = React.useCallback(() => {
        try {
            const textId = storeTempText(props.markdown);
            router.push(`/text-selection?textId=${textId}`);
        } catch (error) {
            console.error('Error storing text for selection:', error);
            Modal.alert('Error', 'Failed to open text selection. Please try again.');
        }
    }, [props.markdown, router]);

    const renderContent = () => {
        return (
            <View {...{ dataSet: { lmcProse: props.presentation ?? 'prose' } }} style={{ width: '100%', minWidth: 0 }}>
                {blocks.map((block, index) => {
                    const first = index === 0;
                    const last = index === blocks.length - 1;
                    if (block.type === 'text') {
                        return <RenderTextBlock spans={block.content} key={index} first={first} last={last} selectable={selectable} onLinkPress={handleLinkPress} />;
                    } else if (block.type === 'header') {
                        return <RenderHeaderBlock level={block.level} spans={block.content} key={index} first={first} last={last} selectable={selectable} onLinkPress={handleLinkPress} />;
                    } else if (block.type === 'horizontal-rule') {
                        return <View {...{ dataSet: { lmcBlock: 'rule' } }} style={[style.horizontalRule, first && style.first, last && style.last]} key={index} />;
                    } else if (block.type === 'quote') {
                        return <View {...{ dataSet: { lmcBlock: 'quote' } }} style={[style.quote, first && style.first, last && style.last]} key={index}>
                            <MarkdownView imageExport={props.imageExport} markdown={block.content} sessionId={props.sessionId} presentation={props.presentation} externalCopyHandler={props.externalCopyHandler || markdownCopyV2} />
                        </View>;
                    } else if (block.type === 'callout') {
                        return <RenderCalloutBlock kind={block.kind} title={block.title} key={index} first={first} last={last}>
                            {block.content ? (
                                <MarkdownView imageExport={props.imageExport} markdown={block.content} sessionId={props.sessionId} presentation={props.presentation} externalCopyHandler={props.externalCopyHandler || markdownCopyV2} />
                            ) : null}
                        </RenderCalloutBlock>;
                    } else if (block.type === 'list') {
                        return <RenderListBlock items={block.items} key={index} first={first} last={last} selectable={selectable} onLinkPress={handleLinkPress} />;
                    } else if (block.type === 'numbered-list') {
                        return <RenderNumberedListBlock items={block.items} key={index} first={first} last={last} selectable={selectable} onLinkPress={handleLinkPress} />;
                    } else if (block.type === 'code-block') {
                        return <RenderCodeBlock content={block.content} language={block.language} key={index} first={first} last={last} selectable={selectable} />;
                    } else if (block.type === 'mermaid') {
                        return <MermaidRenderer content={block.content} key={index} />;
                    } else if (block.type === 'interactive') {
                        return props.imageExport ? <Text key={index} style={style.text}>{t('lmc.savedFiles.interactiveInOriginal')}</Text> : <InteractiveBlock block={block} sessionId={props.sessionId} key={index} />;
                    } else if (block.type === 'options' || block.type === 'followups') {
                        return <RenderOptionsBlock items={block.items} key={index} first={first} last={last} selectable={selectable} onOptionPress={props.onOptionPress} />;
                    } else if (block.type === 'table') {
                        return <RenderTableBlock headers={block.headers} rows={block.rows} alignments={block.alignments} onLinkPress={handleLinkPress} selectable={selectable} key={index} first={first} last={last} />;
                    } else if (block.type === 'image') {
                        return <RenderImageBlock url={block.url} alt={block.alt} sessionId={props.sessionId} key={index} first={first} last={last} />;
                    } else if (block.type === 'details') {
                        return <RenderDetailsBlock block={block} forceExpanded={props.imageExport} key={index} first={first} last={last} selectable={selectable} onLinkPress={handleLinkPress}>
                            <MarkdownView imageExport={props.imageExport} markdown={block.content} sessionId={props.sessionId} presentation={props.presentation} inferOptions={props.inferOptions} onOptionPress={props.onOptionPress} externalCopyHandler={props.externalCopyHandler || markdownCopyV2} />
                        </RenderDetailsBlock>;
                    } else {
                        return null;
                    }
                })}
            </View>
        );
    };

    if (props.externalCopyHandler || !markdownCopyV2 || Platform.OS === 'web') {
        return renderContent();
    }

    const longPressGesture = Gesture.LongPress()
        .minDuration(500)
        .onStart(() => {
            handleLongPress();
        })
        .runOnJS(true);

    return (
        <GestureDetector gesture={longPressGesture}>
            <View style={{ width: '100%' }}>
                {renderContent()}
            </View>
        </GestureDetector>
    );
});

type RenderSpanProps = {
    spans: MarkdownSpan[];
    baseStyle?: any;
    selectable: boolean;
    onLinkPress: (url: string) => void;
};

const CALLOUT_PALETTE: Record<CalloutKind, {
    icon: keyof typeof Ionicons.glyphMap;
    defaultLabel: string;
    lightColor: string;
    darkColor: string;
    lightBg: string;
    darkBg: string;
}> = {
    note: {
        icon: 'information-circle-outline',
        defaultLabel: 'Note',
        lightColor: '#2563EB',
        darkColor: '#60A5FA',
        lightBg: 'rgba(37, 99, 235, 0.06)',
        darkBg: 'rgba(96, 165, 250, 0.1)',
    },
    tip: {
        icon: 'bulb-outline',
        defaultLabel: 'Tip',
        lightColor: '#059669',
        darkColor: '#34D399',
        lightBg: 'rgba(5, 150, 105, 0.06)',
        darkBg: 'rgba(52, 211, 153, 0.1)',
    },
    important: {
        icon: 'sparkles-outline',
        defaultLabel: 'Important',
        lightColor: '#7C3AED',
        darkColor: '#A78BFA',
        lightBg: 'rgba(124, 58, 237, 0.06)',
        darkBg: 'rgba(167, 139, 250, 0.1)',
    },
    warning: {
        icon: 'warning-outline',
        defaultLabel: 'Warning',
        lightColor: '#D97706',
        darkColor: '#FBBF24',
        lightBg: 'rgba(217, 119, 6, 0.07)',
        darkBg: 'rgba(251, 191, 36, 0.1)',
    },
    caution: {
        icon: 'alert-circle-outline',
        defaultLabel: 'Caution',
        lightColor: '#DC2626',
        darkColor: '#F87171',
        lightBg: 'rgba(220, 38, 38, 0.06)',
        darkBg: 'rgba(248, 113, 113, 0.1)',
    },
};

function RenderCalloutBlock(props: {
    kind: CalloutKind;
    title: string | null;
    first: boolean;
    last: boolean;
    children: React.ReactNode;
}) {
    const { theme } = useUnistyles();
    const spec = CALLOUT_PALETTE[props.kind];
    const accent = theme.dark ? spec.darkColor : spec.lightColor;
    const bg = theme.dark ? spec.darkBg : spec.lightBg;
    return (
        <View
            {...{ dataSet: { lmcBlock: 'callout', lmcCallout: props.kind } }}
            style={[
                style.callout,
                { borderLeftColor: accent, backgroundColor: bg },
                props.first && style.first,
                props.last && style.last,
            ]}
        >
            <View style={style.calloutHeader}>
                <Ionicons accessible={false} name={spec.icon} size={17} color={accent} />
                <Text style={[style.calloutTitle, { color: accent }]}>{props.title || spec.defaultLabel}</Text>
            </View>
            {props.children ? <View style={style.calloutBody}>{props.children}</View> : null}
        </View>
    );
}

function RenderDetailsBlock({ block, children, forceExpanded, first, last, selectable, onLinkPress }: {
    forceExpanded?: boolean;
    block: Extract<MarkdownBlock, { type: 'details' }>;
    first: boolean;
    last: boolean;
    selectable: boolean;
    onLinkPress: (url: string) => void;
    children: React.ReactNode;
}) {
    const [userExpanded, setExpanded] = React.useState(block.open);
    const expanded = forceExpanded || userExpanded;
    const { theme } = useUnistyles();
    const label = block.summary.map(span => span.text).join('') || t('profile.details');
    return (
        <View style={[style.details, first && style.first, last && style.last]}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ expanded }}
                aria-expanded={expanded}
                onPress={() => setExpanded(value => !value)}
                style={({ pressed }) => [style.detailsSummary, pressed && { opacity: 0.7 }]}
            >
                <Ionicons accessible={false} name={expanded ? 'chevron-down' : 'chevron-forward'} size={16} color={theme.colors.textSecondary} />
                <Text style={style.detailsTitle}>
                    {block.summary.length ? (
                        <RenderSpans spans={block.summary} baseStyle={style.detailsTitle} selectable={selectable} onLinkPress={onLinkPress} />
                    ) : label}
                </Text>
            </Pressable>
            {expanded && <View style={style.detailsBody}>{children}</View>}
        </View>
    );
}

function RenderTextBlock(props: { spans: MarkdownSpan[], first: boolean, last: boolean, selectable: boolean, onLinkPress: (url: string) => void }) {
    return (
        <Text
            {...{ dataSet: { lmcBlock: 'paragraph' } }}
            selectable={props.selectable}
            style={[style.text, props.first && style.first, props.last && style.last]}
        >
            <RenderSpans spans={props.spans} baseStyle={style.text} selectable={props.selectable} onLinkPress={props.onLinkPress} />
        </Text>
    );
}

function RenderHeaderBlock(props: { level: 1 | 2 | 3 | 4 | 5 | 6, spans: MarkdownSpan[], first: boolean, last: boolean, selectable: boolean, onLinkPress: (url: string) => void }) {
    const s = (style as any)[`header${props.level}`];
    const headerStyle = [style.header, s, props.first && style.first, props.last && style.last];
    return (
        <Text
            accessibilityRole="header"
            aria-level={props.level}
            {...{ dataSet: { lmcHeading: String(props.level) } }}
            selectable={props.selectable}
            style={headerStyle}
        >
            <RenderSpans spans={props.spans} baseStyle={headerStyle} selectable={props.selectable} onLinkPress={props.onLinkPress} />
        </Text>
    );
}

const BULLETS = ['•', '◦', '▪'] as const;

function RenderTaskMarker(props: { checked: boolean }) {
    const { theme } = useUnistyles();
    return (
        <View style={style.taskMarkerWrap}>
            <Ionicons
                accessible={false}
                name={props.checked ? 'checkbox' : 'square-outline'}
                size={17}
                color={props.checked ? theme.colors.success : theme.colors.textSecondary}
            />
        </View>
    );
}

function RenderListBlock(props: { items: MarkdownListItem[], first: boolean, last: boolean, selectable: boolean, onLinkPress: (url: string) => void }) {
    const listStyle = [style.text, style.list];
    return (
        <View {...{ dataSet: { lmcBlock: 'list' } }} style={[style.listContainer, props.first && style.first, props.last && style.last]}>
            {props.items.map((item, index) => (
                <View key={index} style={[style.listRow, { paddingLeft: item.depth * 20 }]}>
                    {item.checked !== undefined ? (
                        <RenderTaskMarker checked={item.checked} />
                    ) : item.number !== undefined ? (
                        <Text {...{ dataSet: { lmcListText: 'marker' } }} selectable={false} style={[listStyle, style.listMarkerNumber]}>{item.number}.</Text>
                    ) : (
                        <Text {...{ dataSet: { lmcListText: 'marker' } }} selectable={false} style={[listStyle, style.listMarkerBullet]}>{BULLETS[Math.min(item.depth, BULLETS.length - 1)]}</Text>
                    )}
                    <Text
                        {...{ dataSet: { lmcListText: 'body' } }}
                        selectable={props.selectable}
                        style={[listStyle, style.listBody, item.checked && style.taskCheckedBody]}
                    >
                        <RenderSpans spans={item.spans} baseStyle={listStyle} selectable={props.selectable} onLinkPress={props.onLinkPress} />
                    </Text>
                </View>
            ))}
        </View>
    );
}

function RenderNumberedListBlock(props: { items: MarkdownNumberedListItem[], first: boolean, last: boolean, selectable: boolean, onLinkPress: (url: string) => void }) {
    const listStyle = [style.text, style.list];
    return (
        <View {...{ dataSet: { lmcBlock: 'list' } }} style={[style.listContainer, props.first && style.first, props.last && style.last]}>
            {props.items.map((item, index) => (
                <View key={index} style={[style.listRow, { paddingLeft: item.depth * 20 }]}>
                    {item.checked !== undefined ? (
                        <RenderTaskMarker checked={item.checked} />
                    ) : item.bullet ? (
                        <Text {...{ dataSet: { lmcListText: 'marker' } }} selectable={false} style={[listStyle, style.listMarkerBullet]}>{BULLETS[Math.min(item.depth, BULLETS.length - 1)]}</Text>
                    ) : (
                        <Text {...{ dataSet: { lmcListText: 'marker' } }} selectable={false} style={[listStyle, style.listMarkerNumber]}>{item.number}.</Text>
                    )}
                    <Text
                        {...{ dataSet: { lmcListText: 'body' } }}
                        selectable={props.selectable}
                        style={[listStyle, style.listBody, item.checked && style.taskCheckedBody]}
                    >
                        <RenderSpans spans={item.spans} baseStyle={listStyle} selectable={props.selectable} onLinkPress={props.onLinkPress} />
                    </Text>
                </View>
            ))}
        </View>
    );
}

function RenderCodeBlock(props: { content: string, language: string | null, first: boolean, last: boolean, selectable: boolean }) {
    const [copied, setCopied] = React.useState(false);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const { theme } = useUnistyles();

    React.useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current);
    }, []);

    const copyCode = React.useCallback(async () => {
        try {
            await Clipboard.setStringAsync(props.content);
            setCopied(true);
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => setCopied(false), 1600);
        } catch (error) {
            console.error('Failed to copy code:', error);
            Modal.alert(t('common.error'), t('markdown.copyFailed'), [{ text: t('common.ok'), style: 'cancel' }]);
        }
    }, [props.content]);

    return (
        <View style={[style.codeBlock, props.first && style.first, props.last && style.last]}>
            <View style={style.codeHeader}>
                <Text selectable={false} style={style.codeLanguage}>
                    {props.language ? props.language.toLowerCase() : 'code'}
                </Text>
                <View {...{ dataSet: { imageExportIgnore: 'true' } }}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('common.copy')}
                        style={({ pressed }) => [style.copyButton, copied && style.copyButtonDone, pressed && { opacity: 0.72 }]}
                        onPress={copyCode}
                    >
                        <Ionicons
                            accessible={false}
                            name={copied ? 'checkmark' : 'copy-outline'}
                            size={13}
                            color={copied ? theme.colors.success : theme.colors.textSecondary}
                        />
                        <Text selectable={false} style={[style.copyButtonText, copied && { color: theme.colors.success }]}>
                            {copied ? t('markdown.copiedMark') : t('common.copy')}
                        </Text>
                    </Pressable>
                </View>
            </View>
            <HorizontalScrollView
                contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 14 }}
            >
                <SimpleSyntaxHighlighter
                    code={props.content}
                    language={props.language}
                    selectable={props.selectable}
                />
            </HorizontalScrollView>
        </View>
    );
}

function RenderImageBlock(props: { url: string, alt: string, sessionId?: string, first: boolean, last: boolean }) {
    const accessibleLabel = props.alt || 'Markdown image';
    const image = useMarkdownImage(props.url, props.sessionId);
    const savedId = React.useMemo(() => currentSavedFileId(props.url), [props.url]);

    return (
        <View style={[style.imageBlock, props.first && style.first, props.last && style.last]}>
            <View style={style.image}>
                {image.uri && <Pressable accessibilityRole="button" accessibilityLabel={accessibleLabel}
                    onPress={() => openImagePreview(image.uri!, accessibleLabel)} style={{ width: '100%', height: '100%' }}><Image
                    source={{ uri: image.uri }}
                    style={{ width: '100%', height: '100%' }}
                    accessibilityLabel={accessibleLabel}
                    resizeMode="contain"
                    onError={image.onError}
                /></Pressable>}
                {image.status === 'loading' && <ActivityIndicator accessibilityLabel={t('common.loading')} />}
                {image.status === 'failed' && <Pressable accessibilityRole="button" onPress={image.retry} style={{ padding: 12 }}>
                    <Text style={style.imageCaption}>{t('common.retry')}</Text>
                </Pressable>}
                {image.status === 'unsupported' && (savedId
                    ? <Pressable accessibilityRole="button" onPress={() => openSavedFile(savedId)} style={{ padding: 16 }}>
                        <Text style={[style.imageCaption, style.link]}>{t('lmc.savedFiles.notAnImageViewSaved')}</Text>
                    </Pressable>
                    : <Text style={[style.imageCaption, { padding: 16 }]}>{t('lmc.resources.unsupported')}</Text>)}
            </View>
            {props.alt ? (
                <Text style={style.imageCaption}>{props.alt}</Text>
            ) : null}
        </View>
    );
}

function RenderOptionsBlock(props: {
    items: (string | Option)[],
    first: boolean,
    last: boolean,
    selectable: boolean,
    onOptionPress?: (option: Option) => void
}) {
    return (
        <View style={[style.optionsContainer, props.first && style.first, props.last && style.last]}>
            {props.items.map((item, index) => {
                const option = typeof item === 'string' ? { title: item } : item;
                if (props.onOptionPress) {
                    return (
                        <Pressable
                            key={index}
                            accessibilityRole="button"
                            accessibilityLabel={option.title}
                            accessibilityHint={option.prompt}
                            style={({ pressed }) => [
                                style.optionPressable,
                                style.optionButton,
                                pressed && style.optionButtonPressed
                            ]}
                            onPress={() => props.onOptionPress?.(option)}
                        >
                            <Text selectable={props.selectable} style={style.optionButtonText}>{option.title}</Text>
                            {option.prompt && <Text selectable={props.selectable} style={style.optionDescription}>{option.prompt}</Text>}
                        </Pressable>
                    );
                } else {
                    return (
                        <View key={index} style={style.optionItem}>
                            <Text selectable={props.selectable} style={style.optionText}>{option.title}</Text>
                            {option.prompt && <Text selectable={props.selectable} style={style.optionDescription}>{option.prompt}</Text>}
                        </View>
                    );
                }
            })}
        </View>
    );
}

function RenderSpans(props: RenderSpanProps) {
    return (<>
        {props.spans.map((span, index) => {
            const isCode = span.styles.includes('code');
            if (span.url) {
                const imageSource = parseMarkdownImageSource(span.url);
                const followable = isHttpMarkdownLink(span.url) || parseFileReference(span.url) !== null
                    || imageSource?.kind === 'file' || imageSource?.kind === 'saved-file';
                const webDataSet = {
                    ...(isCode ? { lmcInlineCode: 'true' } : {}),
                    ...(followable ? { lmcLink: 'true' } : {}),
                };
                return (
                    <Text
                        key={index}
                        {...(Object.keys(webDataSet).length ? { dataSet: webDataSet } : {})}
                        selectable={props.selectable}
                        accessibilityRole={followable ? 'link' : undefined}
                        style={[Platform.OS !== 'web' && props.baseStyle, followable && style.link, span.styles.map(s => style[s])]}
                        {...(followable && Platform.OS === 'web' ? { onClick: () => props.onLinkPress(span.url!) } as any : {})}
                        onPress={followable && Platform.OS !== 'web'
                            ? () => props.onLinkPress(span.url!)
                            : undefined}
                    >
                        {span.text}
                    </Text>
                );
            } else {
                return (
                    <Text
                        key={index}
                        {...(isCode ? { dataSet: { lmcInlineCode: 'true' } } : {})}
                        selectable={props.selectable}
                        style={[Platform.OS !== 'web' && props.baseStyle, span.styles.map(s => style[s])]}
                    >
                        {span.text}
                    </Text>
                );
            }
        })}
    </>);
}

const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const CODE_CHAR_RATIO = 1.15;

function spansLength(spans: MarkdownSpan[]): number {
    let n = 0;
    for (const s of spans) {
        let cells = 0;
        for (const ch of s.text) cells += WIDE_CHAR.test(ch) ? 2 : 1;
        n += s.styles.includes('code') ? cells * CODE_CHAR_RATIO : cells;
    }
    return n;
}

const TABLE_MIN_COL_WIDTH = 80;
const TABLE_MAX_COL_WIDTH = 360;
const TABLE_CHAR_WIDTH = 8.5;
const TABLE_CELL_H_PADDING = 28;

function alignItemsForColumn(align: TableColumnAlignment | undefined): 'flex-start' | 'center' | 'flex-end' {
    if (align === 'center') return 'center';
    if (align === 'right') return 'flex-end';
    return 'flex-start';
}

function textAlignForColumn(align: TableColumnAlignment | undefined): 'left' | 'center' | 'right' {
    return align ?? 'left';
}

function RenderTableBlock(props: {
    headers: MarkdownSpan[][],
    rows: MarkdownSpan[][][],
    alignments?: TableColumnAlignment[],
    onLinkPress: (url: string) => void,
    selectable: boolean,
    first: boolean,
    last: boolean
}) {
    const columnCount = props.headers.length;
    const rowCount = props.rows.length;
    const isLastCol = (colIndex: number) => colIndex === columnCount - 1;
    const isLastRow = (rowIndex: number) => rowIndex === rowCount - 1;

    const columnWidths = React.useMemo(() => {
        const widths = new Array(columnCount).fill(0);
        for (let c = 0; c < columnCount; c++) {
            widths[c] = Math.max(widths[c], spansLength(props.headers[c] ?? []));
        }
        for (const row of props.rows) {
            for (let c = 0; c < columnCount; c++) {
                widths[c] = Math.max(widths[c], spansLength(row[c] ?? []));
            }
        }
        return widths.map(len => Math.min(TABLE_MAX_COL_WIDTH, Math.max(TABLE_MIN_COL_WIDTH, len * TABLE_CHAR_WIDTH + TABLE_CELL_H_PADDING)));
    }, [props.headers, props.rows, columnCount]);

    const actions = useTableActions(props.headers, props.rows);

    return (
        <View ref={actions.ref} style={[style.tableWrap, props.first && style.first, props.last && style.last]} {...actions.wrapProps}>
        <View style={style.tableContainer}>
            <HorizontalScrollView style={{ flexGrow: 0 }}>
                <View>
                    <View style={[style.tableRow, style.tableHeaderRow]}>
                        {props.headers.map((header, colIndex) => {
                            const colAlign = props.alignments?.[colIndex];
                            return (
                                <View
                                    key={`header-${colIndex}`}
                                    style={[
                                        style.tableCell,
                                        style.tableHeaderCell,
                                        { width: columnWidths[colIndex], alignItems: alignItemsForColumn(colAlign) },
                                        !isLastCol(colIndex) && style.tableCellBorderRight,
                                    ]}
                                >
                                    <Text style={[style.tableHeaderText, { textAlign: textAlignForColumn(colAlign) }]}>
                                        <RenderSpans spans={header} baseStyle={style.tableHeaderText} onLinkPress={props.onLinkPress} selectable={props.selectable} />
                                    </Text>
                                </View>
                            );
                        })}
                    </View>
                    {props.rows.map((row, rowIndex) => (
                        <View
                            key={`row-${rowIndex}`}
                            {...{ dataSet: { lmcTableRow: rowIndex % 2 === 1 ? 'odd' : 'even' } }}
                            style={[style.tableRow, !isLastRow(rowIndex) && style.tableRowBorderBottom]}
                        >
                            {props.headers.map((_, colIndex) => {
                                const colAlign = props.alignments?.[colIndex];
                                return (
                                    <View
                                        key={`cell-${rowIndex}-${colIndex}`}
                                        style={[
                                            style.tableCell,
                                            { width: columnWidths[colIndex], alignItems: alignItemsForColumn(colAlign) },
                                            !isLastCol(colIndex) && style.tableCellBorderRight,
                                        ]}
                                    >
                                        <Text style={[style.tableCellText, { textAlign: textAlignForColumn(colAlign) }]}>
                                            <RenderSpans spans={row[colIndex] ?? []} baseStyle={style.tableCellText} onLinkPress={props.onLinkPress} selectable={props.selectable} />
                                        </Text>
                                    </View>
                                );
                            })}
                        </View>
                    ))}
                </View>
            </HorizontalScrollView>
        </View>
        {actions.shown && (
            <View style={[style.tableActions, actions.touch && style.tableActionsTouch]}>
                {actions.items.map((item, index) => (
                    <React.Fragment key={item.key}>
                        {index > 0 && <View style={style.tableActionDivider} />}
                        <Pressable accessibilityRole="button" onPress={item.run} style={[style.tableAction, actions.touch && style.tableActionTouch, item.state === 'done' && style.tableActionDone]}>
                            <Text selectable={false} style={[style.tableActionText, actions.touch && style.tableActionTextTouch, item.state === 'done' && style.tableActionTextDone, item.state === 'failed' && style.tableActionTextFailed]}>{item.label}</Text>
                        </Pressable>
                    </React.Fragment>
                ))}
            </View>
        )}
        </View>
    );
}

type TableActionKey = 'table' | 'image';

function useTableActions(headers: MarkdownSpan[][], rows: MarkdownSpan[][][]) {
    const web = Platform.OS === 'web' && typeof document !== 'undefined';
    const touch = React.useMemo(() => web && !!window.matchMedia?.('(hover: none)').matches, [web]);
    const imageToClipboard = React.useMemo(() => web && canCopyImage(), [web]);
    const ref = React.useRef<View>(null);
    const [shown, setShown] = React.useState(false);
    const [result, setResult] = React.useState<{ key: TableActionKey; state: 'done' | 'failed' } | null>(null);
    const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    React.useEffect(() => {
        if (!shown || !touch) return;
        const close = (event: Event) => {
            const node = ref.current as unknown as HTMLElement | null;
            if (node && !node.contains(event.target as Node)) setShown(false);
        };
        document.addEventListener('pointerdown', close, true);
        return () => document.removeEventListener('pointerdown', close, true);
    }, [shown, touch]);

    const report = React.useCallback((key: TableActionKey, ok: boolean, message: string) => {
        if (touch) {
            showToast(ok ? message : t('markdown.copyFailed'), ok ? 'info' : 'error');
            setShown(false);
            return;
        }
        setResult({ key, state: ok ? 'done' : 'failed' });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setResult(null), 1500);
    }, [touch]);

    const image = React.useCallback(() => {
        const node = ref.current as unknown as HTMLElement;
        const resolve = (family: string) => {
            const probe = document.createElement('span');
            probe.style.fontFamily = family;
            node.appendChild(probe);
            const resolved = getComputedStyle(probe).fontFamily;
            probe.remove();
            return resolved || 'sans-serif';
        };
        const family = (variant?: 'italic' | 'semiBold') => resolve(Typography.default(variant).fontFamily as string);
        return renderTableImage(headers, rows, { regular: family(), semiBold: family('semiBold'), italic: family('italic'), mono: resolve(Typography.mono().fontFamily as string) });
    }, [headers, rows]);

    const items = [
        {
            key: 'table' as const,
            label: t('markdown.copyTable'),
            run: () => { copyTable(headers, rows).then(() => report('table', true, t('markdown.tableCopied')), () => report('table', false, '')); },
        },
        imageToClipboard ? {
            key: 'image' as const,
            label: t('markdown.copyTableImage'),
            run: () => { copyTableImage(image()).then(() => report('image', true, t('markdown.tableImageCopied')), () => report('image', false, '')); },
        } : {
            key: 'image' as const,
            label: t('markdown.saveTableImage'),
            run: () => { saveTableImage(image()).then(() => { if (touch) setShown(false); }, () => report('image', false, '')); },
        },
    ].map((item) => {
        const state = result?.key === item.key ? result.state : null;
        return { ...item, state, label: state === 'done' ? t('markdown.copiedMark') : state === 'failed' ? t('markdown.copyFailed') : item.label };
    });

    const wrapProps = !web ? {} : touch
        ? { onClick: (event: { target: unknown }) => {
            const node = ref.current as unknown as HTMLElement | null;
            const table = node?.firstElementChild;
            if (table && table.contains(event.target as Node)) setShown((value) => !value);
        } }
        : { onMouseEnter: () => setShown(true), onMouseLeave: () => setShown(false) };

    return { ref, shown: web && shown, touch, items, wrapProps: wrapProps as object };
}

const style = StyleSheet.create((theme) => ({
    text: {
        ...Typography.default(),
        fontSize: conversationFontSize(16),
        lineHeight: conversationLineHeight(24),
        marginTop: 8,
        marginBottom: 10,
        color: theme.colors.text,
        fontWeight: '400',
    },

    italic: {
        fontStyle: 'italic',
    },
    bold: {
        ...Typography.default('semiBold'),
        fontWeight: '700',
    },
    semibold: {
        ...Typography.default('semiBold'),
        fontWeight: '600',
    },
    strikethrough: {
        textDecorationLine: 'line-through',
        opacity: 0.72,
    },
    code: {
        ...Typography.mono(),
        fontSize: conversationFontSize(14),
        lineHeight: conversationLineHeight(21),
        color: theme.colors.text,
        ...(Platform.OS !== 'web' ? {
            backgroundColor: theme.colors.surfaceHighest,
            paddingHorizontal: 5,
            borderRadius: 4,
        } : {}),
    },
    link: {
        ...Typography.default(),
        color: Platform.select({ web: theme.colors.text, default: theme.colors.textLink }),
        fontWeight: '400',
        textDecorationLine: 'underline',
        cursor: 'pointer',
    },

    // Headers
    header: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    header1: {
        fontSize: conversationFontSize(23),
        lineHeight: conversationLineHeight(32),
        fontWeight: '700',
        marginTop: 22,
        marginBottom: 10,
    },
    header2: {
        fontSize: conversationFontSize(19.5),
        lineHeight: conversationLineHeight(28),
        fontWeight: '700',
        marginTop: 20,
        marginBottom: 8,
    },
    header3: {
        fontSize: conversationFontSize(17.5),
        lineHeight: conversationLineHeight(26),
        fontWeight: '600',
        marginTop: 16,
        marginBottom: 6,
    },
    header4: {
        fontSize: conversationFontSize(16),
        lineHeight: conversationLineHeight(24),
        fontWeight: '600',
        marginTop: 12,
        marginBottom: 6,
    },
    header5: {
        fontSize: conversationFontSize(15),
        lineHeight: conversationLineHeight(22.5),
        fontWeight: '600',
        marginTop: 10,
        marginBottom: 4,
    },
    header6: {
        fontSize: conversationFontSize(14),
        lineHeight: conversationLineHeight(21),
        fontWeight: '600',
        color: theme.colors.textSecondary,
        marginTop: 10,
        marginBottom: 4,
    },

    // Lists
    list: {
        ...Typography.default(),
        color: theme.colors.text,
        marginTop: 0,
        marginBottom: 0,
    },
    listContainer: {
        flexDirection: 'column',
        marginTop: 6,
        marginBottom: 12,
        gap: 7,
    },
    listRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
    },
    listMarkerBullet: {
        minWidth: 16,
        marginRight: 6,
        color: theme.colors.textSecondary,
    },
    listMarkerNumber: {
        minWidth: 22,
        marginRight: 6,
        color: theme.colors.textSecondary,
        fontVariant: ['tabular-nums'],
    },
    listBody: {
        flex: 1,
        minWidth: 0,
    },
    taskMarkerWrap: {
        marginRight: 8,
        paddingTop: 3,
    },
    taskCheckedBody: {
        opacity: 0.78,
    },

    // Quotes & Callouts
    quote: {
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.divider,
        paddingHorizontal: 16,
        paddingVertical: 8,
        marginVertical: 12,
        borderTopRightRadius: 8,
        borderBottomRightRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
    },
    callout: {
        borderLeftWidth: 3.5,
        borderRadius: 10,
        paddingHorizontal: 16,
        paddingVertical: 12,
        marginVertical: 12,
        gap: 6,
    },
    calloutHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
    },
    calloutTitle: {
        ...Typography.default('semiBold'),
        fontSize: conversationFontSize(14.5),
        lineHeight: conversationLineHeight(21),
        fontWeight: '600',
    },
    calloutBody: {
        minWidth: 0,
    },

    // Edge trims
    first: {
        marginTop: 0,
    },
    last: {
        marginBottom: 0,
    },

    // Details & Code Block
    details: {
        marginVertical: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        overflow: 'hidden',
        backgroundColor: theme.colors.surfaceHigh,
    },
    detailsSummary: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 42,
        paddingHorizontal: 14,
        paddingVertical: 8,
        gap: 8,
    },
    detailsTitle: {
        ...Typography.default('semiBold'),
        fontSize: conversationFontSize(15),
        lineHeight: conversationLineHeight(22.5),
        color: theme.colors.text,
        flex: 1,
        minWidth: 0,
    },
    detailsBody: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
        padding: 14,
        backgroundColor: theme.colors.surface,
    },
    codeBlock: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        marginVertical: 12,
        overflow: 'hidden',
        width: '100%',
    },
    codeHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
    codeLanguage: {
        ...Typography.mono(),
        color: theme.colors.textSecondary,
        fontSize: conversationFontSize(12),
        lineHeight: conversationLineHeight(18),
    },
    codeText: {
        ...Typography.mono(),
        color: theme.colors.text,
        fontSize: conversationFontSize(14),
        lineHeight: conversationLineHeight(21),
    },
    copyButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        cursor: 'pointer',
    },
    copyButtonDone: {
        backgroundColor: theme.colors.surfaceHighest,
    },
    copyButtonText: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: conversationFontSize(12),
        lineHeight: conversationLineHeight(16),
    },
    horizontalRule: {
        height: 1,
        backgroundColor: theme.colors.divider,
        marginTop: 18,
        marginBottom: 18,
    },
    imageBlock: {
        width: '100%',
        maxWidth: 520,
        marginVertical: 10,
        alignSelf: 'flex-start',
        gap: 8,
    },
    image: {
        width: '100%',
        minHeight: 160,
        height: 240,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHighest,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
    },
    imageCaption: {
        ...Typography.default(),
        fontSize: conversationFontSize(14),
        lineHeight: conversationLineHeight(21),
        color: theme.colors.textSecondary,
    },

    // Options Block
    optionsContainer: {
        flexDirection: 'column',
        gap: 8,
        marginVertical: 10,
    },
    optionPressable: {
        borderRadius: Platform.select({ web: 10, default: 18 }),
    },
    optionItem: {
        backgroundColor: Platform.select({ web: theme.colors.surfaceHighest, default: theme.colors.surface }),
        borderRadius: Platform.select({ web: 10, default: 18 }),
        paddingHorizontal: 16,
        paddingVertical: Platform.select({ web: 12, default: 14 }),
        borderWidth: Platform.select({ web: 1, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.divider,
        overflow: 'hidden',
    },
    optionItemPressed: {
        backgroundColor: Platform.select({ web: theme.colors.surfaceHigh, default: theme.colors.surfacePressed }),
        opacity: Platform.select({ web: 0.7, default: 1 }),
    },
    optionText: {
        ...Typography.default(),
        fontSize: conversationFontSize(16),
        lineHeight: conversationLineHeight(24),
        color: theme.colors.text,
    },
    optionDescription: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: conversationFontSize(14),
        lineHeight: conversationLineHeight(21),
        marginTop: 4,
    },
    optionButton: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 9,
        overflow: 'hidden',
    },
    optionButtonPressed: {
        opacity: 0.7,
    },
    optionButtonText: {
        ...Typography.default(),
        fontSize: conversationFontSize(16),
        lineHeight: conversationLineHeight(24),
        color: theme.colors.text,
    },

    // Table
    tableWrap: {
        marginVertical: 12,
        maxWidth: '100%',
        alignSelf: 'flex-start',
    },
    tableActions: {
        position: 'absolute',
        right: 8,
        bottom: '100%',
        marginBottom: -6,
        zIndex: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        boxShadow: '0 2px 6px rgba(0, 0, 0, 0.08)',
    },
    tableActionsTouch: {
        padding: 3,
        borderRadius: 8,
    },
    tableAction: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 4,
        cursor: 'pointer',
    },
    tableActionTouch: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 5,
    },
    tableActionDone: {
        backgroundColor: theme.colors.surfaceHighest,
    },
    tableActionDivider: {
        width: 1,
        height: 14,
        backgroundColor: theme.colors.divider,
    },
    tableActionText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 12,
        lineHeight: 18,
    },
    tableActionTextTouch: {
        fontSize: 13,
        lineHeight: 20,
    },
    tableActionTextDone: {
        color: theme.colors.success,
    },
    tableActionTextFailed: {
        color: theme.colors.textDestructive,
    },
    tableContainer: {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        overflow: 'hidden',
        maxWidth: '100%',
    },
    tableRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
    },
    tableRowBorderBottom: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    tableHeaderRow: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    tableCell: {
        paddingHorizontal: 14,
        paddingVertical: 9,
        alignItems: 'flex-start',
        overflow: 'hidden',
    },
    tableCellBorderRight: {
        borderRightWidth: 1,
        borderRightColor: theme.colors.divider,
    },
    tableHeaderCell: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    tableHeaderText: {
        ...(Platform.OS === 'web' ? ({ wordBreak: 'break-word' } as object) : {}),
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: conversationFontSize(15),
        lineHeight: conversationLineHeight(22.5),
    },
    tableCellText: {
        ...(Platform.OS === 'web' ? ({ wordBreak: 'break-word' } as object) : {}),
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: conversationFontSize(15),
        lineHeight: conversationLineHeight(22.5),
    },

    ...(Platform.OS === 'web' ? {
        _____web_global_styles: {}
    } : {}),
}));

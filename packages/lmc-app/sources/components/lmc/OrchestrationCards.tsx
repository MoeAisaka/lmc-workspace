import { Typography } from '@/constants/Typography';
import { conversationFontSize, conversationLineHeight } from '@/constants/PersonalizationStyles';
import { Text } from '@/components/StyledText';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { parseEnvelope, type Envelope, type ReportStatus, type ReviewStatus } from '@/sync/orchestrationEnvelope';
import { parseMail } from '@/sync/orchestrationTasks';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { lmcColors } from './lmcColors';
import { orchestrationTone } from './orchestrationTone';
import { t } from '@/text';

/** Keys built at runtime (a field or state name) have no static parameter type. */
const tk = (key: string): string => (t as unknown as (k: string) => string)(key);

/**
 * How a hub and its workers see each other in the transcript.
 *
 * Mail between bound sessions arrives as a user message with the runner's
 * framing on top; shown as a user bubble it would read as something the
 * person said. These cards say who wrote it and, when the body is a task,
 * report or review envelope, lay long fields out as reading sections. Only
 * short metadata shares a label/value row, so prose has the full phone width.
 *
 * Direction is drawn, not just written: ↓ for a task travelling down, ↑ for
 * a report travelling up, ✓/↩ for a verdict. Reviewing is the hub's job, so
 * the cards carry no verdict controls: the person talks to the hub.
 */
export function MailBlock({ text, sessionId }: { text: string; sessionId?: string }) {
    const { theme } = useUnistyles();
    const mail = React.useMemo(() => parseMail(text), [text]);
    if (!mail) return null;
    const envelope = parseEnvelope(mail.body);
    if (envelope) {
        return <EnvelopeCard envelope={envelope} direction="in" counterpartId={mail.senderId} counterpartLabel={mail.who} sessionId={sessionId} />;
    }
    const label = mail.relation === 'hub' ? t('lmc.orchestration.fromHub') : mail.relation === 'worker' ? t('lmc.orchestration.fromWorker') : t('lmc.orchestration.mailFrom', { who: mail.who });
    return (
        <View {...{ dataSet: { lmcMail: 'message' } }} style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider }]}>
            <View style={styles.head}>
                <Ionicons name="mail-outline" size={13} color={theme.colors.textSecondary} />
                <Text style={[styles.headText, { color: theme.colors.textSecondary }]} numberOfLines={1}>{label}{mail.relation !== 'other' ? ` · ${mail.who}` : ''}</Text>
            </View>
            <View {...{ dataSet: { lmcMailSection: 'body' } }} style={styles.section}>
                <MarkdownView markdown={mail.body} sessionId={sessionId} />
            </View>
        </View>
    );
}

export function EnvelopeCard({ envelope, direction, counterpartId, counterpartLabel, sessionId }: {
    envelope: Envelope;
    /** `in`: this session received it. `out`: this session sent it. */
    direction: 'in' | 'out';
    counterpartId: string | null;
    counterpartLabel?: string | null;
    sessionId?: string;
}) {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const navigate = useNavigateToSession();
    const [showEvidence, setShowEvidence] = React.useState(false);
    const isTask = envelope.kind === 'task';
    const isReview = envelope.kind === 'review';
    // A task goes down the hierarchy whichever side draws it; a report goes
    // up; a verdict is a mark, not a direction.
    const arrow = isTask ? '↓' : isReview ? (envelope.status === 'accepted' ? '✓' : '↩') : '↑';
    const accent = isTask ? colors.brand : isReview ? orchestrationTone(envelope.status, theme).fg : theme.colors.textSecondary;
    const kind = isTask ? t('lmc.orchestration.task') : isReview ? t('lmc.orchestration.review') : t('lmc.orchestration.report');
    const status: ReportStatus | ReviewStatus | null = envelope.kind === 'report' || envelope.kind === 'review' ? envelope.status : null;
    const pill = status ? orchestrationTone(status, theme) : null;
    const fields = Object.entries(envelope.fields).filter(([name, value]) => !!value?.trim() && name !== 'evidence') as [string, string][];
    const evidence = envelope.kind === 'report' ? envelope.fields.evidence?.trim() : undefined;
    const attemptLabel = envelope.attempt > 0 ? ` · ${t('lmc.orchestration.attempt', { n: envelope.attempt })}` : '';


    return (
        <View {...{ dataSet: { lmcMail: envelope.kind } }} style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider }]}>
            <View style={[styles.head, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider }]}>
                <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                    <Text style={[styles.headText, { color: accent }]}>{arrow} {kind}{attemptLabel}</Text>
                    <Text selectable style={[styles.identity, { color: theme.colors.textSecondary }]}>{envelope.id}{counterpartLabel && direction === 'in' ? ` · ${counterpartLabel}` : ''}</Text>
                </View>
                {status && pill && (
                    <View style={[styles.pill, { backgroundColor: pill.bg }]}><Text style={[styles.pillText, { color: pill.fg }]}>{tk(`lmc.orchestration.state.${status}`)}</Text></View>
                )}
            </View>
            <View style={styles.fields}>
                {fields.map(([name, value]) => {
                    const metadata = ['stage', 'run', 'cost', 'model'].includes(name) && value.length < 160 && !value.includes('\n');
                    return <View key={name} {...{ dataSet: { lmcMailSection: name } }} style={metadata ? styles.metadataRow : styles.section}>
                        <Text style={[styles.fieldName, metadata && styles.metadataName, { color: theme.colors.textSecondary }]}>{tk(`lmc.orchestration.field.${name}`)}</Text>
                        {metadata ? <Text selectable style={[styles.fieldValue, { color: theme.colors.text }]}>{value}</Text>
                            : <MarkdownView markdown={value} sessionId={sessionId} />}
                    </View>;
                })}
            </View>
            {evidence && (
                <View style={styles.evidence}>
                    <Pressable accessibilityRole="button" accessibilityLabel={showEvidence ? t('lmc.orchestration.hideEvidence') : t('lmc.orchestration.showEvidence')} accessibilityState={{ expanded: showEvidence }} aria-expanded={showEvidence} onPress={() => setShowEvidence((v) => !v)} style={styles.evidenceToggle}>
                        <Ionicons accessible={false} name={showEvidence ? 'chevron-down' : 'chevron-forward'} size={12} color={theme.colors.textSecondary} />
                        <Text style={[styles.evidenceLabel, { color: theme.colors.textSecondary }]}>{showEvidence ? t('lmc.orchestration.hideEvidence') : t('lmc.orchestration.showEvidence')}</Text>
                    </Pressable>
                    {showEvidence && (
                        <View style={[styles.evidenceBox, { backgroundColor: theme.colors.groupped.background, borderColor: theme.colors.divider }]}>
                            <Text selectable style={[styles.evidenceText, { color: theme.colors.textSecondary }]}>{evidence}</Text>
                        </View>
                    )}
                </View>
            )}
            {counterpartId && (
                <View style={styles.actions}>
                        <Pressable accessibilityRole="button" onPress={() => navigate(counterpartId)} style={({ pressed }) => [styles.button, { borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}>
                            <Text style={[styles.buttonText, { color: theme.colors.text }]}>{t('lmc.orchestration.openCounterpart')}</Text>
                        </Pressable>
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    card: { marginHorizontal: 16, marginVertical: 8, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 16, minWidth: 0 },
    head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingBottom: 12 },
    headText: { fontSize: 13, lineHeight: 20, fontWeight: '600', flexShrink: 1 },
    identity: { fontSize: 12, lineHeight: 19 },
    fields: { gap: 20 },
    section: { minWidth: 0, gap: 8 },
    metadataRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    metadataName: { width: 44 },
    fieldName: { fontSize: conversationFontSize(12), lineHeight: conversationLineHeight(22), fontWeight: '600' },
    fieldValue: { flex: 1, minWidth: 0, fontSize: conversationFontSize(14), lineHeight: conversationLineHeight(22) },
    pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
    pillText: { fontSize: 11, lineHeight: 18, fontWeight: '600' },
    evidence: { gap: 6 },
    evidenceToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 },
    evidenceLabel: { fontSize: 13 },
    evidenceBox: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, padding: 10 },
    evidenceText: { fontSize: conversationFontSize(13), lineHeight: conversationLineHeight(21), ...Typography.mono() },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
    button: { minHeight: 44, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
    buttonText: { fontSize: 13, fontWeight: '600' },
}));

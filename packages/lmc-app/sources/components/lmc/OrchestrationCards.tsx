import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
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
 * report or review envelope, lay the envelope out field by field — a hub
 * reviewing reports reads a column of labels, not a paragraph.
 *
 * Direction is drawn, not just written: ↓ for a task travelling down, ↑ for
 * a report travelling up, ✓/↩ for a verdict. Reviewing is the hub's job, so
 * the cards carry no verdict controls: the person talks to the hub.
 */
export function MailBlock({ text }: { text: string }) {
    const { theme } = useUnistyles();
    const mail = React.useMemo(() => parseMail(text), [text]);
    if (!mail) return null;
    const envelope = parseEnvelope(mail.body);
    if (envelope) {
        return <EnvelopeCard envelope={envelope} direction="in" counterpartId={mail.senderId} counterpartLabel={mail.who} />;
    }
    const label = mail.relation === 'hub' ? t('lmc.orchestration.fromHub') : mail.relation === 'worker' ? t('lmc.orchestration.fromWorker') : t('lmc.orchestration.mailFrom', { who: mail.who });
    return (
        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider }]}>
            <View style={styles.head}>
                <Ionicons name="mail-outline" size={13} color={theme.colors.textSecondary} />
                <Text style={[styles.headText, { color: theme.colors.textSecondary }]} numberOfLines={1}>{label}{mail.relation !== 'other' ? ` · ${mail.who}` : ''}</Text>
            </View>
            <Text selectable style={[styles.body, { color: theme.colors.text }]}>{mail.body}</Text>
        </View>
    );
}

export function EnvelopeCard({ envelope, direction, counterpartId, counterpartLabel }: {
    envelope: Envelope;
    /** `in`: this session received it. `out`: this session sent it. */
    direction: 'in' | 'out';
    counterpartId: string | null;
    counterpartLabel?: string | null;
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
        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider }]}>
            <View style={styles.head}>
                <Text style={[styles.headText, { color: accent }]} numberOfLines={1}>
                    {arrow} {kind} {envelope.id}{attemptLabel}{counterpartLabel && direction === 'in' ? ` · ${counterpartLabel}` : ''}
                </Text>
                <View style={{ flex: 1 }} />
                {status && pill && (
                    <View style={[styles.pill, { backgroundColor: pill.bg }]}><Text style={[styles.pillText, { color: pill.fg }]}>{tk(`lmc.orchestration.state.${status}`)}</Text></View>
                )}
            </View>
            {fields.map(([name, value]) => (
                <View key={name} style={styles.fieldRow}>
                    <Text style={[styles.fieldName, { color: theme.colors.textSecondary }]}>{tk(`lmc.orchestration.field.${name}`)}</Text>
                    <Text selectable style={[styles.fieldValue, { color: theme.colors.text }]}>{value}</Text>
                </View>
            ))}
            {evidence && (
                <View style={styles.evidence}>
                    <Pressable accessibilityRole="button" onPress={() => setShowEvidence((v) => !v)} style={styles.evidenceToggle}>
                        <Ionicons name={showEvidence ? 'chevron-down' : 'chevron-forward'} size={12} color={theme.colors.textSecondary} />
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
    card: { marginHorizontal: 16, marginVertical: 6, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 10, gap: 4 },
    head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingBottom: 4 },
    headText: { fontSize: 12, fontWeight: '600', flexShrink: 1 },
    body: { fontSize: 14, lineHeight: 20, paddingHorizontal: 14 },
    fieldRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 14, paddingVertical: 3 },
    fieldName: { width: 40, fontSize: 12, lineHeight: 18 },
    fieldValue: { flex: 1, fontSize: 13, lineHeight: 18 },
    pill: { paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999 },
    pillText: { fontSize: 11, fontWeight: '600' },
    evidence: { paddingHorizontal: 14, paddingTop: 4, gap: 6 },
    evidenceToggle: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    evidenceLabel: { fontSize: 12 },
    evidenceBox: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, padding: 10 },
    evidenceText: { fontSize: 11.5, lineHeight: 16, fontFamily: 'Menlo' },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, paddingHorizontal: 14, paddingTop: 8 },
    button: { height: 30, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
    buttonText: { fontSize: 12, fontWeight: '600' },
}));

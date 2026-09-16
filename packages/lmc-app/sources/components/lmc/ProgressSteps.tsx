import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { lmcColors } from './lmcColors';

/**
 * The step column shared by the engine-switch card and the refresh card.
 *
 * Both narrate the same kind of thing — a relaunch that crosses processes and
 * takes a while — so they draw it the same way: one mark per step, a title,
 * and a second line saying what the step is doing or why it stopped. Kept
 * free of any notion of what the steps are; the callers own that.
 */
export type ProgressStepTone = 'done' | 'active' | 'todo' | 'failed';

export function ProgressStepRow(props: {
    tone: ProgressStepTone;
    title: string;
    detail?: string | null;
    /** A command the reader should run, printed so it can be copied, with the device it belongs to. */
    command?: { text: string; host?: string | null } | null;
}) {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const muted = props.tone === 'todo';
    const detailColor = props.tone === 'failed' ? theme.colors.status.error : props.tone === 'active' ? colors.brand : theme.colors.textSecondary;
    return (
        <View style={styles.step}>
            <ProgressStepMark tone={props.tone} />
            <View style={styles.stepBody}>
                <Text style={[styles.stepTitle, { color: muted ? theme.colors.textSecondary : theme.colors.text }, props.tone === 'active' && styles.stepTitleActive]}>{props.title}</Text>
                {props.detail ? <Text style={[styles.stepDetail, { color: detailColor }]}>{props.detail}</Text> : null}
                {props.command ? (
                    <View style={[styles.command, { backgroundColor: colors.subtle }]}>
                        <Text selectable style={[styles.commandText, { color: theme.colors.text }]}>{props.command.text}</Text>
                        {props.command.host ? <Text style={[styles.commandHost, { color: theme.colors.textSecondary }]}>{props.command.host}</Text> : null}
                    </View>
                ) : null}
            </View>
        </View>
    );
}

/**
 * A filled disc with a check for done, a ring with a live dot for the step in
 * progress, an empty ring ahead, a filled red disc where it failed. Drawn
 * rather than iconified so the column reads as one thing.
 */
export function ProgressStepMark({ tone }: { tone: ProgressStepTone }) {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    if (tone === 'done') {
        return <View style={[styles.mark, { backgroundColor: colors.brand }]}><Ionicons name="checkmark" size={12} color="#FFFFFF" /></View>;
    }
    if (tone === 'failed') {
        return <View style={[styles.mark, { backgroundColor: theme.colors.status.error }]}><Text style={styles.markBang}>!</Text></View>;
    }
    if (tone === 'active') {
        return <View style={[styles.mark, styles.ring, { borderColor: colors.brand }]}><View style={[styles.dot, { backgroundColor: colors.brand }]} /></View>;
    }
    return <View style={[styles.mark, styles.ring, { borderColor: colors.border }]} />;
}

export function formatElapsed(ms: number): string {
    const total = Math.floor(Math.max(0, ms) / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

const styles = StyleSheet.create(() => ({
    step: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    stepBody: { flex: 1, gap: 2, paddingTop: 1 },
    stepTitle: { fontSize: 14, lineHeight: 18 },
    stepTitleActive: { fontWeight: '600' },
    stepDetail: { fontSize: 12, lineHeight: 17 },
    mark: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    ring: { borderWidth: 2 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    markBang: { color: '#FFFFFF', fontSize: 12, fontWeight: '700', lineHeight: 14 },
    command: { marginTop: 6, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
    commandText: { flex: 1, fontSize: 13, fontFamily: 'Menlo' },
    commandHost: { fontSize: 12 },
}));

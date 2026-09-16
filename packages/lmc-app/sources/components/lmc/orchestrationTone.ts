import { lmcColors } from './lmcColors';

export type OrchestrationState = 'dispatched' | 'done' | 'blocked' | 'failed' | 'accepted' | 'rejected';

/** States a task does not come back from; the row folds away. */
export const CLOSED_STATES: readonly OrchestrationState[] = ['done', 'accepted'];
export const isClosedState = (state: OrchestrationState) => CLOSED_STATES.includes(state);

/** One palette for a task's state wherever it is drawn: list pill, card pill, envelope status. */
export function orchestrationTone(state: OrchestrationState, theme: { dark: boolean; colors: { status: { error: string } } }): { bg: string; fg: string } {
    const colors = lmcColors(theme as any);
    switch (state) {
        // Done is the worker's word; accepted is the hub's — the same green,
        // filled darker so a reviewed row reads as settled.
        case 'done': return { bg: theme.dark ? '#173224' : '#E6F4EC', fg: theme.dark ? '#4FBF7E' : '#1D8A4D' };
        case 'accepted': return { bg: theme.dark ? '#1D8A4D' : '#1D8A4D', fg: '#FFFFFF' };
        case 'blocked': return { bg: colors.attentionSoft, fg: colors.attention };
        case 'failed': return { bg: colors.attentionSoft, fg: theme.colors.status.error };
        case 'rejected': return { bg: theme.colors.status.error, fg: '#FFFFFF' };
        default: return { bg: theme.dark ? '#17243A' : '#E8F0FD', fg: colors.brand };
    }
}

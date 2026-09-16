import type { Metadata } from '@/api/types';

/** Whether a refresh is somewhere between being asked for and having landed. */
export function isPendingState(state: Metadata['sessionConfigState']): boolean {
    return state === 'queued' || state === 'refreshing' || state === 'verifying';
}

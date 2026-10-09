import { z } from 'zod';
import type { Machine, Session } from '@/sync/storageTypes';

/** Mirrors MachineResourcesSchema in lmc-cli (daemonState.resources). */
export const MachineResourcesSchema = z.object({
    sampledAt: z.number(),
    memory: z.object({ totalBytes: z.number(), availableBytes: z.number() }),
    sessions: z.record(z.string(), z.object({ rssBytes: z.number(), processes: z.number() })),
    daemonRssBytes: z.number().optional(),
});
export type MachineResources = z.infer<typeof MachineResourcesSchema>;

/** The daemon's last sample, or null when the machine is offline (its sessions are gone with it) or never sampled. */
export function machineResourcesOf(machine: Machine | undefined | null): MachineResources | null {
    if (!machine || !machine.active) return null;
    const parsed = MachineResourcesSchema.safeParse(machine.daemonState?.resources);
    return parsed.success ? parsed.data : null;
}

const GB = 1024 ** 3, MB = 1024 ** 2;

/** "1.2 GB" / "820 MB": one decimal above a gigabyte, whole megabytes below. */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;
    return `${Math.round(bytes / MB)} MB`;
}

/** "9.8/16 GB": used and total share one unit so the pair reads as a fraction. */
export function formatMemoryUsage(usedBytes: number, totalBytes: number): string {
    const unit = totalBytes >= GB ? GB : MB;
    const label = unit === GB ? 'GB' : 'MB';
    const whole = (n: number) => (n / unit).toFixed(unit === GB && n < 10 * GB ? 1 : 0).replace(/\.0$/, '');
    return `${whole(Math.max(0, usedBytes))}/${whole(totalBytes)} ${label}`;
}

/** Share of machine memory in use above which the figure is drawn as a warning. */
export const MEMORY_TIGHT_RATIO = 0.85;

export interface SessionMemoryFigure {
    machineId: string;
    machineName: string;
    /** This session's process tree, or null when the daemon is not tracking it. */
    sessionBytes: number | null;
    usedBytes: number;
    totalBytes: number;
    tight: boolean;
}

/**
 * What the row under the composer shows: this session's memory next to its
 * machine's. Null when the machine has no live sample, so the row keeps its
 * other figures where they were.
 */
export function sessionMemoryFigure(session: Pick<Session, 'id' | 'metadata'> | null | undefined, machine: Machine | null | undefined): SessionMemoryFigure | null {
    const resources = machineResourcesOf(machine);
    if (!session || !machine || !resources || resources.memory.totalBytes <= 0) return null;
    const usedBytes = Math.max(0, resources.memory.totalBytes - resources.memory.availableBytes);
    return {
        machineId: machine.id,
        machineName: machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id.slice(0, 8),
        sessionBytes: resources.sessions[session.id]?.rssBytes ?? null,
        usedBytes,
        totalBytes: resources.memory.totalBytes,
        tight: usedBytes / resources.memory.totalBytes >= MEMORY_TIGHT_RATIO,
    };
}

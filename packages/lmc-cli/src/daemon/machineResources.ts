import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { MachineResources, SessionResourceUsage } from '@/api/types';

const execFileAsync = promisify(execFile);

export interface ProcessRecord { pid: number; ppid: number; rssBytes: number }
export interface ResourceRoot { sessionId: string; pid: number }
export interface MachineMemorySample { totalBytes: number; availableBytes: number }

/**
 * Memory the operating system reports as reclaimable without swapping. Node's
 * os.freemem() is only the free page count, which on macOS is a small fraction
 * of what is really available, so each platform reads its own source.
 */
export async function sampleMachineMemory(platform = process.platform): Promise<MachineMemorySample> {
    const totalBytes = os.totalmem();
    if (platform === 'darwin') {
        const { stdout } = await execFileAsync('vm_stat', [], { timeout: 5000 });
        return { totalBytes, availableBytes: Math.min(totalBytes, parseVmStatAvailable(stdout)) };
    }
    if (platform === 'linux') {
        const { readFile } = await import('node:fs/promises');
        const meminfo = await readFile('/proc/meminfo', 'utf8');
        const available = /MemAvailable:\s+(\d+) kB/.exec(meminfo);
        if (available) return { totalBytes, availableBytes: Math.min(totalBytes, Number(available[1]) * 1024) };
    }
    return { totalBytes, availableBytes: os.freemem() };
}

export function parseVmStatAvailable(output: string): number {
    const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1] ?? 4096);
    const pages = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)\\.`, 'm').exec(output)?.[1] ?? 0);
    return (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * pageSize;
}

/** Every process on the machine with its parent and resident set, for tree sums. */
export async function sampleProcessTable(platform = process.platform): Promise<ProcessRecord[]> {
    if (platform === 'win32') {
        const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Csv -NoTypeInformation'],
        { timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        return parseWindowsProcessCsv(stdout);
    }
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss='], { timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
    return parsePsTable(stdout);
}

export function parsePsTable(output: string): ProcessRecord[] {
    const records: ProcessRecord[] = [];
    for (const line of output.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
        if (m) records.push({ pid: Number(m[1]), ppid: Number(m[2]), rssBytes: Number(m[3]) * 1024 });
    }
    return records;
}

export function parseWindowsProcessCsv(output: string): ProcessRecord[] {
    const records: ProcessRecord[] = [];
    for (const line of output.split(/\r?\n/).slice(1)) {
        const m = /^"?(\d+)"?,"?(\d+)"?,"?(\d+)"?\s*$/.exec(line.trim());
        if (m) records.push({ pid: Number(m[1]), ppid: Number(m[2]), rssBytes: Number(m[3]) });
    }
    return records;
}

/**
 * Sum the resident set of each root and everything under it. A session is its
 * lmc runtime, the engine it drives and the tools that engine spawns, so the
 * whole tree is the honest number; shared pages are counted once per process,
 * which overstates a little next to Activity Monitor.
 */
export function aggregateProcessTrees(table: ProcessRecord[], roots: ResourceRoot[]): Record<string, SessionResourceUsage> {
    const children = new Map<number, ProcessRecord[]>();
    const byPid = new Map<number, ProcessRecord>();
    for (const record of table) {
        byPid.set(record.pid, record);
        const list = children.get(record.ppid) ?? [];
        list.push(record);
        children.set(record.ppid, list);
    }
    const result: Record<string, SessionResourceUsage> = {};
    for (const root of roots) {
        if (!byPid.has(root.pid)) continue;
        let rssBytes = 0, processes = 0;
        const seen = new Set<number>();
        const stack = [root.pid];
        while (stack.length) {
            const pid = stack.pop()!;
            if (seen.has(pid)) continue;
            seen.add(pid);
            const record = byPid.get(pid);
            if (!record) continue;
            rssBytes += record.rssBytes; processes += 1;
            for (const child of children.get(pid) ?? []) stack.push(child.pid);
        }
        result[root.sessionId] = { rssBytes, processes };
    }
    return result;
}

const CHANGE_RATIO = 0.05;
const CHANGE_BYTES = 50 * 1024 * 1024;
const changed = (a: number | undefined, b: number) => a === undefined || Math.abs(a - b) > Math.min(CHANGE_BYTES, Math.max(1, Math.abs(a)) * CHANGE_RATIO);

/** True when a new sample differs enough from the published one to be worth a shared-state write. */
export function resourcesChanged(previous: MachineResources | undefined, next: MachineResources): boolean {
    if (!previous) return true;
    if (changed(previous.memory.availableBytes, next.memory.availableBytes) || previous.memory.totalBytes !== next.memory.totalBytes) return true;
    if (changed(previous.daemonRssBytes, next.daemonRssBytes ?? 0)) return true;
    const keys = new Set([...Object.keys(previous.sessions), ...Object.keys(next.sessions)]);
    for (const key of keys) {
        const a = previous.sessions[key], b = next.sessions[key];
        if (!a || !b) return true;
        if (changed(a.rssBytes, b.rssBytes)) return true;
    }
    return false;
}

/**
 * Windows has no cheap process table: each sample starts PowerShell, about
 * 1.5s on the work machine (measured 2026-10-08), so it samples a third as
 * often. ps on macOS and Linux costs a few milliseconds.
 */
export function defaultSampleIntervalMs(platform: NodeJS.Platform = process.platform): number {
    return platform === 'win32' ? 60_000 : 20_000;
}

export interface MachineResourcesOptions {
    publish: (resources: MachineResources) => Promise<unknown>;
    roots: () => ResourceRoot[];
    sampleMemory?: () => Promise<MachineMemorySample>;
    sampleProcesses?: () => Promise<ProcessRecord[]>;
    intervalMs?: number;
    daemonPid?: number;
}

/**
 * Publish machine memory and per-session resident sets into the daemon state,
 * every 20s (60s on Windows). Sampling never holds startup; a failed sample is skipped and retried on the
 * next tick. Unchanged numbers are not rewritten.
 */
export function startMachineResources(options: MachineResourcesOptions) {
    const { publish, roots, sampleMemory = sampleMachineMemory, sampleProcesses = sampleProcessTable, intervalMs = defaultSampleIntervalMs(), daemonPid = process.pid } = options;
    let stopped = false, running = false;
    let published: MachineResources | undefined;
    const refresh = async () => {
        if (stopped || running) return;
        running = true;
        try {
            const [memory, table] = await Promise.all([sampleMemory(), sampleProcesses()]);
            // Sessions are children of the daemon, so the daemon is reported as
            // its own process only, never as a tree.
            const sessions = aggregateProcessTrees(table, roots());
            const daemonRssBytes = table.find(record => record.pid === daemonPid)?.rssBytes;
            const next: MachineResources = { sampledAt: Date.now(), memory, sessions, daemonRssBytes };
            if (stopped || !resourcesChanged(published, next)) return;
            await publish(next);
            published = next;
        } catch { /* Sampling degrades silently; the next tick retries. */ }
        finally { running = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, intervalMs);
    timer.unref?.();
    return () => { stopped = true; clearInterval(timer); };
}

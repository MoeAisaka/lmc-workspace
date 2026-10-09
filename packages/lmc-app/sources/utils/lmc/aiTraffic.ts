import { z } from 'zod';
import type { Machine } from '@/sync/storageTypes';
import type { UsagePeriod } from '@/sync/usageAnalytics';

/** Mirrors AiTrafficSchema in lmc-cli (daemonState.aiTraffic): bytes per provider per local day. */
const BytesSchema = z.object({ up: z.number(), down: z.number() });
const DaySchema = z.object({ claude: BytesSchema, openai: BytesSchema });
export const AiTrafficSchema = z.object({ updatedAt: z.number(), days: z.record(z.string(), DaySchema) });
export type AiTraffic = z.infer<typeof AiTrafficSchema>;
export type TrafficBytes = { up: number; down: number };
export type ProviderTraffic = { claude: TrafficBytes; openai: TrafficBytes };

/** A ledger is history: it is read from a machine that is offline now as well. */
export function aiTrafficOf(machine: Machine | undefined | null): AiTraffic | null {
    const parsed = AiTrafficSchema.safeParse(machine?.daemonState?.aiTraffic);
    return parsed.success ? parsed.data : null;
}

const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** The local days a dashboard period covers, oldest first, today last. */
export function trafficDays(period: UsagePeriod, now: number): string[] {
    const count = period === 'today' ? 1 : period === '7days' ? 7 : 30;
    return Array.from({ length: count }, (_, index) => { const d = new Date(now); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - (count - 1 - index)); return dayKey(d); });
}

const zero = (): ProviderTraffic => ({ claude: { up: 0, down: 0 }, openai: { up: 0, down: 0 } });
const addInto = (into: ProviderTraffic, day: ProviderTraffic) => { for (const p of ['claude', 'openai'] as const) { into[p].up += day[p].up; into[p].down += day[p].down; } };
export const trafficSum = (t: TrafficBytes) => t.up + t.down;
export const providerSum = (t: ProviderTraffic) => trafficSum(t.claude) + trafficSum(t.openai);

export interface AiTrafficSummary {
    total: ProviderTraffic;
    machines: Array<{ id: string; name: string; traffic: ProviderTraffic }>;
    /** Null until at least one machine has a whole day behind it. */
    projection: { monthlyBytes: number; dailyBytes: number; days: number } | null;
    /** Whether any machine reports a ledger at all, whatever the period holds. */
    reporting: boolean;
}

/**
 * Totals for the period, per machine, and a month projected from recent whole days.
 *
 * Today is still running and a machine's first recorded day began partway
 * through, so neither is a whole day; both are left out of the average. Each
 * machine is averaged over its own whole days from the last seven, and the
 * machines are added.
 */
export function summarizeAiTraffic(machines: Array<{ id: string; name: string; traffic: AiTraffic | null }>, period: UsagePeriod, now: number, machineId = ''): AiTrafficSummary {
    const days = trafficDays(period, now), today = trafficDays('today', now)[0], week = trafficDays('7days', now).slice(0, -1);
    const total = zero(), rows: AiTrafficSummary['machines'] = [];
    let dailyBytes = 0, fewest = Infinity, reporting = false;
    for (const machine of machines) {
        if (!machine.traffic || (machineId && machine.id !== machineId)) continue;
        reporting = true;
        const traffic = zero();
        for (const day of days) { const value = machine.traffic.days[day]; if (value) addInto(traffic, value); }
        if (providerSum(traffic) > 0) { rows.push({ id: machine.id, name: machine.name, traffic }); addInto(total, traffic); }
        const recorded = Object.keys(machine.traffic.days).sort();
        // Thirty-five days are published; a full window means the oldest one is not the day recording began.
        const first = recorded.length >= 35 ? '' : recorded[0];
        const whole = week.filter(day => day !== today && day !== first && machine.traffic!.days[day]);
        if (!whole.length) continue;
        dailyBytes += whole.reduce((sum, day) => sum + providerSum(machine.traffic!.days[day]), 0) / whole.length;
        fewest = Math.min(fewest, whole.length);
    }
    rows.sort((a, b) => providerSum(b.traffic) - providerSum(a.traffic));
    return { total, machines: rows, reporting, projection: Number.isFinite(fewest) ? { monthlyBytes: dailyBytes * 30, dailyBytes, days: fewest } : null };
}

const GB = 1024 ** 3, MB = 1024 ** 2;
/** "4.62 GB", "440 MB", "0 MB": a plan is bought in gigabytes, so those get two decimals. */
export function formatTraffic(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 100 * GB ? 0 : bytes >= 10 * GB ? 1 : 2)} GB`;
    return `${bytes >= MB ? Math.round(bytes / MB) : (bytes / MB).toFixed(1)} MB`;
}

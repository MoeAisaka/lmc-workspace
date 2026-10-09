import type { AgentState } from '@/api/types';
import type { EngineDiagnostics, NoProgress, SystemPromptDiagnostic, ToolProcessObservation } from 'lmc-wire';
import { detectSystemPrompt, observeToolProcesses, systemPromptHint } from './systemDiagnostics';

export const DEFAULT_NO_PROGRESS_MS = 5 * 60_000;
export function noProgressThreshold(value = process.env.LMC_NO_PROGRESS_TIMEOUT_MS): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : DEFAULT_NO_PROGRESS_MS;
}

export type DiagnosticClient = {
    updateAgentState: (handler: (state: AgentState) => AgentState) => unknown;
    sendSessionEvent: (event: { type: 'message'; message: string }) => void;
    getMetadata: () => { host?: string } | null | undefined;
};
/** Keep diagnostics beside runtime: keepAlive replaces runtime's three fields. */
export function publishEngineDiagnostic<K extends keyof EngineDiagnostics>(client: DiagnosticClient, key: K, value: EngineDiagnostics[K]): void {
    try {
        const result = client.updateAgentState(state => ({ ...state, engineDiagnostics: { ...state.engineDiagnostics, [key]: value } }));
        void Promise.resolve(result).catch(() => {});
    } catch { /* Diagnostics must not break delivery. */ }
}

export function noProgressMessage(value: NoProgress, host?: string): string {
    const minutes = Math.max(0, Math.floor((value.observedAt - value.since) / 60_000));
    const elapsed = minutes ? `${minutes} 分钟` : '不足 1 分钟';
    const tools = value.toolProcesses.status === 'alive'
        ? `观察到 ${value.toolProcesses.liveCount} 个存活的工具或辅助子进程，长时间运行的工具可能仍在执行。`
        : value.toolProcesses.status === 'none' ? '未观察到存活的工具子进程。' : '工具子进程状态未知。';
    return `无进展 ${elapsed}：引擎输出和运行活动均未更新。${tools}${systemPromptHint(value.systemPrompt, host)}`;
}

/** Observations only: never starts a turn, resends input, or stops an engine. */
export class NoProgressMonitor {
    private busy = false;
    private since: number;
    private generation = 0;
    private noticed = false;
    private inFlight = false;
    private observedAt = -Infinity;
    private stopped = false;
    constructor(private readonly ports: {
        now?: () => number;
        thresholdMs: number;
        systemPrompt: () => Promise<SystemPromptDiagnostic>;
        toolProcesses: () => Promise<ToolProcessObservation>;
        publish: (value: NoProgress | undefined, notify: boolean) => void;
    }) { this.since = this.now(); }
    private now() { return (this.ports.now ?? Date.now)(); }
    setBusy(busy: boolean) {
        if (this.stopped || this.busy === busy) return;
        this.busy = busy;
        this.progress();
    }
    progress() {
        if (this.stopped) return;
        this.since = this.now(); this.generation++;
        if (this.noticed) { this.noticed = false; this.ports.publish(undefined, false); }
    }
    async check() {
        if (this.stopped || !this.busy || this.inFlight || this.now() - this.since < this.ports.thresholdMs) return;
        if (this.noticed && this.now() - this.observedAt < 30_000) return;
        this.inFlight = true;
        const generation = this.generation;
        try {
            const values = await Promise.allSettled([this.ports.systemPrompt(), this.ports.toolProcesses()]);
            if (this.stopped || !this.busy || generation !== this.generation) return;
            this.observedAt = this.now();
            const value: NoProgress = { since: this.since, observedAt: this.observedAt, thresholdMs: this.ports.thresholdMs,
                systemPrompt: values[0].status === 'fulfilled' ? values[0].value : { status: 'unknown', checkedAt: this.observedAt, reason: 'failed' },
                toolProcesses: values[1].status === 'fulfilled' ? values[1].value : { status: 'unknown', checkedAt: this.observedAt } };
            const notify = !this.noticed;
            this.noticed = true;
            this.ports.publish(value, notify);
        } finally { this.inFlight = false; }
    }
    stop() { this.progress(); this.stopped = true; }
}

export function startSessionProgressMonitor(client: DiagnosticClient, pid: () => number | undefined) {
    publishEngineDiagnostic(client, 'noProgress', undefined);
    const thresholdMs = noProgressThreshold();
    const monitor = new NoProgressMonitor({ thresholdMs,
        systemPrompt: () => detectSystemPrompt(), toolProcesses: () => observeToolProcesses(pid()),
        publish: (value, notify) => {
            publishEngineDiagnostic(client, 'noProgress', value);
            // A quiet long-running tool is ordinary; the banner carries that state.
            // Only a pending system prompt is something a person must act on.
            if (value && notify && value.systemPrompt.status === 'detected') client.sendSessionEvent({ type: 'message', message: noProgressMessage(value, client.getMetadata()?.host) });
        },
    });
    const timer = setInterval(() => { void monitor.check().catch(() => {}); }, Math.min(15_000, Math.max(1000, thresholdMs / 5)));
    timer.unref?.();
    return { setBusy: (busy: boolean) => monitor.setBusy(busy), progress: () => monitor.progress(),
        stop: () => { clearInterval(timer); monitor.stop(); } };
}

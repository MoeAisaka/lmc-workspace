import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { UsageRecordSchema, UsageTokensSchema, type UsageRecord, type UsageTokens, usageTotal } from 'lmc-wire';

const n = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type Origin = Pick<UsageRecord, 'sessionId' | 'machineId'>;

export function claudeUsageRecord(body: any, origin: Origin): UsageRecord | null {
    const m = body?.type === 'assistant' ? body.message : null;
    if (!m?.usage || typeof m.id !== 'string') return null;
    const u = m.usage;
    // The provider message id joins streaming fragments and transcript replays.
    return { ...origin, key: `u2:claude:${hash(m.id)}`, engine: 'claude', model: typeof m.model === 'string' ? m.model : null,
        occurredAt: Number.isFinite(Date.parse(body.timestamp)) ? Date.parse(body.timestamp) : Date.now(),
        tokens: { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) } };
}

function codexTokens(raw: any): UsageTokens | null {
    if (!raw || typeof raw !== 'object') return null;
    const input = raw.inputTokens ?? raw.input_tokens;
    const output = raw.outputTokens ?? raw.output_tokens;
    if (typeof input !== 'number' || typeof output !== 'number') return null;
    const cacheRead = Math.min(n(input), n(raw.cachedInputTokens ?? raw.cached_input_tokens));
    return { input: n(input) - cacheRead, output: n(output), cacheRead, cacheWrite: 0 };
}

/** Persisted with the outbox, so a resume/repeated notification cannot recharge old work. */
export class UsageCollector {
    readonly checkpoints = new Map<string, { tokens: UsageTokens; epoch: number }>();
    codex(message: any, origin: Origin, model: string | null, activeTurn = true): UsageRecord | null {
        const thread = message.threadId ?? message.thread_id;
        const total = codexTokens(message.total ?? message.info?.total_token_usage);
        const last = codexTokens(message.last ?? message.info?.last_token_usage);
        if (message.type !== 'token_count' || typeof thread !== 'string' || !total || !last) return null;
        const stream = hash(thread);
        const checkpoint = this.checkpoints.get(stream);
        const previous = checkpoint?.tokens;
        if (previous && usageTotal(total) === usageTotal(previous)) return null;
        if ((!previous && !activeTurn) || (previous && usageTotal(total) < usageTotal(previous))) {
            // Idle resume notifications and counter resets establish a baseline;
            // they do not charge historical tokens to the time of reconnection.
            this.checkpoints.set(stream, { tokens: total, epoch: checkpoint ? checkpoint.epoch + 1 : 0 });
            return null;
        }
        // First observation excludes the old thread's pre-LMC/unrecorded history.
        // Subsequent deltas include all intervening updates, not only `last`.
        const delta = previous ? {
            input: Math.max(0, total.input + total.cacheRead - previous.input - previous.cacheRead),
            output: Math.max(0, total.output - previous.output),
            cacheRead: Math.max(0, total.cacheRead - previous.cacheRead), cacheWrite: 0,
        } : { ...last, input: last.input + last.cacheRead };
        delta.cacheRead = Math.min(delta.input, delta.cacheRead);
        delta.input -= delta.cacheRead;
        const epoch = checkpoint?.epoch ?? 0;
        this.checkpoints.set(stream, { tokens: total, epoch });
        if (!usageTotal(delta)) return null;
        return { ...origin, key: `u2:codex:${stream}:${epoch}:${usageTotal(total)}`, engine: 'codex', model,
            occurredAt: Date.now(), tokens: delta };
    }
}

/** Stats only; no prompts, credentials or provider transcript files are stored here. */
export class UsageOutbox {
    readonly collector = new UsageCollector();
    private pending = new Map<string, UsageRecord>();
    private chain = Promise.resolve();
    private ready: Promise<void>;
    private sending: Promise<void> | null = null;
    constructor(private path: string, private send: (record: UsageRecord) => Promise<boolean>, private warn: () => void) {
        this.ready = readFile(path, 'utf8').then(text => {
            const data = JSON.parse(text);
            for (const record of data.pending ?? []) {
                const parsed = UsageRecordSchema.safeParse(record);
                if (parsed.success) this.pending.set(parsed.data.key, parsed.data);
            }
            for (const [key, checkpoint] of data.checkpoints ?? []) {
                const tokens = UsageTokensSchema.safeParse(checkpoint?.tokens);
                if (typeof key === 'string' && tokens.success && Number.isSafeInteger(checkpoint.epoch) && checkpoint.epoch >= 0)
                    this.collector.checkpoints.set(key, { tokens: tokens.data, epoch: checkpoint.epoch });
            }
        }).catch(error => { if (error.code !== 'ENOENT') this.warn(); });
    }
    private persist() {
        const content = JSON.stringify({ pending: [...this.pending.values()], checkpoints: [...this.collector.checkpoints] });
        return mkdir(dirname(this.path), { recursive: true }).then(() => writeFile(`${this.path}.tmp`, content, { mode: 0o600 }))
            .then(() => rename(`${this.path}.tmp`, this.path));
    }
    enqueue(make: (collector: UsageCollector) => UsageRecord | null) {
        this.chain = this.chain.then(async () => {
            await this.ready;
            const record = make(this.collector);
            if (record) this.pending.set(record.key, record);
            await this.persist();
        }).catch(this.warn);
        void this.chain.then(() => this.flush());
    }
    flush(): Promise<void> {
        if (!this.sending) this.sending = this.drain().finally(() => { this.sending = null; });
        return this.sending;
    }
    private async drain() {
        await this.ready; await this.chain;
        for (const record of [...this.pending.values()]) {
                if (!await this.send(record)) break;
                // A newer Claude fragment may have arrived during the acknowledgement.
                this.chain = this.chain.then(async () => {
                    if (this.pending.get(record.key) === record) this.pending.delete(record.key);
                    await this.persist();
                }).catch(this.warn);
                await this.chain;
        }
    }
}

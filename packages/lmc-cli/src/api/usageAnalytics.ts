import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
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

/** Native agy step usage: input is uncached; output includes thinking.
 * Native total excludes cache reads, while the LMC total includes all token work.
 * Never feed the cumulative result.usage into this per-generation collector. */
export function agyUsageRecord(raw: any, origin: Origin, turnId: string, model: string | null, startedAt?: number): UsageRecord | null {
    if (!raw || ![raw.input_tokens, raw.output_tokens, raw.total_tokens, raw.cache_read_tokens ?? 0]
        .every(v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)) return null;
    const input = raw.input_tokens, output = raw.output_tokens, cacheRead = raw.cache_read_tokens ?? 0;
    const nativeTotal = input + output;
    const allWork = raw.total_tokens + cacheRead;
    if (!Number.isSafeInteger(nativeTotal) || raw.total_tokens !== nativeTotal || !Number.isSafeInteger(allWork) || allWork <= 0) return null;
    const validStartedAt = typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0 ? startedAt : undefined;
    return { ...origin, key: `u2:agy:${hash(turnId)}`, engine: 'agy', model,
        ...(validStartedAt !== undefined ? { startedAt: validStartedAt } : {}),
        occurredAt: Date.now(), tokens: { input, output, cacheRead, cacheWrite: 0 } };
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

export interface UsageOutboxFs {
    mkdir: (path: string, options?: { recursive?: boolean; mode?: number }) => Promise<unknown>;
    readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
    writeAtomicFile: (tmpPath: string, content: string) => Promise<void>;
    rename: (oldPath: string, newPath: string) => Promise<void>;
    unlink: (path: string) => Promise<void>;
}

const DEFAULT_USAGE_OUTBOX_FS: UsageOutboxFs = {
    mkdir: (p, o) => mkdir(p, o),
    readFile: (p, enc) => readFile(p, enc),
    writeAtomicFile: async (tmpPath, content) => {
        const fh = await open(tmpPath, 'wx', 0o600);
        try {
            await fh.writeFile(content, { encoding: 'utf8' });
            await fh.chmod(0o600);
            await fh.sync();
        } finally {
            await fh.close();
        }
    },
    rename: (oldP, newP) => rename(oldP, newP),
    unlink: (p) => unlink(p),
};

/** Stats only; no prompts, credentials or provider transcript files are stored here. */
export class UsageOutbox {
    readonly collector = new UsageCollector();
    private pending = new Map<string, UsageRecord>();
    private unpersistedKeys = new Set<string>();
    private lastPersistError: Error | null = null;
    private chain = Promise.resolve();
    private ready: Promise<void>;
    private sending: Promise<void> | null = null;
    private dirtyDuringSend = false;
    private readonly fsOps: UsageOutboxFs;
    constructor(
        private path: string,
        private send: (record: UsageRecord) => Promise<boolean>,
        private warn: () => void,
        fsOps?: Partial<UsageOutboxFs>,
    ) {
        this.fsOps = fsOps ? { ...DEFAULT_USAGE_OUTBOX_FS, ...fsOps } : DEFAULT_USAGE_OUTBOX_FS;
        this.ready = this.fsOps.readFile(path, 'utf8').then(text => {
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
        }).catch(error => { if (error?.code !== 'ENOENT') this.warn(); });
    }
    private async persist() {
        const content = JSON.stringify({ pending: [...this.pending.values()], checkpoints: [...this.collector.checkpoints] });
        const tmpPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
        await this.fsOps.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        try {
            await this.fsOps.writeAtomicFile(tmpPath, content);
            await this.fsOps.rename(tmpPath, this.path);
        } catch (err) {
            await this.fsOps.unlink(tmpPath).catch(() => {});
            throw err;
        }
    }
    enqueue(make: (collector: UsageCollector) => UsageRecord | null) {
        this.dirtyDuringSend = true;
        this.chain = this.chain.then(async () => {
            await this.ready;
            const record = make(this.collector);
            if (record) {
                this.pending.set(record.key, record);
                this.unpersistedKeys.add(record.key);
                this.dirtyDuringSend = true;
            }
            const snapshotKeys = [...this.pending.keys()];
            try {
                await this.persist();
                this.lastPersistError = null;
                for (const k of snapshotKeys) {
                    if (this.pending.has(k)) this.unpersistedKeys.delete(k);
                }
            } catch (err) {
                this.lastPersistError = err instanceof Error ? err : new Error(String(err));
                this.warn();
            }
        }).catch(this.warn);
        void this.chain.then(() => this.flush());
    }
    /**
     * Confirm that every enqueued usage record has either been acknowledged by the
     * server (`send(record) === true`) or durably synced to the local outbox file.
     * Rejects if any pending record remains only in memory.
     */
    async ensureDurable(): Promise<void> {
        await this.ready;
        await this.chain;
        if (this.pending.size > 0) {
            await this.flush();
        }
        await this.chain;
        for (const k of [...this.unpersistedKeys]) {
            if (!this.pending.has(k)) {
                this.unpersistedKeys.delete(k);
            }
        }
        if (this.unpersistedKeys.size === 0) return;

        let persistErr: unknown = null;
        const retryPersist = this.chain.then(async () => {
            const snapshotKeys = [...this.pending.keys()];
            if (snapshotKeys.length === 0) {
                this.unpersistedKeys.clear();
                return;
            }
            await this.persist();
            this.lastPersistError = null;
            for (const k of snapshotKeys) {
                if (this.pending.has(k)) this.unpersistedKeys.delete(k);
            }
        });
        this.chain = retryPersist.catch(() => { this.warn(); });
        try {
            await retryPersist;
        } catch (err) {
            persistErr = err;
        }
        if (this.unpersistedKeys.size > 0) {
            throw (
                persistErr ??
                this.lastPersistError ??
                new Error('Usage records were neither acknowledged by server nor durably persisted to outbox')
            );
        }
    }
    flush(): Promise<void> {
        this.dirtyDuringSend = true;
        if (!this.sending) this.sending = this.drain().finally(() => { this.sending = null; });
        return this.sending;
    }
    private async drain() {
        while (this.dirtyDuringSend) {
            this.dirtyDuringSend = false;
            await this.ready; await this.chain;
            let sendFailed = false;
            for (const record of [...this.pending.values()]) {
                if (this.pending.get(record.key) !== record) continue;
                if (!await this.send(record)) { sendFailed = true; break; }
                this.unpersistedKeys.delete(record.key);
                // A newer Claude fragment or concurrent enqueue may have arrived during the acknowledgement.
                this.chain = this.chain.then(async () => {
                    if (this.pending.get(record.key) === record) this.pending.delete(record.key);
                    await this.persist();
                }).catch(this.warn);
                await this.chain;
            }
            if (sendFailed) {
                this.dirtyDuringSend = false;
                break;
            }
        }
    }
}

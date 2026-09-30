import { randomUUID } from 'node:crypto';

export type NativeInput = { type: 'text'; text: string } | { type: 'key'; key: string } | { type: 'choice'; choice: number };
export type NativeInputRequest = { clientId: string; epoch: string; revision: number; requestId: string; input: NativeInput };
export type NativeScreen = { lines: string[]; cursor: { x: number; y: number }; composer: boolean };

/** Screen-reader mode keeps the empty composer visible during Stop hooks. */
export function nativeComposerReady(lines: string[], cursor: { x: number; y: number }): boolean {
    if (!/^\$\s*$/.test(lines[cursor.y] ?? '')) return false;
    return !lines.slice(Math.max(0, cursor.y - 5), cursor.y).some(line => /esc to interrupt|ctrl[+-]c to interrupt/i.test(line));
}

export function encodeNativeInput(input: NativeInput): string {
    if (input?.type === 'text') {
        if (typeof input.text !== 'string' || !input.text.length || input.text.length > 16384 || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(input.text)) throw new Error('Invalid terminal text');
        return '\x1b[200~' + input.text + '\x1b[201~';
    }
    if (input?.type === 'choice' && Number.isInteger(input.choice) && input.choice >= 1 && input.choice <= 9) return `${input.choice}\r`;
    if (input?.type === 'key') {
        const keys: Record<string, string> = { y: 'y', n: 'n', enter: '\x1b[13;1u', escape: '\x1b', up: '\x1b[A', down: '\x1b[B', tab: '\t' };
        if (Object.hasOwn(keys, input.key)) return keys[input.key];
    }
    throw new Error('Unsupported terminal input');
}

/** One writer, bounded replay and explicit versioned input. A lost RPC reply
 * can be retried with the same request ID without pressing a key twice. */
export class NativeTerminalRelay {
    readonly epoch = randomUUID();
    revision = 0;
    private owner: { id: string; until: number } | null = null;
    private receipts = new Map<string, { fingerprint: string; revision: number }>();
    private closed = false;
    constructor(private readonly port: { write: (data: string) => void; screen: () => NativeScreen; now?: () => number }) {}
    private now() { return this.port.now?.() ?? Date.now(); }
    outputChanged() { this.revision++; }
    claim(clientId: string) {
        if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(clientId)) throw new Error('Invalid terminal client');
        if (this.closed) throw new Error('Native terminal exited');
        if (this.owner && this.owner.id !== clientId && this.owner.until > this.now()) throw new Error('Native terminal is controlled on another screen');
        this.owner = { id: clientId, until: this.now() + 15000 };
        return this.snapshot(clientId);
    }
    release(clientId: string) { if (this.owner?.id === clientId) this.owner = null; }
    snapshot(clientId?: string) {
        const ownsInput = !!this.owner && this.owner.id === clientId && this.owner.until > this.now() && !this.closed;
        if (ownsInput) this.owner!.until = this.now() + 15000;
        return { epoch: this.epoch, revision: this.revision, ownsInput, exited: this.closed, ...this.port.screen() };
    }
    assertCurrent(request: Pick<NativeInputRequest, 'epoch' | 'revision' | 'clientId'>) {
        if (request.epoch !== this.epoch || this.closed) throw new Error('Native terminal changed; reconnect before responding');
        if (this.owner?.id !== request.clientId || this.owner.until <= this.now()) throw new Error('Native terminal control expired');
        if (request.revision !== this.revision) throw new Error('Terminal changed; read the latest screen before responding');
    }
    input(request: NativeInputRequest) {
        if (!request || request.epoch !== this.epoch || this.closed) throw new Error('Native terminal changed; reconnect before responding');
        if (this.owner?.id !== request.clientId || this.owner.until <= this.now()) throw new Error('Native terminal control expired');
        if (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(request.requestId)) throw new Error('Invalid terminal request');
        const key = `${request.clientId}:${request.requestId}`;
        const fingerprint = JSON.stringify([request.revision, request.input]);
        const previous = this.receipts.get(key);
        if (previous) {
            if (previous.fingerprint !== fingerprint) throw new Error('Terminal request ID was reused');
            return { revision: previous.revision, repeated: true };
        }
        if (request.revision !== this.revision) throw new Error('Terminal changed; read the latest screen before responding');
        const data = encodeNativeInput(request.input);
        this.port.write(data);
        const revision = ++this.revision;
        this.receipts.set(key, { fingerprint, revision });
        if (this.receipts.size > 64) this.receipts.delete(this.receipts.keys().next().value!);
        return { revision, repeated: false };
    }
    close() { this.closed = true; this.owner = null; this.revision++; }
}

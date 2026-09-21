import { ResourceReview } from '@/modules/common/resourceReview';
import { searchSessionResources } from '@/modules/common/resourceSearch';
import { join as joinResourcePath } from 'node:path';
import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, FileEventMessage, FileEventMessageSchema, Metadata, ServerToClientEvents, Session, Update, UserMessage, UserMessageSchema, Usage } from './types'
import { decodeBase64, decryptBlob, decrypt, encodeBase64, encrypt, encryptBlob } from './encryption';
import { backoff, delay } from '@/utils/time';
import { configuration } from '@/configuration';
import { RawJSONLines } from '@/claude/types';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { deriveKey } from '@/utils/deriveKey';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers';
import { calculateCost } from '@/utils/pricing';
import { shouldReconnect } from '@/utils/lidState';
import { createEnvelope, type CreateEnvelopeOptions, type SessionEnvelope, type SessionTurnEndStatus } from 'lmc-wire';
import {
    closeClaudeTurnWithStatus,
    mapClaudeLogMessageToSessionEnvelopes,
    type ClaudeSessionProtocolState,
} from '@/claude/utils/sessionProtocolMapper';
import { InvalidateSync } from '@/utils/sync';
import axios from 'axios';

/**
 * ACP (Agent Communication Protocol) message data types.
 * This is the unified format for all agent messages - CLI adapts each provider's format to ACP.
 */
export type ACPMessageData =
    // Core message types
    | { type: 'message'; message: string }
    | { type: 'reasoning'; message: string }
    | { type: 'thinking'; text: string }
    // Tool interactions
    | { type: 'tool-call'; callId: string; name: string; input: unknown; id: string }
    | { type: 'tool-result'; callId: string; output: unknown; id: string; isError?: boolean }
    // File operations
    | { type: 'file-edit'; description: string; filePath: string; diff?: string; oldContent?: string; newContent?: string; id: string }
    // Terminal/command output
    | { type: 'terminal-output'; data: string; callId: string }
    // Task lifecycle events
    | { type: 'task_started'; id: string }
    | { type: 'task_complete'; id: string }
    | { type: 'turn_aborted'; id: string }
    // Permissions
    | { type: 'permission-request'; permissionId: string; toolName: string; description: string; options?: unknown }
    // Usage/metrics
    | { type: 'token_count';[key: string]: unknown };

export type ACPProvider = 'gemini' | 'codex' | 'claude' | 'opencode';

type V3SessionMessage = {
    id: string;
    seq: number;
    content: { t: 'encrypted'; c: string };
    localId: string | null;
    createdAt: number;
    updatedAt: number;
};

type V3GetSessionMessagesResponse = {
    messages: V3SessionMessage[];
    hasMore: boolean;
};

type V3PostSessionMessagesResponse = {
    messages: Array<{
        id: string;
        seq: number;
        localId: string | null;
        createdAt: number;
        updatedAt: number;
    }>;
};

type AttachmentUploadResult = {
    ref: string;
    uploadUrl: string;
    method?: 'PUT' | 'POST';
    formFields?: Record<string, string>;
};

export type LocalImageAttachment = {
    data: Uint8Array;
    mimeType: string;
    name: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function extensionForImageMime(mimeType: string): string {
    switch (mimeType.toLowerCase()) {
        case 'image/jpeg':
        case 'image/jpg':
            return 'jpg';
        case 'image/gif':
            return 'gif';
        case 'image/webp':
            return 'webp';
        case 'image/png':
        default:
            return 'png';
    }
}

function extractLocalTranscriptImageAttachments(body: RawJSONLines): LocalImageAttachment[] {
    if (body.type !== 'user' || body.isMeta || body.isSidechain) {
        return [];
    }

    const content = (body as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) {
        return [];
    }

    // Tool results are user-role messages from Claude's protocol, but they
    // represent agent tool lifecycle, not human multimodal input.
    if (content.some((block) => isRecord(block) && block.type === 'tool_result')) {
        return [];
    }

    const attachments: LocalImageAttachment[] = [];
    for (const block of content) {
        if (!isRecord(block) || block.type !== 'image') {
            continue;
        }
        const source = block.source;
        if (!isRecord(source) || source.type !== 'base64' || typeof source.data !== 'string') {
            continue;
        }

        const data = decodeBase64(source.data);
        if (data.length === 0) {
            continue;
        }

        const mimeType = typeof source.media_type === 'string' && source.media_type.startsWith('image/')
            ? source.media_type
            : 'image/png';
        const index = attachments.length + 1;
        attachments.push({
            data,
            mimeType,
            name: `claude-image-${index}.${extensionForImageMime(mimeType)}`,
        });
    }

    return attachments;
}

function escapeMultipartValue(value: string): string {
    return value.replaceAll('\r', '').replaceAll('\n', '').replaceAll('"', '%22');
}

function buildMultipartUploadBody(
    fields: Record<string, string> | undefined,
    data: Uint8Array,
): { body: Buffer; boundary: string } {
    const boundary = `----happy-cli-${randomUUID()}`;
    const chunks: Buffer[] = [];

    for (const [key, value] of Object.entries(fields ?? {})) {
        chunks.push(Buffer.from(
            `--${boundary}\r\n`
            + `Content-Disposition: form-data; name="${escapeMultipartValue(key)}"\r\n\r\n`
            + `${value}\r\n`,
            'utf8',
        ));
    }

    chunks.push(Buffer.from(
        `--${boundary}\r\n`
        + 'Content-Disposition: form-data; name="file"; filename="blob"\r\n'
        + 'Content-Type: application/octet-stream\r\n\r\n',
        'utf8',
    ));
    chunks.push(Buffer.from(data));
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));

    return {
        body: Buffer.concat(chunks),
        boundary,
    };
}

export class ApiSessionClient extends EventEmitter {
    private hubRequestHandler: ((id: string, tool: string, input: unknown) => Promise<boolean>) | null = null;
    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    private incomingDeliveries = new Set<Promise<void>>();

    async waitForIncomingDelivery(): Promise<void> {
        while (this.incomingDeliveries.size) await Promise.all([...this.incomingDeliveries]);
    }
    private pendingFileEvents: FileEventMessage[] = [];
    private pendingFileEventCallback: ((data: FileEventMessage) => void) | null = null;
    private blobKey: Uint8Array | null = null;
    /**
     * In-flight attachment download promises that belong to the *current*
     * (not-yet-drained) batch. Each promise resolves to the decoded blob (or
     * null on failure), so per-message ownership is intrinsic — there is no
     * shared push-array between batches that a late download could leak into.
     */
    private pendingDownloads: Promise<{ data: Uint8Array; mimeType: string; name: string } | null>[] = [];
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    private reconnectInterval: NodeJS.Timeout | null = null;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private resourceReview: ResourceReview;
    private closed = false;
    private persistedWorking: boolean | undefined;
    private desiredWorking: boolean | undefined;
    private runtimeWrite: Promise<void> | undefined;
    private ignoreArchiveSignal = false;
    private skipInitialMessages = false;
    private claudeSessionProtocolState: ClaudeSessionProtocolState = {
        currentTurnId: null,
        uuidToProviderSubagent: new Map<string, string>(),
        taskPromptToSubagents: new Map<string, string[]>(),
        providerSubagentToSessionSubagent: new Map<string, string>(),
        subagentTitles: new Map<string, string>(),
        bufferedSubagentMessages: new Map<string, RawJSONLines[]>(),
        hiddenParentToolCalls: new Set<string>(),
        startedSubagents: new Set<string>(),
        activeSubagents: new Set<string>(),
    };
    /**
     * How far this client has consumed the session's message log.
     *
     * A session has one seq counter and both sides draw from it, so this must
     * only ever move over messages actually routed. It used to also be advanced
     * by this client's own POST responses, which silently dropped inbound
     * messages: a prompt sent by the app at seq 1 was skipped whenever the CLI's
     * own startup event took seq 2 and its POST returned first, because the
     * cursor then sat at 2 and both the socket's contiguity check and the next
     * fetch's after_seq looked straight past seq 1.
     */
    private lastReceivedSeq = 0;
    private incomingPaused = false;
    private pendingOutbox: Array<{ content: string; localId: string }> = [];
    private readonly sendSync: InvalidateSync;
    private readonly receiveSync: InvalidateSync;

    constructor(token: string, session: Session) {
        super()
        this.token = token;
        this.sessionId = session.id;
        this.metadata = session.metadata;
        this.metadataVersion = session.metadataVersion;
        this.agentState = session.agentState;
        this.agentStateVersion = session.agentStateVersion;
        this.encryptionKey = session.encryptionKey;
        this.encryptionVariant = session.encryptionVariant;
        this.sendSync = new InvalidateSync(() => this.flushOutbox());
        this.receiveSync = new InvalidateSync(() => this.fetchMessages());

        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });
        registerCommonHandlers(this.rpcHandlerManager, this.metadata.path);
        this.resourceReview=new ResourceReview(joinResourcePath(configuration.lmcHomeDir,'resource-reviews',encodeURIComponent(this.sessionId)));
        const resourceRoot = this.metadata.path;
        this.rpcHandlerManager.registerHandler('resource-search', async (data: unknown) =>
            searchSessionResources(resourceRoot, scope => this.resourceReview.paths(scope), data));
        this.rpcHandlerManager.registerHandler('resource-review', async (data:{scope?:'all'|'turn'|'unseen';viewed?:number;before?:number})=>{
            if(data?.viewed!==undefined)await this.resourceReview.markViewed(data.viewed);
            return this.resourceReview.read(data?.scope==='turn'?'turn':data?.scope==='unseen'?'unseen':'all',data?.before);
        });

        //
        // Create socket
        //

        this.socket = io(configuration.serverUrl, {
            auth: {
                token: this.token,
                clientType: 'session-scoped' as const,
                sessionId: this.sessionId,
                lmcClient: `cli-coding-session/${configuration.currentCliVersion}`
            },
            path: '/v1/updates',
            reconnection: false,
            transports: ['websocket'],
            withCredentials: true,
            autoConnect: false
        });

        //
        // Handlers
        //

        this.socket.on('connect', () => {
            if (this.closed) { this.socket.close(); return; }
            logger.debug('Socket connected successfully');
            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }
            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = null;
            }
            this.rpcHandlerManager.onSocketConnect(this.socket);
            this.receiveSync.invalidate();
        })

        // Set up global RPC request handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data));
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug(`[API] Socket disconnected: ${reason}`);
            this.rpcHandlerManager.onSocketDisconnect();
            this.startSmartReconnect();
        })

        this.socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', error);
            this.rpcHandlerManager.onSocketDisconnect();
            this.startSmartReconnect();
        })

        // Server events
        this.socket.on('update', (data: Update) => {
            try {
                logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', data);

                if (!data.body) {
                    logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                    return;
                }

                if (data.body.t === 'new-message') {
                    if (this.incomingPaused) return;
                    const messageSeq = data.body.message?.seq;
                    if (typeof messageSeq !== 'number' || messageSeq !== this.lastReceivedSeq + 1 || data.body.message.content.t !== 'encrypted') {
                        this.receiveSync.invalidate();
                        return;
                    }
                    const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.message.content.c));
                    logger.debug('[SOCKET] [UPDATE] Decrypted message', {
                        role: typeof (body as { role?: unknown })?.role === 'string'
                            ? (body as { role: string }).role
                            : 'unknown',
                        contentType: typeof (body as { content?: { type?: unknown } })?.content?.type === 'string'
                            ? (body as { content: { type: string } }).content.type
                            : 'unknown',
                    });
                    this.lastReceivedSeq = messageSeq;
                    this.routeIncomingMessage(body);
                } else if (data.body.t === 'update-session') {
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        this.applyMetadata(decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.metadata.value)));
                        this.metadataVersion = data.body.metadata.version;
                        // Check if session was archived from web/mobile
                        const meta = this.metadata as any;
                        if (meta?.lifecycleState === 'archiveRequested' || meta?.lifecycleState === 'archived') {
                            if (this.ignoreArchiveSignal) {
                                logger.debug(`[SOCKET] Session archived (${meta.lifecycleState}) but suppressed for reconnect`);
                                this.ignoreArchiveSignal = false;
                            } else {
                                logger.debug(`[SOCKET] Session archived (${meta.lifecycleState}), exiting...`);
                                this.emit('archived');
                            }
                        }
                    }
                    if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                        this.agentState = data.body.agentState.value ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.agentState.value)) : null;
                        this.agentStateVersion = data.body.agentState.version;
                    }
                } else if (data.body.t === 'update-machine') {
                    // Session clients shouldn't receive machine updates - log warning
                    logger.debug(`[SOCKET] WARNING: Session client received unexpected machine update - ignoring`);
                } else {
                    // If not a user message, it might be a permission response or other message type
                    this.emit('message', data.body);
                }
            } catch (error) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', { error });
            }
        });

        // DEATH
        this.socket.on('error', (error) => {
            logger.debug('[API] Socket error:', error);
        });

        //
        // Connect (after short delay to give a time to add handlers)
        //

        this.socket.connect();
    }

    onUserMessage(callback: (data: UserMessage) => void | Promise<void>) {
        this.pendingMessageCallback = (message) => {
            const delivery = Promise.resolve(callback(message));
            this.incomingDeliveries.add(delivery);
            void delivery.finally(() => this.incomingDeliveries.delete(delivery)).catch(() => {
                logger.warn('[API] Incoming message delivery failed');
            });
        };
        while (this.pendingMessages.length > 0) {
            this.pendingMessageCallback(this.pendingMessages.shift()!);
        }
    }

    onFileEvent(callback: (data: FileEventMessage) => void) {
        this.pendingFileEventCallback = callback;
        while (this.pendingFileEvents.length > 0) {
            callback(this.pendingFileEvents.shift()!);
        }
    }

    /**
     * Derive (and cache) the blob decryption key for this session.
     * Legacy sessions use deriveKey(masterSecret, 'Happy Blobs', ['master']).
     * DataKey sessions use deriveKey(dataKey, 'Happy Blobs', ['session']).
     */
    async getBlobKey(): Promise<Uint8Array> {
        if (!this.blobKey) {
            const path = this.encryptionVariant === 'dataKey' ? ['session'] : ['master'];
            this.blobKey = await deriveKey(this.encryptionKey, 'Happy Blobs', path);
        }
        return this.blobKey;
    }

    private async requestAttachmentUpload(filename: string, size: number): Promise<AttachmentUploadResult> {
        const response = await axios.post<AttachmentUploadResult>(
            `${configuration.serverUrl}/v1/sessions/${encodeURIComponent(this.sessionId)}/attachments/request-upload`,
            { filename, size },
            {
                headers: this.authHeaders(),
                timeout: 30000,
            },
        );

        const upload = response.data;
        if (
            !upload
            || typeof upload.ref !== 'string'
            || typeof upload.uploadUrl !== 'string'
            || (upload.method !== undefined && upload.method !== 'PUT' && upload.method !== 'POST')
        ) {
            throw new Error('request-upload returned an invalid response');
        }

        return {
            ...upload,
            method: upload.method ?? 'PUT',
        };
    }

    private async uploadEncryptedAttachmentBlob(upload: AttachmentUploadResult, encrypted: Uint8Array): Promise<void> {
        if (upload.method === 'POST') {
            const { body, boundary } = buildMultipartUploadBody(upload.formFields, encrypted);
            await axios.post(upload.uploadUrl, body, {
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                },
                timeout: 60000,
                maxBodyLength: 10 * 1024 * 1024,
            });
            return;
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/octet-stream',
        };
        if (upload.uploadUrl.startsWith(configuration.serverUrl)) {
            headers.Authorization = `Bearer ${this.token}`;
        }

        await axios.put(upload.uploadUrl, Buffer.from(encrypted), {
            headers,
            timeout: 60000,
            maxBodyLength: 10 * 1024 * 1024,
        });
    }

    async uploadLocalImageAttachmentEnvelope(
        attachment: LocalImageAttachment,
        opts: Pick<CreateEnvelopeOptions, 'id' | 'time' | 'claudeUuid' | 'codexItemId'> = {},
    ): Promise<SessionEnvelope> {
        const blobKey = await this.getBlobKey();
        const encrypted = encryptBlob(attachment.data, blobKey);
        const upload = await this.requestAttachmentUpload(attachment.name, encrypted.length);
        await this.uploadEncryptedAttachmentBlob(upload, encrypted);

        return createEnvelope('user', {
            t: 'file',
            ref: upload.ref,
            name: attachment.name,
            size: attachment.data.length,
            mimeType: attachment.mimeType,
        }, opts);
    }

    /**
     * Download an encrypted attachment blob via the request-download flow:
     * POST /request-download → { downloadUrl } → GET downloadUrl. Local mode
     * downloadUrl points back at our server (Bearer required); S3 mode is a
     * presigned URL that does not accept extra headers.
     */
    async downloadAttachment(ref: string): Promise<Uint8Array> {
        const requestUrl = `${configuration.serverUrl}/v1/sessions/${this.sessionId}/attachments/request-download`;
        const requestRes = await axios.post(
            requestUrl,
            { ref },
            {
                headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
                timeout: 30000,
            },
        );
        const downloadUrl = requestRes.data?.downloadUrl;
        if (typeof downloadUrl !== 'string') {
            throw new Error('request-download returned no downloadUrl');
        }

        const isServerUrl = downloadUrl.startsWith(configuration.serverUrl);
        const headers: Record<string, string> = {};
        if (isServerUrl) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }
        const response = await axios.get(downloadUrl, {
            headers,
            responseType: 'arraybuffer',
            timeout: 60000,
            maxRedirects: 5,
            maxContentLength: 10 * 1024 * 1024,
        });
        return new Uint8Array(response.data);
    }

    /**
     * Download and decrypt an attachment blob.
     * Returns the decrypted binary data or null if decryption fails.
     */
    async downloadAndDecryptAttachment(ref: string): Promise<Uint8Array | null> {
        const encrypted = await this.downloadAttachment(ref);
        const key = await this.getBlobKey();
        const decrypted = decryptBlob(encrypted, key);
        return decrypted;
    }

    /**
     * Track an attachment download whose promise resolves to the decoded blob
     * (or null on failure). The download stays in the current batch until the
     * next drainAttachmentsForUserMessage call swaps the bucket out — file
     * events that arrive after the swap go into a fresh bucket bound to the
     * next user-text message.
     */
    trackAttachmentDownload(promise: Promise<{ data: Uint8Array; mimeType: string; name: string } | null>): void {
        this.pendingDownloads.push(promise);
    }

    /**
     * Atomically claim every download started before this call, wait for them
     * to resolve, and return the successful ones. The swap-then-await order
     * guarantees that a late-arriving file event cannot leak into this batch.
     */
    async drainAttachmentsForUserMessage(): Promise<Array<{ data: Uint8Array; mimeType: string; name: string }>> {
        const downloads = this.pendingDownloads;
        this.pendingDownloads = [];
        if (downloads.length === 0) return [];
        const results = await Promise.all(downloads);
        return results.filter((x): x is { data: Uint8Array; mimeType: string; name: string } => x !== null);
    }

    private authHeaders() {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`
        };
    }

    private routeIncomingMessage(message: unknown) {
        const userResult = UserMessageSchema.safeParse(message);
        if (userResult.success) {
            if (this.pendingMessageCallback) {
                this.pendingMessageCallback(userResult.data);
            } else {
                this.pendingMessages.push(userResult.data);
            }
            return;
        }

        // Check for file events (image attachments from app)
        const fileResult = FileEventMessageSchema.safeParse(message);
        if (fileResult.success) {
            const ev = fileResult.data.content.data.ev;
            logger.debug('[API] Received file event', {
                size: ev.size,
                hasMimeType: Boolean(ev.mimeType),
            });
            if (this.pendingFileEventCallback) {
                this.pendingFileEventCallback(fileResult.data);
            } else {
                this.pendingFileEvents.push(fileResult.data);
            }
            return;
        }

        this.emit('message', message);
    }

    private async fetchMessages() {
        // On reconnect, skip processing existing messages — just advance the cursor
        const skipRouting = this.skipInitialMessages;
        if (skipRouting) {
            this.skipInitialMessages = false;
            logger.debug('[API] Reconnect mode: skipping existing messages, advancing lastReceivedSeq');
        }

        let afterSeq = this.lastReceivedSeq;
        while (true) {
            const response = await axios.get<V3GetSessionMessagesResponse>(
                `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                {
                    params: {
                        after_seq: afterSeq,
                        limit: 100
                    },
                    headers: this.authHeaders(),
                    timeout: 60000
                }
            );

            if (this.incomingPaused) return;
            const messages = Array.isArray(response.data.messages) ? response.data.messages : [];
            let maxSeq = afterSeq;

            for (const message of messages) {
                if (message.seq > maxSeq) {
                    maxSeq = message.seq;
                }

                // A live update can advance the cursor while HTTP is in flight.
                // Claim each sequence before routing to prevent duplicate execution.
                if (message.seq <= this.lastReceivedSeq) continue;
                this.lastReceivedSeq = message.seq;
                if (skipRouting) continue;

                if (message.content?.t !== 'encrypted') {
                    continue;
                }

                try {
                    const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(message.content.c));
                    this.routeIncomingMessage(body);
                } catch (error) {
                    logger.debug('[API] Failed to decrypt fetched message', {
                        sessionId: this.sessionId,
                        seq: message.seq,
                        error
                    });
                }
            }

            this.lastReceivedSeq = Math.max(this.lastReceivedSeq, maxSeq);
            const hasMore = !!response.data.hasMore;
            if (hasMore && maxSeq === afterSeq) {
                logger.debug('[API] fetchMessages pagination stalled, stopping to avoid infinite loop', {
                    sessionId: this.sessionId,
                    afterSeq
                });
                break;
            }
            afterSeq = maxSeq;
            if (!hasMore) {
                break;
            }
        }
    }

    /**
     * A page of this session's transcript, newest first from `beforeSeq`
     * (or from the present), decrypted. For the engine's own reading of the
     * session's record; see utils/sessionTranscript for what it becomes.
     */
    async readTranscript(opts: { limit: number; beforeSeq?: number }): Promise<{ entries: { seq: number; body: unknown }[]; hasMore: boolean }> {
        const limit = Math.max(1, Math.min(200, Math.floor(opts.limit)));
        // The cursor is where this process has read to; anything newer is in
        // flight and will be there next time. Absent a cursor, ask from the top.
        const beforeSeq = opts.beforeSeq ?? (this.lastReceivedSeq > 0 ? this.lastReceivedSeq + 1 : 2 ** 31 - 1);
        const response = await axios.get<V3GetSessionMessagesResponse>(
            `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
            { params: { before_seq: beforeSeq, limit }, headers: this.authHeaders(), timeout: 30000 },
        );
        const messages = Array.isArray(response.data.messages) ? response.data.messages : [];
        const entries: { seq: number; body: unknown }[] = [];
        for (const message of messages) {
            if (message.content?.t !== 'encrypted') continue;
            try {
                entries.push({ seq: message.seq, body: decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(message.content.c)) });
            } catch {
                // A frame this key cannot open is not part of the record this reader can have.
            }
        }
        return { entries, hasMore: !!response.data.hasMore };
    }

    private static readonly MAX_OUTBOX_BATCH_SIZE = 50;

    private async flushOutbox() {
        // Send latest messages first so the user sees recent activity immediately,
        // then backfill older messages in subsequent batches.
        while (this.pendingOutbox.length > 0) {
            const batchSize = Math.min(this.pendingOutbox.length, ApiSessionClient.MAX_OUTBOX_BATCH_SIZE);
            const batchStart = this.pendingOutbox.length - batchSize;
            const batch = this.pendingOutbox.slice(batchStart);

            const response = await axios.post<V3PostSessionMessagesResponse>(
                `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                {
                    messages: batch
                },
                {
                    headers: this.authHeaders(),
                    timeout: 60000
                }
            );

            // Deliberately does not touch the receive cursor. The seqs this
            // response reports are ours, and moving the cursor onto them steps
            // over anything the other side wrote in between — which is exactly
            // how a new session lost the first prompt. Our own messages come
            // back over the socket like everyone else's and move the cursor
            // then, once they have actually been seen.
            this.pendingOutbox.splice(batchStart, batch.length);
        }
    }

    private enqueueMessage(content: unknown, invalidate: boolean = true) {
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.pendingOutbox.push({
            content: encrypted,
            localId: randomUUID()
        });
        if (invalidate) {
            this.sendSync.invalidate();
        }
    }

    private enqueueSessionProtocolEnvelopes(envelopes: SessionEnvelope[], invalidate: boolean = true) {
        for (let i = 0; i < envelopes.length; i += 1) {
            this.enqueueSessionProtocolEnvelope(envelopes[i], invalidate && i === envelopes.length - 1);
        }
    }

    private applyClaudeSessionMessageSideEffects(body: RawJSONLines) {
        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message?.usage) {
            try {
                this.sendUsageData(body.message.usage, body.message.model);
            } catch (error) {
                logger.debug('[SOCKET] Failed to send usage data:', error);
            }
        }

        // Update metadata with summary if this is a summary message
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            this.updateMetadata((metadata) => ({
                ...metadata,
                summary: {
                    text: keepDutyPrefix(metadata, String(body.summary)),
                    updatedAt: Date.now()
                }
            }));
        }
    }

    /**
     * Post a message as if the user had typed it.
     *
     * Used for agent mail: the sender cannot encrypt for this session — it has
     * no key for it — so the recipient writes the delivered text itself. Going
     * out through the outbox rather than straight to the engine means the
     * message comes back over the socket like any other, so the transcript,
     * the web app and `onUserMessage` all see one message, not two paths.
     */
    sendUserTextMessage(text: string, meta?: { displayText?: string; model?: string; effort?: string; permissionMode?: string }) {
        // `meta.displayText` lets the engine receive the full text while the
        // transcript shows a line about it — used by a handoff, where the whole
        // briefing is for the engine and a paragraph of it in the user's own
        // voice is not what happened.
        this.enqueueMessage({ role: 'user', content: { type: 'text', text }, ...(meta ? { meta } : {}) });
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines) {
        const mapped = mapClaudeLogMessageToSessionEnvelopes(body, this.claudeSessionProtocolState);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        this.enqueueSessionProtocolEnvelopes(mapped.envelopes);
        this.applyClaudeSessionMessageSideEffects(body);
    }

    async sendClaudeSessionMessageFromLocalTranscript(body: RawJSONLines): Promise<void> {
        const attachments = extractLocalTranscriptImageAttachments(body);
        if (attachments.length === 0) {
            this.sendClaudeSessionMessage(body);
            return;
        }

        const closeMapped = closeClaudeTurnWithStatus(this.claudeSessionProtocolState, 'completed');
        this.claudeSessionProtocolState.currentTurnId = closeMapped.currentTurnId;
        this.enqueueSessionProtocolEnvelopes(closeMapped.envelopes, false);

        const claudeUuid = typeof (body as { uuid?: unknown }).uuid === 'string'
            ? (body as { uuid: string }).uuid
            : undefined;
        for (const attachment of attachments) {
            try {
                const envelope = await this.uploadLocalImageAttachmentEnvelope(attachment, { claudeUuid });
                this.enqueueSessionProtocolEnvelope(envelope, false);
            } catch (error) {
                logger.debug('[API] Failed to upload local Claude transcript image attachment', {
                    sessionId: this.sessionId,
                    name: attachment.name,
                    error,
                });
            }
        }

        const mapped = mapClaudeLogMessageToSessionEnvelopes(body, this.claudeSessionProtocolState);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        this.enqueueSessionProtocolEnvelopes(mapped.envelopes, mapped.envelopes.length > 0);
        if (mapped.envelopes.length === 0) {
            this.sendSync.invalidate();
        }
        this.applyClaudeSessionMessageSideEffects(body);
    }

    closeClaudeSessionTurn(status: SessionTurnEndStatus = 'completed') {
        const mapped = closeClaudeTurnWithStatus(this.claudeSessionProtocolState, status);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        this.enqueueSessionProtocolEnvelopes(mapped.envelopes);
    }

    sendCodexMessage(body: any) {
        let content = {
            role: 'agent',
            content: {
                type: 'codex',
                data: body  // This wraps the entire Claude message
            },
            meta: {
                sentFrom: 'cli'
            }
        };
        this.enqueueMessage(content);
    }

    private enqueueSessionProtocolEnvelope(envelope: SessionEnvelope, invalidate: boolean = true) {
        void this.resourceReview.observe(envelope).catch(()=>logger.warn('[RESOURCES] 无法保存文件变更索引'));
        const content = {
            role: 'session',
            content: envelope,
            meta: {
                sentFrom: 'cli'
            }
        };

        this.enqueueMessage(content, invalidate);
    }

    sendSessionProtocolMessage(envelope: SessionEnvelope) {
        if (envelope.role !== 'user') {
            this.enqueueSessionProtocolEnvelope(envelope);
            return;
        }

        if (envelope.ev.t !== 'text') {
            this.enqueueSessionProtocolEnvelope(envelope);
            return;
        }

        this.enqueueSessionProtocolEnvelope(envelope);
    }

    /**
     * Send a generic agent message to the session using ACP (Agent Communication Protocol) format.
     * Works for any agent type (Gemini, Codex, Claude, etc.) - CLI normalizes to unified ACP format.
     * 
     * @param provider - The agent provider sending the message (e.g., 'gemini', 'codex', 'claude')
     * @param body - The message payload (type: 'message' | 'reasoning' | 'tool-call' | 'tool-result')
     */
    sendAgentMessage(provider: 'gemini' | 'codex' | 'claude' | 'opencode' | 'openclaw', body: ACPMessageData) {
        let content = {
            role: 'agent',
            content: {
                type: 'acp',
                provider,
                data: body
            },
            meta: {
                sentFrom: 'cli'
            }
        };

        logger.debug(`[SOCKET] Sending ACP message from ${provider}:`, { type: body.type, hasMessage: 'message' in body });

        this.enqueueMessage(content);
    }

    sendSessionEvent(event: {
        type: 'switch', mode: 'local' | 'remote'
    } | {
        type: 'message', message: string
    } | {
        type: 'permission-mode-changed', mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    } | {
        type: 'ready'
    } | {
        /** One engine handed this session to another; `briefing` is what crossed. */
        type: 'engine-handoff', from: string, fromFlavor?: 'claude' | 'codex', source: 'engine' | 'compiled', briefing: string
    } | {
        /** A queued switch was called off before the relaunch; the session stays where it was. */
        type: 'engine-switch-cancelled', target: 'claude' | 'codex'
    }, id?: string) {
        let content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        };
        this.enqueueMessage(content);
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        this.desiredWorking = thinking;
        if (!this.runtimeWrite && this.persistedWorking !== thinking) {
            this.runtimeWrite = (async () => {
                while (!this.closed && this.persistedWorking !== this.desiredWorking) {
                    const working = this.desiredWorking!;
                    await this.updateAgentState(state => ({...state,runtime:{phase:working?'working':'idle',pid:process.pid,updatedAt:Date.now()}}));
                    this.persistedWorking = working;
                }
            })().catch(() => {}).finally(() => {this.runtimeWrite=undefined;});
        }
        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
        this.socket.volatile.emit('session-alive', {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode
        });
    }

    /**
     * This process is leaving so another can take the session over. Not a
     * death: the session is about to be more alive than it is now.
     */
    private relaunching = false;
    markRelaunching() {
        this.relaunching = true;
    }

    /**
     * Send session death message.
     *
     * Skipped when the process is leaving for a relaunch. `session-end` makes
     * the server mark the session inactive and ignore its heartbeats for a
     * minute — protection against a stale heartbeat reviving a stopped
     * session — and the process taking over reconnects by id, which does not
     * lift that. Announcing a death here left every refreshed or switched
     * session showing as inactive, with a Resume button over a running engine,
     * for the minute after it came back.
     */
    sendSessionDeath() {
        if (this.relaunching) {
            logger.debug('[API] Leaving for a relaunch; not announcing session end');
            return;
        }
        this.socket.emit('session-end', { sid: this.sessionId, time: Date.now() });
    }

    /**
     * Send usage data to the server
     */
    sendUsageData(usage: Usage, model?: string) {
        // Calculate total tokens
        const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

        const costs = calculateCost(usage, model);

        // Transform Claude usage format to backend expected format
        const usageReport = {
            key: 'claude-session',
            sessionId: this.sessionId,
            tokens: {
                total: totalTokens,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_creation: usage.cache_creation_input_tokens || 0,
                cache_read: usage.cache_read_input_tokens || 0
            },
            cost: {
                total: costs.total,
                input: costs.input,
                output: costs.output
            }
        }
        logger.debugLargeJson('[SOCKET] Sending usage data:', usageReport)
        this.socket.emit('usage-report', usageReport);
    }

    /**
     * Returns the latest session metadata known to the client.
     */
    getMetadata(): Metadata | null {
        return this.metadata;
    }

    setHubRequestHandler(handler: ((id: string, tool: string, input: unknown) => Promise<boolean>) | null): void {
        this.hubRequestHandler = handler;
    }

    /** No approval is granted here: only hand a blocked decision to this worker's hub. */
    async requestHubDecision(id: string, tool: string, input: unknown): Promise<boolean> {
        const o = this.metadata?.orchestration;
        if (o?.role !== 'worker' || o.hub.autonomy !== true || !this.hubRequestHandler) return false;
        try { return await this.hubRequestHandler(id, tool, input); } catch { return false; }
    }

    /**
     * Replaces the known metadata, telling the transcript when this flips
     * whether the session is a hub. This role controls coordination, not
     * tool permissions; those remain governed by the selected policy. One
     * place catches every source of the flip: this session hiring its first
     * worker or dissolving (through updateMetadata, below) and the app
     * setting or clearing the role from outside (through the socket's own
     * 'update-session' push, above) both funnel through here.
     */
    private applyMetadata(next: Metadata) {
        const wasHub = this.metadata?.orchestration?.role === 'hub';
        this.metadata = next;
        // Control-plane consumers react to accepted metadata, never to a fake
        // user prompt. Includes remote app updates and this runner's own ACKs.
        this.emit('metadata', next);
        const isHub = next.orchestration?.role === 'hub';
        if (wasHub === isHub) return;
        this.sendSessionEvent({
            type: 'message',
            message: isHub
                ? '[hub] 本会话已成为总控：可直接处理任务，也可委派执行并验收；工具权限仍遵循当前权限设置。'
                : '[hub] 本会话已不再是总控：工具权限仍遵循当前权限设置。',
        });
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    suppressNextArchiveSignal() {
        this.ignoreArchiveSignal = true;
    }

    pauseIncomingMessages(): number {
        this.incomingPaused = true;
        return this.lastReceivedSeq;
    }

    resumeIncomingMessagesFrom(seq: number) {
        if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid message cursor');
        this.lastReceivedSeq = seq;
        this.skipInitialMessages = false;
        this.incomingPaused = false;
        this.receiveSync.invalidate();
    }

    skipExistingMessages() {
        this.skipInitialMessages = true;
    }

    updateMetadata(handler: (metadata: Metadata) => Metadata, options?: { strict?: boolean }) {
        return this.metadataLock.inLock(async () => {
            if (options?.strict) {
                for (let attempt = 0; attempt < 8; attempt++) {
                    if (this.closed) throw new Error('Session is closed');
                    if (!this.metadata) throw new Error('Session metadata is unavailable');
                    const updated = handler(this.metadata);
                    const answer = await this.socket.emitWithAck('update-metadata', { sid: this.sessionId, expectedVersion: this.metadataVersion, metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) });
                    if (answer.result === 'success') {
                        this.metadataVersion = answer.version;
                        this.applyMetadata(decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata)));
                        return;
                    }
                    if (answer.result !== 'version-mismatch') throw new Error('Metadata write was rejected');
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version;
                        this.applyMetadata(decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata)));
                    }
                }
                throw new Error('Metadata remained in conflict');
            }
            await backoff(async () => {
                if (this.closed) return;
                let updated = handler(this.metadata!); // Weird state if metadata is null - should never happen but here we are
                const answer = await this.socket.emitWithAck('update-metadata', { sid: this.sessionId, expectedVersion: this.metadataVersion, metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) });
                if (answer.result === 'success') {
                    this.applyMetadata(decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata)));
                    this.metadataVersion = answer.version;
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version;
                        this.applyMetadata(decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata)));
                    }
                    throw new Error('Metadata version mismatch');
                } else if (answer.result === 'error') {
                    // Hard error - ignore
                }
            });
        });
    }

    /**
     * Update session agent state
     * @param handler - Handler function that returns the updated agent state
     */
    updateAgentState(handler: (metadata: AgentState) => AgentState) {
        logger.debugLargeJson('Updating agent state', this.agentState);
        this.agentStateLock.inLock(async () => {
            await backoff(async () => {
                if (this.closed) return;
                let updated = handler(this.agentState || {});
                const answer = await this.socket.emitWithAck('update-state', { sid: this.sessionId, expectedVersion: this.agentStateVersion, agentState: updated ? encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) : null });
                if (answer.result === 'success') {
                    this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                    this.agentStateVersion = answer.version;
                    logger.debug('Agent state updated', this.agentState);
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.agentStateVersion) {
                        this.agentStateVersion = answer.version;
                        this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                    }
                    throw new Error('Agent state version mismatch');
                } else if (answer.result === 'error') {
                    // console.error('Agent state update error', answer);
                    // Hard error - ignore
                }
            });
        });
    }

    /**
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        await Promise.race([
            this.sendSync.invalidateAndAwait(),
            delay(10000)
        ]);
        if (!this.socket.connected) {
            return;
        }
        return new Promise((resolve) => {
            this.socket.emit('ping', () => {
                resolve();
            });
            setTimeout(() => {
                resolve();
            }, 10000);
        });
    }

    async close() {
        if (this.closed) return;
        // Set this before awaiting I/O: concurrent close calls must be idempotent.
        this.closed = true;
        await this.resourceReview.flush();
        logger.debug('[API] socket.close() called');
        this.sendSync.stop();
        this.receiveSync.stop();
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
        }
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        this.socket.close();
    }

    private startSmartReconnect() {
        if (this.closed || this.reconnectInterval) return;

        this.reconnectInterval = setInterval(() => {
            if (this.closed || this.socket.connected) {
                clearInterval(this.reconnectInterval!);
                this.reconnectInterval = null;
                return;
            }
            if (!shouldReconnect()) {
                logger.debug('[API] Still not ready to reconnect');
                return;
            }
            logger.debug('[API] Attempting reconnect');
            this.socket.connect();
        }, 3000);

        if (shouldReconnect()) {
            logger.debug('[API] Network up + lid open — reconnecting in 1s');
            this.reconnectTimeout = setTimeout(() => {
                this.reconnectTimeout = null;
                if (!this.closed && !this.socket.connected && shouldReconnect()) this.socket.connect();
            }, 1000);
        }
    }
}


/**
 * A hub's or worker's duty lives in its title as a 【…】 prefix, put there by
 * the hub. The engine's own auto-titling (and a careless change_title) would
 * quietly drop it; the prefix survives unless the new title brings one of its
 * own — that is how a hub reassigns a duty.
 */
export function keepDutyPrefix(metadata: Metadata | null, title: string): string {
    if (!metadata?.orchestration) return title;
    const previous = /^【[^】]+】/.exec(metadata.summary?.text ?? '')?.[0];
    if (!previous || /^【[^】]+】/.test(title)) return title;
    return `${previous}${title}`.slice(0, 120);
}

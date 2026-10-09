import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

export interface InboxAttachment { data: Uint8Array; mimeType: string; name: string; file?: { path: string; size: number } }
export interface SavedAttachment { name: string; path: string; size: number; isImage: boolean }

const IMAGE_MAGIC: number[][] = [
    [0xff, 0xd8, 0xff],
    [0x89, 0x50, 0x4e, 0x47],
    [0x47, 0x49, 0x46, 0x38],
    [0x52, 0x49, 0x46, 0x46],
];

export function looksLikeImage(bytes: Uint8Array): boolean {
    return IMAGE_MAGIC.some((magic) => magic.every((b, i) => bytes[i] === b));
}

/** Keeps the user's file name readable while refusing separators, traversal and control characters. */
export function safeAttachmentName(name: string, fallback = 'attachment'): string {
    const base = basename(name.replace(/[\\/]+/g, '/')).replace(/[\u0000-\u001f]/g, '').trim();
    const cleaned = base.replace(/^\.+/, '').slice(0, 120);
    return cleaned.length > 0 ? cleaned : fallback;
}

function stamp(now: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

async function writable(dir: string): Promise<boolean> {
    try { await access(dir, constants.W_OK); return true; } catch { return false; }
}

/**
 * Where files sent from the web land on this Mac: `.lmc-inbox/` inside the
 * session's project so the agent can read them with relative paths, or the
 * agent home when the project directory is missing or read-only. The inbox
 * is created with its own .gitignore so attachments never end up committed.
 */
export async function resolveInboxDir(projectPath: string | null | undefined, sessionId: string): Promise<string> {
    if (projectPath && await writable(projectPath)) {
        const dir = join(projectPath, '.lmc-inbox');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined);
        return dir;
    }
    const dir = join(configuration.lmcHomeDir, 'inbox', safeAttachmentName(sessionId, 'session'));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
}

export async function saveAttachmentsToInbox(
    attachments: InboxAttachment[],
    opts: { projectPath: string | null | undefined; sessionId: string; now?: () => Date },
): Promise<SavedAttachment[]> {
    if (attachments.length === 0) return [];
    const dir = await resolveInboxDir(opts.projectPath, opts.sessionId);
    const saved: SavedAttachment[] = [];
    for (const [index, att] of attachments.entries()) {
        const name = safeAttachmentName(att.name);
        const prefix = stamp((opts.now ?? (() => new Date()))());
        const suffix = attachments.length > 1 ? `-${index + 1}` : '';
        const ext = extname(name);
        // A large file was written here while it downloaded; it is never model input.
        if (att.file) { saved.push({ name, path: att.file.path, size: att.file.size, isImage: false }); continue; }
        const base = `${prefix}${suffix}-${ext ? name.slice(0, -ext.length) : name}`;
        // Different queued messages often all call their screenshot image.jpg.
        // Reserve by writing exclusively, including on concurrent deliveries.
        for (let collision = 0; ; collision++) {
            const path = join(dir, `${base}${collision ? `-${collision + 1}` : ''}${ext}`);
            try {
                await writeFile(path, Buffer.from(att.data), { flag: 'wx', mode: 0o600 });
                saved.push({ name, path, size: att.data.length, isImage: looksLikeImage(att.data) });
                break;
            } catch (error) {
                if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
                logger.debug('[inbox] Failed to save attachment', { name, error: error instanceof Error ? error.message : String(error) });
                break;
            }
        }
    }
    return saved;
}

/** A fresh path in the inbox for a file that is written as it arrives. */
export async function reserveInboxPath(name: string, opts: { projectPath: string | null | undefined; sessionId: string; now?: () => Date }): Promise<string> {
    const dir = await resolveInboxDir(opts.projectPath, opts.sessionId);
    const safe = safeAttachmentName(name);
    const ext = extname(safe);
    const base = `${stamp((opts.now ?? (() => new Date()))())}-${ext ? safe.slice(0, -ext.length) : safe}`;
    for (let n = 0; ; n++) {
        const path = join(dir, `${base}${n ? `-${n + 1}` : ''}${ext}`);
        try { await access(path, constants.F_OK); } catch { return path; }
    }
}

/** Text appended to the user's message so the agent knows where the files are. */
export function formatInboxNote(saved: SavedAttachment[]): string {
    if (saved.length === 0) return '';
    const lines = saved.map((s) => `- ${s.path} (${formatBytes(s.size)})`);
    return `\n\n[用户随消息发来的文件已保存到本机，可直接读取]\n${lines.join('\n')}`;
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

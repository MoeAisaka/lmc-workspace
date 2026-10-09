import type { ApiSessionClient } from '@/api/apiSession';
import type { FileEventMessage } from '@/api/types';
import type { PendingAttachment } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { reserveInboxPath } from './attachmentInbox';

type LargeFileSession = Pick<ApiSessionClient, 'sessionId' | 'downloadAttachmentPartsToFile' | 'sendSessionEvent'>;

/** True when the file was uploaded in pieces and must be assembled on disk. */
export function isLargeFileEvent(fileEvent: FileEventMessage): boolean {
    return (fileEvent.content.data.ev.parts?.length ?? 0) > 0;
}

/**
 * Receive a file sent in pieces, straight into the session's inbox. Shared by
 * Claude and Codex. A failure is said in the session: the message that follows
 * would otherwise arrive without its file and without a word about it.
 */
export async function receiveLargeFileEvent(
    session: LargeFileSession, fileEvent: FileEventMessage, projectPath: string | null | undefined,
): Promise<PendingAttachment | null> {
    const ev = fileEvent.content.data.ev;
    try {
        const path = await reserveInboxPath(ev.name, { projectPath, sessionId: session.sessionId });
        const size = await session.downloadAttachmentPartsToFile(ev.parts!, path, ev.size);
        logger.debug('[inbox] Large attachment received', { size, parts: ev.parts!.length });
        return { data: new Uint8Array(0), mimeType: ev.mimeType ?? 'application/octet-stream', name: ev.name, file: { path, size } };
    } catch (error) {
        logger.debug('[inbox] Large attachment failed', { errorName: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : undefined });
        session.sendSessionEvent({ type: 'message', message: `文件「${ev.name}」没有完整收到，未交给 Agent；请重新发送。` });
        return null;
    }
}

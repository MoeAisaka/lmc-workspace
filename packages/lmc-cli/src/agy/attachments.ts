import type { ApiSessionClient } from '@/api/apiSession';
import { downloadCodexFileEventAttachment } from '@/codex/utils/attachmentEvents';
import { isLargeFileEvent, receiveLargeFileEvent } from '@/modules/common/largeFileEvent';
import { saveAttachmentsToInbox, formatInboxNote } from '@/modules/common/attachmentInbox';

/** Use the same encrypted file events and per-message ownership as the other native engines. */
export function registerAgyAttachments(session: ApiSessionClient, cwd: string): void {
    session.onFileEvent(event => {
        const download = isLargeFileEvent(event)
            ? receiveLargeFileEvent(session, event, cwd)
            : downloadCodexFileEventAttachment(session, event).then(attachment => {
                if (!attachment) session.sendSessionEvent({ type: 'message', message: `文件「${event.content.data.ev.name}」没有完整收到，未交给 Agent；请重新发送。` });
                return attachment;
            });
        session.trackAttachmentDownload(download);
    });
}

export async function prepareAgyAttachmentPrompt(session: ApiSessionClient, text: string, cwd: string): Promise<string> {
    const attachments = await session.drainAttachmentsForUserMessage();
    if (!attachments.length) return text;
    const saved = await saveAttachmentsToInbox(attachments, { projectPath: cwd, sessionId: session.sessionId });
    if (saved.length !== attachments.length) {
        session.sendSessionEvent({ type: 'message', message: '部分附件未能保存到设备，请重新发送；未保存的文件不会交给 Agent。' });
    }
    return text + formatInboxNote(saved);
}

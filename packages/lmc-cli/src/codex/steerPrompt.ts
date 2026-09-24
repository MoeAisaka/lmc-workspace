import type { CodexAppServerClient } from './codexAppServerClient';
import type { PendingAttachment } from '@/utils/MessageQueue2';
import { detectSupportedImageType, prepareCodexImageInputItems } from './utils/imageInput';

/** Prepare the entire reply before steering. No partial image delivery, and
 * never steer into a different turn if attachment preparation crosses a boundary. */
export async function steerCodexPrompt(
    client: Pick<CodexAppServerClient, 'turnId' | 'hasPendingTurnCompletion' | 'steerTurn'>,
    text: string,
    attachments: PendingAttachment[] | undefined,
    opts: { sessionId: string; cacheRootDir?: string; canSteer?: () => boolean },
): Promise<{ steered: boolean; reason?: string }> {
    const turnId = client.turnId;
    if (!turnId || !client.hasPendingTurnCompletion()) return { steered: false, reason: 'idle' };
    if (text.trimStart().startsWith('/') || (!text.trim() && !attachments?.length)) return { steered: false, reason: 'command' };
    if (attachments?.some(attachment => !detectSupportedImageType(attachment.data))) return { steered: false, reason: 'attachments' };
    const images = await prepareCodexImageInputItems(attachments, opts);
    if (images.skipped) return { steered: false, reason: 'attachments' };
    if (opts.canSteer && !opts.canSteer()) return { steered: false, reason: 'settings' };
    const steered = await client.steerTurn(text, { expectedTurnId: turnId, extraInputItems: images.inputItems });
    return steered ? { steered: true } : { steered: false, reason: 'refused' };
}

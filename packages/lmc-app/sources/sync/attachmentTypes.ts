/**
 * Shared types for image attachment upload pipeline.
 * Defined here (not in hooks/) to avoid circular dependencies:
 * hooks/ imports from sync/, so sync/ cannot import from hooks/.
 */

export type AttachmentPreview = {
    /** Stable unique identifier for use as React key and for removal. */
    id: string;
    uri: string;
    width: number;
    height: number;
    mimeType: string;
    /** May be 0 if the system did not provide the file size. */
    size: number;
    name: string;
    thumbhash?: string;
};

/** Result of a successful attachment upload — ready to build a file event. */
export type UploadedAttachment = {
    ref: string;
    name: string;
    size: number;
    width: number;
    height: number;
    thumbhash?: string;
};

export const MAX_IMAGES_PER_MESSAGE = 20;
/** Images are model input. */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
/** Anything else is delivered to the session's Mac; the center accepts 50MB. */
export const MAX_ATTACHMENT_FILE_SIZE = 50 * 1024 * 1024;

/**
 * How large this attachment may be, by what it is rather than by which button
 * picked it. The document picker used to apply the file limit to images too, so
 * the same photo passed through "+" and was refused when pasted.
 */
export function attachmentSizeLimit(mimeType: string | null | undefined): number {
    return (mimeType || '').startsWith('image/') ? MAX_FILE_SIZE : MAX_ATTACHMENT_FILE_SIZE;
}

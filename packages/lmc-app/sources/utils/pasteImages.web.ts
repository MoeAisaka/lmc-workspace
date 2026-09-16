/**
 * Files carried by a paste or a drop on web, turned into attachment previews.
 *
 * Not images only: a dropped archive or spreadsheet is as much an attachment as
 * a screenshot, and filtering them out left the drop silently doing nothing —
 * the event was accepted, `preventDefault` was called, and then the list came
 * back empty. What differs is only the preview: an image is measured and gets a
 * thumbhash, anything else has no dimensions to read.
 */

export function getFilesFromClipboard(event: ClipboardEvent): File[] {
    const items = event.clipboardData?.items;
    if (!items) return [];

    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (file) files.push(file);
    }
    return files;
}

export function getFilesFromDrop(event: DragEvent): File[] {
    const dropped = event.dataTransfer?.files;
    if (!dropped) return [];

    const files: File[] = [];
    for (let i = 0; i < dropped.length; i++) files.push(dropped[i]);
    return files;
}

async function measureImage(uri: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
        image.onload = () => {
            clearTimeout(timeout);
            resolve({ width: image.naturalWidth, height: image.naturalHeight });
        };
        image.onerror = () => {
            clearTimeout(timeout);
            reject(new Error('load error'));
        };
        image.src = uri;
    });
}

export async function fileToAttachmentPreview(
    file: File,
    generateThumbhash: (uri: string, w: number, h: number) => Promise<string | undefined>,
): Promise<{
    uri: string;
    width: number;
    height: number;
    size: number;
    name: string;
    mimeType: string;
    thumbhash?: string;
} | null> {
    try {
        const uri = URL.createObjectURL(file);
        const mimeType = file.type || 'application/octet-stream';
        const named = file.name || `paste_${Date.now()}`;

        // Only an image can be measured. Loading anything else as one waits out
        // the timeout and then reports the file as unreadable.
        if (!mimeType.startsWith('image/')) {
            return { uri, width: 0, height: 0, size: file.size, name: named, mimeType };
        }

        const { width, height } = await measureImage(uri);
        const thumbhash = (width > 0 && height > 0)
            ? await generateThumbhash(uri, width, height)
            : undefined;

        return {
            uri,
            width,
            height,
            size: file.size,
            name: file.name || `paste_${Date.now()}.png`,
            mimeType: file.type || 'image/png',
            thumbhash,
        };
    } catch {
        return null;
    }
}

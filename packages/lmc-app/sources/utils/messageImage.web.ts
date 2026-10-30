import html2canvas from 'html2canvas';

/** Bound canvas memory without cropping the bottom of a long reply. */
export function messageImageScale(width: number, height: number): number {
    const scale = Math.min(2, 16384 / Math.max(width, height), Math.sqrt(16_000_000 / (width * height)));
    if (!Number.isFinite(scale) || scale < 0.5 || width <= 0 || height <= 0) {
        throw new Error('正文过长，无法生成清晰的单张图片，请使用复制文字。');
    }
    return scale;
}

export async function renderMessageImage(node: HTMLElement): Promise<Blob> {
    await document.fonts.ready;
    const deadline = Date.now() + 15000;
    while (node.querySelector('[role="progressbar"]')) {
        if (Date.now() > deadline) throw new Error('正文中的图片或图表尚未加载完成，请稍后重试。');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    await Promise.all([...node.querySelectorAll('img')].map(async image => {
        await image.decode();
        if (!image.naturalWidth) throw new Error('正文图片加载失败，请稍后重试。');
    }));
    // Expand horizontal code/table scrollers in the export only.
    for (const child of [...node.querySelectorAll<HTMLElement>('div')].reverse()) {
        const style = getComputedStyle(child);
        if (/auto|scroll|hidden/.test(style.overflowX)) {
            child.style.width = `${child.scrollWidth}px`;
            child.style.maxWidth = 'none';
            child.style.flexShrink = '0';
            child.style.overflow = 'visible';
        }
    }
    node.style.width = `${Math.max(node.offsetWidth, node.scrollWidth + 24)}px`;
    const width = node.offsetWidth, height = node.scrollHeight;
    const canvas = await html2canvas(node, {
        width, height, scale: messageImageScale(width, height),
        backgroundColor: getComputedStyle(node).backgroundColor,
        useCORS: true, logging: false,
        ignoreElements: element => element.hasAttribute('data-image-export-ignore'),
    });
    try {
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片生成失败。')), 'image/png'));
    } finally {
        canvas.width = canvas.height = 0;
    }
}

export function downloadMessageImage(blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lmc-reply.png';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

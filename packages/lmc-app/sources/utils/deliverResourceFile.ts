import { t } from '@/text';
/** WebUI delivery keeps the file on the current browser device. */
export async function deliverResourceFile(file: { name: string; content: string }, action: 'download' | 'share') {
    if (typeof document === 'undefined') throw new Error(t('lmc.common.downloadInWeb'));
    const bytes = Uint8Array.from(atob(file.content), c => c.charCodeAt(0));
    const types:Record<string,string>={pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',txt:'text/plain',md:'text/markdown',json:'application/json',csv:'text/csv',html:'text/html',zip:'application/zip'};
    const blob = new File([bytes], file.name, { type: types[file.name.split('.').pop()?.toLowerCase()||''] || 'application/octet-stream' });
    if (action === 'share') {
        if (!navigator.canShare?.({ files: [blob] })) throw new Error(t('lmc.common.shareUnsupported'));
        await navigator.share({ files: [blob], title: file.name });
        return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = file.name; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

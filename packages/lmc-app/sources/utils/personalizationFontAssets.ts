import type { AssetFont } from '@/sync/personalizationFonts';

const pending = new Map<string, Promise<void>>();
function loadStylesheet(name: string, version = 'v1') {
    const url = `/fonts/personalization-${version}/${name}.css`;
    const existing = pending.get(url);
    if (existing) return existing;
    const promise = new Promise<void>((resolve, reject) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = url;
        link.onload = () => resolve();
        link.onerror = () => { pending.delete(url); link.remove(); reject(new Error('Font stylesheet unavailable')); };
        document.head.appendChild(link);
    });
    pending.set(url, promise);
    return promise;
}

/** Selected fonts load from this site only; default users download no new fonts. */
export async function loadUIFont(font: AssetFont): Promise<'ready' | 'original' | 'fallback'> {
    const added = {
        misans: ['LMC MiSans', '中文阅读 Aa'],
        wenkai: ['LMC WenKai', '中文阅读 Aa'],
        newsreader: ['LMC Newsreader', 'Reading Aa'],
        sourceSerif: ['LMC Source Serif', 'Reading Aa'],
        sarasa: ['LMC Sarasa Mono', '代码 Aa 01'],
        jetbrains: ['LMC JetBrains Mono', 'Code Aa 01'],
    } as const;
    if (font in added) {
        const [family, sample] = added[font as keyof typeof added];
        const companion = font === 'newsreader' || font === 'sourceSerif' || font === 'wenkai' ? 'songti'
            : font === 'jetbrains' ? 'sarasa' : null;
        await Promise.all([
            loadStylesheet(font, 'v2'),
            ...(companion ? [loadStylesheet(companion, companion === 'songti' ? 'v1' : 'v2')] : []),
        ]);
        await Promise.all([
            document.fonts.load(`400 16px "${family}"`, sample),
            ...(companion ? [document.fonts.load(`400 16px "${companion === 'songti' ? 'LMC Songti' : 'LMC Sarasa Mono'}"`, '中文')] : []),
        ]);
        return 'ready';
    }
    if (font === 'songti' || font === 'magazine' || font === 'claude') {
        await loadStylesheet('songti');
        if (font === 'magazine') {
            await loadStylesheet('magazine');
            await document.fonts.load('16px "LMC Magazine"', '杂志阅读 Aa');
        } else if (font === 'claude') {
            await loadStylesheet('claude-local');
            try {
                const faces = await document.fonts.load('400 16px "LMC Claude Serif"', 'Aa');
                if (faces.some(face => face.status === 'loaded')) return 'original';
            } catch { /* Local font missing: use the disclosed fallback. */ }
            await document.fonts.load('16px "LMC Songti"', '中文阅读');
            return 'fallback';
        } else {
            await document.fonts.load('16px "LMC Songti"', '宋体阅读 Aa');
        }
    }
    return 'ready';
}

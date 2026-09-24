import * as React from 'react';
import { useSession } from '@/sync/storage';
import { loadMarkdownImage, parseMarkdownImageSource } from '@/utils/markdownImage';

type ImageState = { key: string; uri: string | null; status: 'loading' | 'ready' | 'failed' | 'unsupported' };

/** Read local previews through their owning session; ignore late results after navigation. */
export function useMarkdownImage(url: string, sessionId?: string) {
    const source = React.useMemo(() => parseMarkdownImageSource(url), [url]);
    const session = useSession(sessionId || '');
    const supported = session?.metadata?.sessionCapabilities?.resourceFiles === true;
    const [attempt, setAttempt] = React.useState(0);
    const key = JSON.stringify([sessionId, url, attempt]);
    const [state, setState] = React.useState<ImageState>({ key, uri: null, status: 'loading' });

    React.useEffect(() => {
        let active = true;
        setState({ key, uri: null, status: 'loading' });
        if (!source) setState({ key, uri: null, status: 'failed' });
        else if (source.kind === 'uri') setState({ key, uri: source.uri, status: 'ready' });
        else if (!sessionId || !supported) setState({ key, uri: null, status: 'unsupported' });
        else void loadMarkdownImage(sessionId, source.path, source.mime).then(
            uri => { if (active) setState({ key, uri, status: 'ready' }); },
            () => { if (active) setState({ key, uri: null, status: 'failed' }); },
        );
        return () => { active = false; };
    }, [source, sessionId, supported, key]);

    const current: ImageState = state.key === key ? state : { key, uri: null, status: 'loading' };
    return {
        ...current,
        retry: () => setAttempt(value => value + 1),
        onError: () => setState(value => value.key === key ? { key, uri: null, status: 'failed' } : value),
    };
}

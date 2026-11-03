import * as React from 'react';
import { Platform, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '../StyledText';
import { Typography } from '@/constants/Typography';
import { conversationFontSize, conversationLineHeight } from '@/constants/PersonalizationStyles';
import { latexToPlainText, renderMathToHtml } from './mathUtils';

const KATEX_CSS_HREF = '/fonts/katex-v1/katex.min.css';
const MAX_NATIVE_MATH_HEIGHT = 360;

let katexStylesheetInjected = false;

/**
 * Lazily attach the self-hosted KaTeX stylesheet once when a message actually
 * renders math, keeping non-math sessions free of extra font/CSS requests.
 */
export function ensureKatexStylesheet(): void {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    if (katexStylesheetInjected || document.querySelector('link[data-lmc-katex-css="true"]')) {
        katexStylesheetInjected = true;
        return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = KATEX_CSS_HREF;
    link.dataset.lmcKatexCss = 'true';
    const readingSheet = document.head.querySelector('style[data-lmc-reading-styles="true"]');
    if (readingSheet) {
        document.head.insertBefore(link, readingSheet);
    } else {
        document.head.appendChild(link);
    }
    katexStylesheetInjected = true;
}

export const MathBlock = React.memo(function MathBlock(props: {
    content: string;
    first?: boolean;
    last?: boolean;
    selectable?: boolean;
    imageExport?: boolean;
}) {
    const { theme } = useUnistyles();
    const html = React.useMemo(() => renderMathToHtml(props.content, true), [props.content]);
    const [nativeHeight, setNativeHeight] = React.useState(64);

    if (Platform.OS === 'web') {
        ensureKatexStylesheet();
        return (
            <View
                {...{ dataSet: { lmcBlock: 'math' } }}
                style={[style.blockWrap, props.first && style.first, props.last && style.last]}
            >
                {/* @ts-ignore - Web DOM element for synchronous zero-flicker KaTeX layout */}
                <div
                    className="lmc-math-block"
                    dangerouslySetInnerHTML={{ __html: html }}
                />
            </View>
        );
    }

    if (props.imageExport) {
        return (
            <View style={[style.blockWrap, style.nativeFallbackCard, props.first && style.first, props.last && style.last]}>
                <Text selectable={props.selectable} style={style.nativeDisplayText}>
                    {latexToPlainText(props.content)}
                </Text>
            </View>
        );
    }

    const webviewDoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.28/dist/katex.min.css">
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    color: ${theme.colors.text};
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
  }
  #math-root {
    padding: 8px 4px;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .katex-display { margin: 0 auto; width: max-content; }
  .katex .katex-mathml { position: absolute; clip: rect(1px, 1px, 1px, 1px); height: 1px; width: 1px; overflow: hidden; }
</style>
</head>
<body>
  <div id="math-root">${html}</div>
  <script>
    function report() {
      var el = document.getElementById('math-root');
      var h = Math.ceil(Math.max(el ? el.scrollHeight : 0, document.body.scrollHeight));
      if (window.ReactNativeWebView && h > 0) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'height', height: h }));
      }
    }
    requestAnimationFrame(function() { report(); setTimeout(report, 150); });
    window.addEventListener('load', report);
  </script>
</body>
</html>`;

    return (
        <View style={[style.blockWrap, props.first && style.first, props.last && style.last]}>
            <View style={{ width: '100%', height: Math.min(nativeHeight, MAX_NATIVE_MATH_HEIGHT) }}>
                <WebView
                    source={{ html: webviewDoc }}
                    originWhitelist={['*']}
                    onShouldStartLoadWithRequest={(req) => req.url === 'about:blank'}
                    style={{ flex: 1, backgroundColor: 'transparent' }}
                    scrollEnabled={true}
                    showsVerticalScrollIndicator={false}
                    onMessage={(event) => {
                        try {
                            const msg = JSON.parse(event.nativeEvent.data);
                            if (msg?.type === 'height' && typeof msg.height === 'number' && Number.isFinite(msg.height) && msg.height > 0) {
                                setNativeHeight(Math.max(40, msg.height));
                            }
                        } catch {
                            // Ignore malformed WebView messages
                        }
                    }}
                />
            </View>
        </View>
    );
});

export const MathInline = React.memo(function MathInline(props: {
    content: string;
    displayMode?: boolean;
    baseStyle?: any;
    extraStyles?: any;
    selectable?: boolean;
}) {
    const html = React.useMemo(
        () => renderMathToHtml(props.content, Boolean(props.displayMode)),
        [props.content, props.displayMode],
    );

    if (Platform.OS === 'web') {
        ensureKatexStylesheet();
        return (
            // @ts-ignore - Web inline DOM span inside react-native-web Text container
            <span
                className={props.displayMode ? 'lmc-math-inline-display' : 'lmc-math-inline'}
                dangerouslySetInnerHTML={{ __html: html }}
            />
        );
    }

    return (
        <Text
            selectable={props.selectable}
            style={[props.baseStyle, style.nativeInlineText, props.extraStyles]}
        >
            {latexToPlainText(props.content)}
        </Text>
    );
});

const style = StyleSheet.create((theme) => ({
    blockWrap: {
        width: '100%',
        marginVertical: 10,
    },
    first: {
        marginTop: 0,
    },
    last: {
        marginBottom: 0,
    },
    nativeFallbackCard: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    nativeDisplayText: {
        ...Typography.default(),
        fontSize: conversationFontSize(15.5),
        lineHeight: conversationLineHeight(25),
        color: theme.colors.text,
        textAlign: 'center',
    },
    nativeInlineText: {
        ...Typography.default(),
        color: theme.colors.text,
    },
}));

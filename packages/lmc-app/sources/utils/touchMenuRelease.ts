/** Guard one compatibility click without consuming a new pointer gesture. */
export function suppressTouchReleaseClick(target: EventTarget): () => void {
    const cleanup = () => {
        target.removeEventListener('click', suppress, { capture: true });
        target.removeEventListener('pointerdown', cleanup, { capture: true });
        clearTimeout(expiry);
    };
    const suppress = (event: Event) => {
        if ((event as MouseEvent).detail > 0) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
        cleanup();
    };
    const expiry = setTimeout(cleanup, 600);
    target.addEventListener('click', suppress, { capture: true });
    target.addEventListener('pointerdown', cleanup, { capture: true });
    return cleanup;
}

export function createSerialAsyncHandler<T>(
    handler: (value: T) => Promise<void>,
    onError?: (error: unknown) => void,
): ((value: T) => void) & { idle: () => Promise<void> } {
    let tail = Promise.resolve();

    const accept = (value: T) => {
        tail = tail
            .then(() => handler(value))
            .catch((error) => {
                onError?.(error);
            });
    };
    return Object.assign(accept, { idle: () => tail });
}

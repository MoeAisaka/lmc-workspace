// Compatibility calls are intentionally inert in the self-hosted Web client.
interface Tracking {
    identify(id: string, properties?: Record<string, unknown>): void;
    capture(event: string, properties?: Record<string, unknown>): void;
    screen(name: string, properties?: Record<string, unknown>): void;
    reset(): void;
    optIn(): void;
    optOut(): void;
}
export const tracking: Tracking | null = null;

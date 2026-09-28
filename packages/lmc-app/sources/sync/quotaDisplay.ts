import type { AccountQuotaProvider, AccountQuotaWindow } from 'lmc-wire';

/**
 * How the account quota reads at a glance (Figma D23): one tone per window
 * and one number per engine, shared by the avatar-row rings and the card.
 */
export type QuotaTone = 'good' | 'warn' | 'low' | 'unknown';

/** ≥ 50 % green, 20–49 % amber, below 20 % (including 0) red. */
export function quotaTone(remaining: number | null | undefined): QuotaTone {
    if (remaining == null || !Number.isFinite(remaining)) return 'unknown';
    if (remaining >= 50) return 'good';
    if (remaining >= 20) return 'warn';
    return 'low';
}

export function quotaToneColor(tone: QuotaTone, dark: boolean): string {
    switch (tone) {
        case 'good': return dark ? '#3DBE8B' : '#21A06B';
        case 'warn': return dark ? '#F0B84A' : '#E09A0D';
        case 'low': return dark ? '#F07378' : '#E3484D';
        default: return dark ? '#5A5A60' : '#C7C7C7';
    }
}

/** The card's own staleness rule: Codex samples every 30 min, Claude every 5. */
export function quotaProviderStale(provider: AccountQuotaProvider | undefined, now: number): boolean {
    if (!provider?.capturedAt) return true;
    return provider.stale || now - provider.capturedAt > (provider.engine === 'codex' ? 65 : 30) * 60_000;
}

/** A window whose reset time has passed no longer says what is left. */
function usableRemaining(window: AccountQuotaWindow | undefined, now: number): number | null {
    if (!window || window.remaining == null) return null;
    if (window.resetsAt && window.resetsAt <= now && !window.pending) return null;
    return window.remaining;
}

/**
 * The ring's number: whichever of the 5-hour and weekly windows has less
 * left, because that one decides whether the engine can work right now. The
 * Fable pool is separate and never drives it. Unknown when stale.
 */
export function bindingRemaining(provider: AccountQuotaProvider | undefined, now: number): number | null {
    if (!provider || quotaProviderStale(provider, now)) return null;
    const values = (['five_hour', 'seven_day'] as const)
        .map((id) => usableRemaining(provider.windows.find((w) => w.id === id), now))
        .filter((v): v is number => v !== null);
    return values.length ? Math.min(...values) : null;
}

/**
 * The window that makes the other one moot: when one is used up, the other's
 * headroom cannot be spent, so the card greys it and says why.
 */
export function exhaustedWindow(provider: AccountQuotaProvider | undefined, now: number): 'five_hour' | 'seven_day' | null {
    for (const id of ['seven_day', 'five_hour'] as const) {
        const remaining = usableRemaining(provider?.windows.find((w) => w.id === id), now);
        if (remaining !== null && remaining <= 0) return id;
    }
    return null;
}

/** Hours and minutes until a reset, rounded up to the next minute. */
export function resetCountdown(resetsAt: number, now: number): { hours: number; minutes: number } {
    const total = Math.max(1, Math.ceil((resetsAt - now) / 60_000));
    return { hours: Math.floor(total / 60), minutes: total % 60 };
}

const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** "9/30 周三 22:00" — the weekly reset names its day, not a countdown. */
export function weeklyResetLabel(resetsAt: number, chinese: boolean): string {
    const d = new Date(resetsAt);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (chinese) return `${d.getMonth() + 1}/${d.getDate()} ${WEEKDAYS_ZH[d.getDay()]} ${time}`;
    return `${d.toLocaleDateString('en', { weekday: 'short' })} ${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

/**
 * Pure helpers behind the CollaborationSheet: the 【duty】 prefix a hub writes
 * into a worker's title, and the role snapshot an undo toast replays. Kept in
 * their own module, free of React Native imports, so they can be unit tested
 * directly — the sheet component itself pulls in enough native UI that
 * importing it outside the app crashes the plain-Node test runner.
 */

const DUTY_PREFIX_RE = /^【([^】]*)】\s*/;

export function parseDutyPrefix(name: string): string | null {
    const match = DUTY_PREFIX_RE.exec(name);
    return match ? match[1] : null;
}

export function stripDutyPrefix(name: string): string {
    return name.replace(DUTY_PREFIX_RE, '').trim();
}

/**
 * A duty written by hand could itself contain 【】 — pasted from an existing
 * title, say — which would otherwise nest inside the prefix `applyDutyPrefix`
 * adds and break the one-prefix-per-name invariant `stripDutyPrefix` assumes.
 * Applied both where a duty is typed in and again here, so neither path can
 * be the one that lets a stray bracket through.
 */
export function sanitizeDutyText(duty: string): string {
    return duty.replace(/[【】]/g, '').trim();
}

export function applyDutyPrefix(name: string, duty: string | null): string {
    const bare = stripDutyPrefix(name);
    const cleaned = duty ? sanitizeDutyText(duty) : '';
    return cleaned ? `【${cleaned}】${bare}` : bare;
}

/** The shape of `Metadata['orchestration']`, without importing storageTypes' RN-adjacent graph. */
export type OrchestrationRole =
    | { role: 'hub'; workers: Array<{ sessionId: string }> }
    | { role: 'worker'; hub: { sessionId: string } }
    | undefined;

/** What a role held before a destructive change — enough to rebuild it. */
export type RoleSnapshot =
    | { role: 'hub'; workerIds: string[] }
    | { role: 'worker'; hubId: string }
    | { role: 'plain' };

export function snapshotRole(orchestration: OrchestrationRole): RoleSnapshot {
    if (orchestration?.role === 'hub') return { role: 'hub', workerIds: orchestration.workers.map((w) => w.sessionId) };
    if (orchestration?.role === 'worker') return { role: 'worker', hubId: orchestration.hub.sessionId };
    return { role: 'plain' };
}

export const DUTY_PRESET_KEYS = ['dutyCoding', 'dutyReview', 'dutyRelease'] as const;
export type DutyPresetKey = typeof DUTY_PRESET_KEYS[number];

/**
 * Preset duty text in every language the app ships (`en` and `zh-Hans` —
 * see `sources/text/index.ts`), not read through `t()`. A duty is written
 * into the session name in whatever language was active when it was picked,
 * so a chip highlight that only compares against the *current* language's
 * text would show an old pick as a 5th "custom" chip the moment the UI
 * language changes. This table exists purely so matching can check every
 * language at once; display still goes through `t('lmc.orchestration.<key>')`.
 */
export const DUTY_PRESET_TEXT: Record<DutyPresetKey, { zh: string; en: string }> = {
    dutyCoding: { zh: '编码', en: 'Coding' },
    dutyReview: { zh: '评审', en: 'Review' },
    dutyRelease: { zh: '回归部署', en: 'Regression & deploy' },
};

/** The preset key `text` matches in any shipped language, or null for a custom duty. */
export function dutyPresetKeyFor(text: string): DutyPresetKey | null {
    for (const key of DUTY_PRESET_KEYS) {
        const entry = DUTY_PRESET_TEXT[key];
        if (entry.zh === text || entry.en === text) return key;
    }
    return null;
}

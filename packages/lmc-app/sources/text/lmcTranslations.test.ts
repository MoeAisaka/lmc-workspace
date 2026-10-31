import { describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/persistence', () => ({ loadSettings: () => ({ settings: {} }) }));

import { en as defaultEn } from './_default';
import { en } from './translations/en';
import { zhHans } from './translations/zh-Hans';
import { getCurrentLanguage, getDateLocale, t } from './index';
import { getChangelogData } from '@/changelog/parser';
import { translateLmcServerMessage } from '@/utils/lmc/serverErrorText';

const CJK_RE = /[\u4e00-\u9fff]/;

function flattenLeaves(obj: Record<string, any>, prefix = ''): Map<string, string | ((...args: any[]) => string)> {
    const out = new Map<string, string | ((...args: any[]) => string)>();
    for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            for (const [subKey, subVal] of flattenLeaves(value, path)) {
                out.set(subKey, subVal);
            }
        } else {
            out.set(path, value);
        }
    }
    return out;
}

const SAMPLE_ARGS: Record<string, unknown> = {
    count: 2,
    n: 2,
    minutes: 5,
    hours: 2,
    days: 3,
    seconds: 10,
    percent: 50,
    pct: 75,
    status: 500,
    index: 1,
    total: 10,
    shown: 5,
    scanned: 4,
    samples: 6,
    intervals: 4,
    excluded: 1,
    value: 12,
    open: true,
    name: 'Demo',
    title: 'Dialog',
    field: 'Name',
    reason: 'Invalid',
    service: 'Claude',
    version: '1.2.139',
    time: '12:00',
    created: '2026-10-01',
    expires: '2026-11-01',
    when: '2m ago',
    elapsed: '1m',
    goal: 'Build',
    command: 'ls',
    verb: 'read',
    target: 'README.md',
    question: 'Continue?',
    root: '/workspace',
    path: 'src/index.ts',
    engine: 'Codex',
    model: 'gpt-5',
    work: 'background task',
    who: 'Agent',
    machine: 'dev-host',
    error: 'timeout',
    host: 'dev-host',
    limit: '50 MB',
    owner: 'alice',
    id: 'acc-1',
    records: '12',
    sessions: 3,
    read: '1.2K',
    write: '0.4K',
    label: '10/31 12:00',
    tokens: '4.5K',
    day: '10/31',
    input: '1K',
    output: '2K',
    since: '2026-10-01',
    date: 'Oct 31',
    points: '1.50',
    ambiguous: '0.25',
    last: '12:00',
    period: 'Today',
    daily: '12 MB',
    amount: '3.2K',
};

describe('LMC English localization completeness', () => {
    it('maintains 100% key and value-kind parity across _default, en, and zh-Hans', () => {
        const defMap = flattenLeaves(defaultEn);
        const enMap = flattenLeaves(en);
        const zhMap = flattenLeaves(zhHans);

        expect([...enMap.keys()].sort()).toEqual([...defMap.keys()].sort());
        expect([...zhMap.keys()].sort()).toEqual([...defMap.keys()].sort());

        for (const [key, defVal] of defMap) {
            expect(typeof enMap.get(key), `en type mismatch at ${key}`).toBe(typeof defVal);
            expect(typeof zhMap.get(key), `zh-Hans type mismatch at ${key}`).toBe(typeof defVal);
        }
    });

    it('contains zero CJK characters across all default/English translation strings and interpolations', () => {
        for (const [sourceName, catalog] of [['_default', defaultEn], ['en', en]] as const) {
            const leaves = flattenLeaves(catalog);
            const offenders: string[] = [];
            for (const [key, val] of leaves) {
                const rendered = typeof val === 'function' ? String(val(SAMPLE_ARGS)) : String(val);
                if (CJK_RE.test(rendered)) {
                    offenders.push(`${sourceName}:${key} -> ${rendered}`);
                }
            }
            expect(offenders).toEqual([]);
        }
    });

    it('uses English defaults for language, date locale, changelog, and server error mapping', () => {
        expect(getCurrentLanguage()).toBe('en');
        expect(getDateLocale()).toBe('en-US');
        expect(t('lmc.dialogs.usage')).toBe('Usage dashboard');

        const changelog = getChangelogData();
        expect(changelog.entries.length).toBeGreaterThan(0);
        for (const entry of changelog.entries) {
            expect(CJK_RE.test(entry.title)).toBe(false);
            expect(CJK_RE.test(entry.summary)).toBe(false);
            expect(CJK_RE.test(entry.markdown)).toBe(false);
        }

        expect(translateLmcServerMessage('操作失败', 'admin_required')).toBe('Administrator permission is required');
        expect(translateLmcServerMessage('账号或密码错误')).toBe('Incorrect username or password');
    });
});

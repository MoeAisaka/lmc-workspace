import { getCurrentLanguage } from '@/text';
import { ChangelogData, ChangelogEntry } from './types';

let changelogDataZh: ChangelogData | null = null;
let changelogDataEn: ChangelogData | null = null;

function loadChangelogJson(en: boolean): ChangelogData {
    try {
        return (en ? require('./changelog.en.json') : require('./changelog.json')) as ChangelogData;
    } catch (error) {
        console.warn('Changelog data not found, returning empty changelog');
        return { entries: [], latestTitle: '' };
    }
}

export function getChangelogData(): ChangelogData {
    if (!changelogDataZh) changelogDataZh = loadChangelogJson(false);
    if (!changelogDataEn) changelogDataEn = loadChangelogJson(true);
    return getCurrentLanguage() === 'zh-Hans' ? changelogDataZh : changelogDataEn;
}

export function getChangelogEntries(): ChangelogEntry[] {
    return getChangelogData().entries;
}

export function getLatestTitle(): string {
    if (!changelogDataZh) changelogDataZh = loadChangelogJson(false);
    return changelogDataZh.latestTitle;
}

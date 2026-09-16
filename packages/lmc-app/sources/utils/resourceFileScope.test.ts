import { describe, expect, it } from 'vitest';
import { isInsideSessionProject } from './resourceFileScope';

const root = '/Volumes/OC-WORK-4T/Work/MacMini Claude';

describe('session project containment', () => {
    it('accepts files under the project root', () => {
        expect(isInsideSessionProject(root + '/docs/plan.md', root)).toBe(true);
        expect(isInsideSessionProject(root, root)).toBe(true);
        expect(isInsideSessionProject(root + '//docs//plan.md', root + '/')).toBe(true);
    });

    it('rejects files the Agent will refuse to read', () => {
        expect(isInsideSessionProject('/tmp/lmc-publish-web-handoff.py', root)).toBe(false);
        // A sibling directory sharing the root's prefix is still outside it.
        expect(isInsideSessionProject('/Volumes/OC-WORK-4T/Work/MacMini Claude-old/x.md', root)).toBe(false);
        expect(isInsideSessionProject('/etc/passwd', root)).toBe(false);
    });

    it('treats relative paths as project-relative but refuses traversal', () => {
        expect(isInsideSessionProject('docs/plan.md', root)).toBe(true);
        expect(isInsideSessionProject('../secrets.env', root)).toBe(false);
    });

    it('reports nothing as contained when the project root is unknown', () => {
        expect(isInsideSessionProject(root + '/docs/plan.md', undefined)).toBe(false);
        expect(isInsideSessionProject('', root)).toBe(false);
    });
});

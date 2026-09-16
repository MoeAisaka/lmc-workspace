import { describe, expect, it, vi } from 'vitest';
import { navigateToSession, isSessionRoute } from './useNavigateToSession';

vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: {} }) } }));
vi.mock('@/track', () => ({ trackSessionSwitched: () => {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({}), usePathname: () => '/' }));

describe('navigateToSession', () => {
    it('replaces when already on a session, so the stack stops growing', () => {
        const router = { push: vi.fn(), replace: vi.fn() } as any;
        navigateToSession(router, 'abc', { replace: true });
        expect(router.replace).toHaveBeenCalledWith('/session/abc');
        expect(router.push).not.toHaveBeenCalled();
    });

    it('pushes when arriving from elsewhere, so back still means something', () => {
        const router = { push: vi.fn(), replace: vi.fn() } as any;
        navigateToSession(router, 'abc');
        expect(router.push).toHaveBeenCalledWith('/session/abc');
        expect(router.replace).not.toHaveBeenCalled();
    });

    it('encodes the id', () => {
        const router = { push: vi.fn(), replace: vi.fn() } as any;
        navigateToSession(router, 'a/b c');
        expect(router.push).toHaveBeenCalledWith('/session/a%2Fb%20c');
    });

    it('recognises which routes are session screens', () => {
        expect(isSessionRoute('/session/abc')).toBe(true);
        expect(isSessionRoute('/session/abc/info')).toBe(true);
        expect(isSessionRoute('/')).toBe(false);
        expect(isSessionRoute('/machine/m1')).toBe(false);
        expect(isSessionRoute('/new')).toBe(false);
    });
});

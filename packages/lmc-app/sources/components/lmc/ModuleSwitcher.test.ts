import React from 'react';
// @ts-expect-error local renderer has no declarations
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authState, accountMeMock, accountListMock } = vi.hoisted(() => ({
    authState: {
        current: null as null | {
            isAuthenticated: boolean;
            credentials: { token: string; secret: string } | null;
        },
    },
    accountMeMock: vi.fn(),
    accountListMock: vi.fn(),
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { dark: false } }),
}));

vi.mock('@/auth/AuthContext', () => ({
    useOptionalAuth: () => authState.current,
}));

vi.mock('@/sync/apiAccounts', () => ({
    accountMe: (...args: unknown[]) => accountMeMock(...args),
    accountList: (...args: unknown[]) => accountListMock(...args),
}));

import { ModuleSwitcher, isPrimaryOwnerAccount } from './ModuleSwitcher';
import type { LmcAccount } from '@/sync/apiAccounts';

class FakeElement {
    tagName: string;
    id = '';
    src = '';
    async = false;
    attributes = new Map<string, string>();
    parent: FakeContainer | null = null;

    constructor(tagName: string) {
        this.tagName = tagName.toLowerCase();
    }

    setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
        if (name === 'id') this.id = value;
    }

    getAttribute(name: string) {
        return this.attributes.get(name) ?? null;
    }

    remove() {
        if (!this.parent) return;
        this.parent.children = this.parent.children.filter((child) => child !== this);
        this.parent = null;
    }
}

class FakeContainer {
    children: FakeElement[] = [];

    append(node: FakeElement) {
        node.remove();
        node.parent = this;
        this.children.push(node);
    }
}

function installFakeDom() {
    const head = new FakeContainer();
    const body = new FakeContainer();
    const documentElement = { dataset: {} as Record<string, string> };

    const allNodes = () => [...head.children, ...body.children];
    const fakeDocument = {
        head,
        body,
        documentElement,
        createElement: (tag: string) => new FakeElement(tag),
        getElementById: (id: string) => allNodes().find((node) => node.id === id) ?? null,
        querySelectorAll: (selector: string) => {
            const tag = selector.toLowerCase();
            return allNodes().filter((node) => node.tagName === tag);
        },
    };
    vi.stubGlobal('document', fakeDocument);
    return fakeDocument;
}

const flush = async () => {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
};

describe('ModuleSwitcher owner-only access gate', () => {
    beforeEach(() => {
        authState.current = null;
        accountMeMock.mockReset();
        accountListMock.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('identifies only the earliest enabled admin as the primary owner', () => {
        const owner: LmcAccount = {
            id: 'acc-owner',
            username: 'owner',
            role: 'admin',
            enabled: true,
            accessVersion: 1,
        };
        const secondAdmin: LmcAccount = {
            id: 'acc-admin-2',
            username: 'co-admin',
            role: 'admin',
            enabled: true,
            accessVersion: 1,
        };
        const member: LmcAccount = {
            id: 'acc-member',
            username: 'teammate',
            role: 'member',
            enabled: true,
            accessVersion: 1,
        };
        const accounts = [owner, secondAdmin, member];

        expect(isPrimaryOwnerAccount(owner, accounts)).toBe(true);
        expect(isPrimaryOwnerAccount(secondAdmin, accounts)).toBe(false);
        expect(isPrimaryOwnerAccount(member, accounts)).toBe(false);
        expect(isPrimaryOwnerAccount({ ...owner, enabled: false }, accounts)).toBe(false);
    });

    it('never mounts the floating ball or loads hub-shell-script when signed out', async () => {
        const dom = installFakeDom();
        authState.current = { isAuthenticated: false, credentials: null };

        await act(async () => {
            create(React.createElement(ModuleSwitcher));
        });
        await flush();

        expect(accountMeMock).not.toHaveBeenCalled();
        expect(accountListMock).not.toHaveBeenCalled();
        expect(dom.querySelectorAll('hub-module-switcher')).toHaveLength(0);
        expect(dom.getElementById('hub-shell-script')).toBeNull();
    });

    it('keeps the floating ball hidden for invited member accounts without querying admin list', async () => {
        const dom = installFakeDom();
        authState.current = {
            isAuthenticated: true,
            credentials: { token: 'member-token', secret: 's' },
        };
        accountMeMock.mockResolvedValue({
            account: {
                id: 'acc-member',
                username: 'teammate',
                role: 'member',
                enabled: true,
                accessVersion: 1,
            },
            capabilities: {
                version: 1,
                fileSharing: true,
                sessionSharing: true,
                sharedExecution: true,
            },
        });

        await act(async () => {
            create(React.createElement(ModuleSwitcher));
        });
        await flush();

        expect(accountMeMock).toHaveBeenCalledTimes(1);
        expect(accountListMock).not.toHaveBeenCalled();
        expect(dom.querySelectorAll('hub-module-switcher')).toHaveLength(0);
        expect(dom.getElementById('hub-shell-script')).toBeNull();
    });

    it('keeps the floating ball hidden for secondary admin accounts', async () => {
        const dom = installFakeDom();
        authState.current = {
            isAuthenticated: true,
            credentials: { token: 'admin2-token', secret: 's' },
        };
        const owner: LmcAccount = {
            id: 'acc-owner',
            username: 'owner',
            role: 'admin',
            enabled: true,
            accessVersion: 1,
        };
        const secondAdmin: LmcAccount = {
            id: 'acc-admin-2',
            username: 'co-admin',
            role: 'admin',
            enabled: true,
            accessVersion: 1,
        };
        accountMeMock.mockResolvedValue({
            account: secondAdmin,
            capabilities: {
                version: 1,
                fileSharing: true,
                sessionSharing: true,
                sharedExecution: true,
            },
        });
        accountListMock.mockResolvedValue({ accounts: [owner, secondAdmin] });

        await act(async () => {
            create(React.createElement(ModuleSwitcher));
        });
        await flush();

        expect(accountMeMock).toHaveBeenCalledTimes(1);
        expect(accountListMock).toHaveBeenCalledTimes(1);
        expect(dom.querySelectorAll('hub-module-switcher')).toHaveLength(0);
        expect(dom.getElementById('hub-shell-script')).toBeNull();
    });

    it('mounts the floating ball for the primary owner and removes it immediately on sign-out', async () => {
        const dom = installFakeDom();
        const owner: LmcAccount = {
            id: 'acc-owner',
            username: 'owner',
            role: 'admin',
            enabled: true,
            accessVersion: 1,
        };
        authState.current = {
            isAuthenticated: true,
            credentials: { token: 'owner-token', secret: 's' },
        };
        accountMeMock.mockResolvedValue({
            account: owner,
            capabilities: {
                version: 1,
                fileSharing: true,
                sessionSharing: true,
                sharedExecution: true,
            },
        });
        accountListMock.mockResolvedValue({ accounts: [owner] });

        let renderer!: ReturnType<typeof create>;
        await act(async () => {
            renderer = create(React.createElement(ModuleSwitcher));
        });
        await flush();

        const switchers = dom.querySelectorAll('hub-module-switcher');
        expect(switchers).toHaveLength(1);
        expect(switchers[0].getAttribute('module')).toBe('lmc');
        expect(switchers[0].getAttribute('pet')).toBe('/pets/kurisu');
        expect(dom.getElementById('hub-shell-script')).not.toBeNull();
        expect(dom.documentElement.dataset.hubAppearance).toBe('light');

        authState.current = { isAuthenticated: false, credentials: null };
        await act(async () => {
            renderer.update(React.createElement(ModuleSwitcher));
        });
        await flush();

        expect(dom.querySelectorAll('hub-module-switcher')).toHaveLength(0);
        expect(dom.documentElement.dataset.hubAppearance).toBeUndefined();
    });
});

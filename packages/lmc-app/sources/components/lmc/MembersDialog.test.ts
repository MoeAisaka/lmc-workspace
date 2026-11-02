import React from 'react';
// @ts-expect-error local renderer has no declarations
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const { openResourceSharingList, clipboardSetString } = vi.hoisted(() => ({
    openResourceSharingList: vi.fn(),
    clipboardSetString: vi.fn().mockResolvedValue(true),
}));

vi.mock('react-native', () => ({
    View: 'View',
    ScrollView: 'ScrollView',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web' },
    useWindowDimensions: () => ({ width: 1200, height: 800 }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('expo-clipboard', () => ({
    setStringAsync: clipboardSetString,
}));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                surface: '#ffffff',
                surfaceHigh: '#f8f8f8',
                surfacePressed: '#f0f0f2',
                divider: '#eaeaea',
                text: '#111827',
                textSecondary: '#49454F',
                textLink: '#0060F0',
                textDestructive: '#F44336',
            },
        },
    }),
}));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/modal', () => ({ Modal: { show: vi.fn(), confirm: vi.fn().mockResolvedValue(true) } }));
vi.mock('@/sync/sync', () => ({
    sync: { getCredentials: () => ({ token: 'web-token-123', secret: 's' }) },
}));
vi.mock('@/sync/serverConfig', () => ({
    getServerUrl: () => 'https://lmc.moeaisaka.cn:11455/',
}));
vi.mock('./ResourceSharingDialog', () => ({
    openResourceSharingList,
}));
vi.mock('@/text', () => ({
    getDateLocale: () => 'zh-CN',
    t: (key: string, params?: Record<string, string>) =>
        ({
            'lmc.dialogs.closeDialog': `关闭${params?.title ?? ''}`,
            'lmc.sharing.membersTitle': '成员与权限',
            'lmc.sharing.membersIntro': '成员管理自己的资源共享；管理员可设置成员共享。',
            'lmc.sharing.inviteMember': '邀请成员',
            'lmc.sharing.refresh': '刷新',
            'lmc.sharing.inviteNotice': '邀请有效期 24 小时，只能加入一次。',
            'lmc.sharing.copyInviteLink': '复制邀请链接',
            'lmc.sharing.inviteCopied': '已复制邀请链接',
            'lmc.sharing.membersSection': '成员列表',
            'lmc.sharing.meBadge': '当前账号',
            'lmc.sharing.disabledBadge': '已停用',
            'lmc.sharing.roleAdmin': '管理员',
            'lmc.sharing.roleMember': '成员',
            'lmc.sharing.sharedResources': '共享资源',
            'lmc.sharing.makeMember': '设为成员',
            'lmc.sharing.makeAdmin': '设为管理员',
            'lmc.sharing.disable': '停用',
            'lmc.sharing.enable': '恢复',
            'lmc.sharing.inviteHistory': '邀请记录',
            'lmc.sharing.inviteHistoryEmpty': '暂无邀请记录，点击上方「邀请成员」可生成一次性加入链接。',
            'lmc.sharing.invitePending': '待加入',
            'lmc.sharing.inviteUsed': '已使用',
            'lmc.sharing.inviteRevoked': '已撤销',
            'lmc.sharing.inviteExpired': '已过期',
            'lmc.sharing.revoke': '撤销',
            'lmc.sharing.updateMemberConfirmTitle': '修改成员权限',
            'lmc.sharing.updateMemberConfirmBody': '确认修改？',
            'lmc.sharing.applyChanges': '应用修改',
            'lmc.sharing.actionFailed': '操作失败，请重试',
            'lmc.sharing.signInRequired': '请先登录 LMC',
        })[key] ?? key,
}));

import { accountRequest, accountUpdate } from '@/sync/apiAccounts';
import { MembersDialog } from './MembersDialog';

describe('accountRequest & MembersDialog', () => {
    it('omits Content-Type on bodyless POST/DELETE requests and includes it when a JSON body is present', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ id: 'inv-1', token: 'tok-abc' }),
        });
        vi.stubGlobal('fetch', fetchMock);

        try {
            await accountRequest('/v1/lmc/invitations', { method: 'POST' });
            const postInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
            const postHeaders = postInit.headers as Record<string, string>;
            expect(postHeaders.Authorization).toBe('Bearer web-token-123');
            expect(postHeaders['Content-Type']).toBeUndefined();

            await accountRequest('/v1/lmc/invitations/inv-1', { method: 'DELETE' });
            const deleteInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
            const deleteHeaders = deleteInit.headers as Record<string, string>;
            expect(deleteHeaders['Content-Type']).toBeUndefined();

            await accountUpdate(
                { id: 'u-2', username: 'bob', role: 'member', enabled: false, accessVersion: 2 },
                { role: 'member', enabled: true },
            );
            const patchInit = fetchMock.mock.calls[2]?.[1] as RequestInit;
            const patchHeaders = patchInit.headers as Record<string, string>;
            expect(patchHeaders['Content-Type']).toBe('application/json');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('renders structured member cards, empty invite state, creates invite links, and revokes active invitations', async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        let invitesState: Array<{
            id: string;
            createdById: string;
            expiresAt: string;
            consumedAt: string | null;
            revokedAt: string | null;
            token?: string;
        }> = [];

        const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
            const path = url.replace('https://lmc.moeaisaka.cn:11455/', '');
            const method = init?.method ?? 'GET';
            const headers = (init?.headers ?? {}) as Record<string, string>;

            if (path === '/v1/lmc/accounts/me') {
                return {
                    ok: true,
                    json: async () => ({
                        account: { id: 'u-admin', username: 'Yukina', role: 'admin', enabled: true, accessVersion: 1 },
                        capabilities: { version: 3, fileSharing: true, sessionSharing: true, sharedExecution: true },
                    }),
                };
            }
            if (path === '/v1/lmc/accounts') {
                return {
                    ok: true,
                    json: async () => ({
                        accounts: [
                            { id: 'u-admin', username: 'Yukina', role: 'admin', enabled: true, accessVersion: 1 },
                            { id: 'u-member', username: 'candidate-web-check', role: 'member', enabled: false, accessVersion: 2 },
                        ],
                    }),
                };
            }
            if (path === '/v1/lmc/invitations' && method === 'GET') {
                return { ok: true, json: async () => ({ invitations: invitesState }) };
            }
            if (path === '/v1/lmc/invitations' && method === 'POST') {
                expect(headers['Content-Type']).toBeUndefined();
                const created = {
                    id: 'inv-live-1',
                    createdById: 'u-admin',
                    expiresAt: '2099-01-01T00:00:00.000Z',
                    consumedAt: null,
                    revokedAt: null,
                    token: 'invite_secret_token_43chars',
                };
                invitesState = [created];
                return { ok: true, json: async () => created };
            }
            if (path === '/v1/lmc/invitations/inv-live-1' && method === 'DELETE') {
                expect(headers['Content-Type']).toBeUndefined();
                invitesState = [{ ...invitesState[0]!, revokedAt: '2026-11-02T08:00:00.000Z' }];
                return { ok: true, json: async () => ({ success: true }) };
            }
            throw new Error(`Unexpected request: ${method} ${path}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        let tree: any;
        try {
            await act(async () => {
                tree = create(React.createElement(MembersDialog, { onClose: vi.fn() }));
            });

            const textContent = () =>
                tree.root
                    .findAllByType('Text')
                    .map((n: any) => n.children.join(''))
                    .join(' | ');

            expect(textContent()).toContain('Yukina');
            expect(textContent()).toContain('当前账号');
            expect(textContent()).toContain('管理员');
            expect(textContent()).toContain('candidate-web-check');
            expect(textContent()).toContain('已停用');
            expect(textContent()).toContain('暂无邀请记录');

            // Sole enabled admin's "设为成员" is disabled to prevent self-lockout, while member's "设为管理员" is enabled
            const buttons = () => tree.root.findAllByType('Pressable');
            const findButton = (label: string) =>
                buttons().find((b: any) =>
                    b.findAllByType('Text').some((tNode: any) => tNode.children.join('') === label),
                );

            expect(findButton('设为成员')?.props.disabled).toBe(true);
            expect(findButton('设为管理员')?.props.disabled).toBe(false);
            expect(findButton('恢复')?.props.disabled).toBe(false);

            // Click "邀请成员"
            await act(async () => {
                findButton('邀请成员')!.props.onPress();
            });

            expect(textContent()).toContain('https://lmc.moeaisaka.cn:11455/#lmc-invite=invite_secret_token_43chars');
            expect(textContent()).toContain('待加入');
            expect(textContent()).not.toContain('暂无邀请记录');

            // Copy link
            await act(async () => {
                findButton('复制邀请链接')!.props.onPress();
            });
            expect(clipboardSetString).toHaveBeenCalledWith(
                'https://lmc.moeaisaka.cn:11455/#lmc-invite=invite_secret_token_43chars',
            );

            // Revoke active invite
            await act(async () => {
                findButton('撤销')!.props.onPress();
            });
            expect(textContent()).toContain('已撤销');
        } finally {
            if (tree) await act(async () => tree.unmount());
            vi.unstubAllGlobals();
        }
    });
});

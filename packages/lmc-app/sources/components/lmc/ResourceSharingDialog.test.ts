import React from 'react';
// @ts-expect-error local renderer has no declarations
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Session } from '@/sync/storageTypes';

const {
    modalShow,
    navigateToSession,
    ensureSessionsLoaded,
    listFileAssetsMock,
    getFileAssetMock,
    mockSessionsMap,
    mockMachinesMap,
} = vi.hoisted(() => ({
    modalShow: vi.fn(),
    navigateToSession: vi.fn(),
    ensureSessionsLoaded: vi.fn().mockResolvedValue(undefined),
    listFileAssetsMock: vi.fn().mockResolvedValue({ files: [], next: null }),
    getFileAssetMock: vi.fn(),
    mockSessionsMap: {} as Record<string, Session>,
    mockMachinesMap: {} as Record<string, Machine>,
}));

vi.mock('react-native', () => ({
    View: 'View',
    ScrollView: 'ScrollView',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    TextInput: 'TextInput',
    Platform: { OS: 'web' },
    useWindowDimensions: () => ({ width: 1280, height: 840 }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
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
vi.mock('@/components/FileIcon', () => ({ FileIcon: 'FileIcon' }));
vi.mock('@/components/Switch', () => ({ Switch: 'Switch' }));
vi.mock('@/modal', () => ({ Modal: { show: modalShow, confirm: vi.fn().mockResolvedValue(true) } }));
vi.mock('@/hooks/useNavigateToSession', () => ({
    useNavigateToSession: () => navigateToSession,
}));
vi.mock('@/sync/serverConfig', () => ({
    getServerUrl: () => 'https://lmc.moeaisaka.cn:11455/',
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        getCredentials: () => ({ token: 'web-token-123', secret: 's' }),
        ensureSessionsLoaded,
    },
}));
vi.mock('@/sync/apiFileAssets', () => ({
    listFileAssets: listFileAssetsMock,
    getFileAsset: getFileAssetMock,
}));
vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            sessions: mockSessionsMap,
            machines: mockMachinesMap,
            settings: { archivedSessionIds: [] },
        }),
    },
    useAllSessions: () => Object.values(mockSessionsMap),
    useAllMachines: () => Object.values(mockMachinesMap),
    useSession: (id: string) => (id ? mockSessionsMap[id] ?? null : null),
    useMachine: (id: string) => (id ? mockMachinesMap[id] ?? null : null),
}));
vi.mock('@/text', () => ({
    getDateLocale: () => 'zh-CN',
    t: (key: string, params?: Record<string, string | number>) => {
        const dict: Record<string, string> = {
            'session.newChat': '新对话',
            'common.save': '保存',
            'lmc.dialogs.closeDialog': `关闭${params?.title ?? ''}`,
            'lmc.list.offline': '离线',
            'lmc.sharing.settingsTitle': '共享设置',
            'lmc.sharing.resourceSharingTitle': '资源共享',
            'lmc.sharing.resourceSharingIntro': '仅展示权限管理所需的资源元数据，不包含加密内容。',
            'lmc.sharing.noManageableResources': '暂无可管理的资源。',
            'lmc.sharing.noMatchingResources': '没有匹配的共享资源。',
            'lmc.sharing.kindSession': '会话',
            'lmc.sharing.kindMachine': '设备',
            'lmc.sharing.kindFile': '文件',
            'lmc.sharing.sharedWithAccounts': '指定账号共享',
            'lmc.sharing.privateOnly': '独占',
            'lmc.sharing.badgeReadOnly': '只读',
            'lmc.sharing.badgeCollaborative': '可发言',
            'lmc.sharing.actionSend': '发言',
            'lmc.sharing.actionStop': '停止',
            'lmc.sharing.actionApprove': '单次审批',
            'lmc.sharing.actionExecute': '运行会话',
            'lmc.sharing.viewOnly': '仅查看',
            'lmc.sharing.filterAll': '全部',
            'lmc.sharing.filterShared': '已共享',
            'lmc.sharing.filterSessions': '会话',
            'lmc.sharing.filterDevices': '设备',
            'lmc.sharing.filterFiles': '文件',
            'lmc.sharing.resourceSearchPlaceholder': '搜索会话标题、设备、目录、文件名或成员…',
            'lmc.sharing.managingOwnerBanner': `正在管理成员 ${params?.owner ?? ''} 的资源共享`,
            'lmc.sharing.sharedBadgeCount': `已共享 · ${params?.count ?? 0} 人`,
            'lmc.sharing.sharedRecipientsSummary': `共享给：${params?.targets ?? ''}`,
            'lmc.sharing.notSharedYet': '未对其他成员开放',
            'lmc.sharing.openSession': '打开会话',
            'lmc.sharing.encryptedMemberSession': '成员私有会话（端到端加密）',
            'lmc.sharing.encryptedMemberDevice': '成员私有设备（端到端加密）',
            'lmc.sharing.encryptedMemberFile': '成员私有文件（端到端加密）',
            'lmc.sharing.archivedBadge': '已归档',
            'lmc.sharing.onlineBadge': '在线',
            'lmc.sharing.ownerSessionBody': `拥有者：${params?.owner ?? ''}`,
            'lmc.sharing.ownerMachineBody': `拥有者：${params?.owner ?? ''}`,
            'lmc.sharing.ownerFileBody': `拥有者：${params?.owner ?? ''}`,
            'lmc.sharing.shareWithMember': `共享给 ${params?.name ?? ''}`,
            'lmc.sharing.adminManagedToggle': '管理员托管共享策略',
            'lmc.sharing.revokeHint': '撤销后立即生效。',
            'lmc.sharing.reload': '重新加载',
            'lmc.sharing.savedNotice': '共享设置已保存',
            'lmc.sharing.actionFailed': '操作失败',
            'lmc.sharing.signInRequired': '请先登录',
        };
        return dict[key] ?? key;
    },
}));

import {
    ResourceSharingDialog,
    ResourceSharingList,
    describeManagedResource,
    formatGrantSummary,
    shortenResourceId,
    sortAndFilterManagedResources,
} from './ResourceSharingDialog';

function makeSession(overrides: Partial<Session> & { id: string }): Session {
    return {
        seq: 1,
        createdAt: 1_793_680_000_000,
        updatedAt: 1_793_682_000_000,
        active: true,
        activeAt: 1_793_682_000_000,
        metadata: {
            path: '/Volumes/OC-WORK-4T/Work/MacMini Claude',
            host: 'yukinamnideMini',
            homeDir: '/Volumes/OC-WORK-4T',
            flavor: 'agy',
            machineId: 'machine-macmini',
            summary: { text: '【产品】参考 dots 复盘 LMC 中枢与执行节点', updatedAt: 1_793_682_000_000 },
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

function makeMachine(overrides: Partial<Machine> & { id: string }): Machine {
    return {
        seq: 1,
        createdAt: 1_793_600_000_000,
        updatedAt: 1_793_682_000_000,
        active: true,
        activeAt: 1_793_682_000_000,
        metadata: {
            host: 'yukinamnideMini',
            platform: 'darwin',
            lmcCliVersion: '0.14.0',
            lmcHomeDir: '/Users/yukina-macmini/.lmc',
            homeDir: '/Users/yukina-macmini',
            displayName: 'MacMini',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        ...overrides,
    };
}

describe('ResourceSharingDialog helpers & UI', () => {
    beforeEach(() => {
        for (const k of Object.keys(mockSessionsMap)) delete mockSessionsMap[k];
        for (const k of Object.keys(mockMachinesMap)) delete mockMachinesMap[k];
        modalShow.mockReset();
        navigateToSession.mockReset();
        ensureSessionsLoaded.mockClear();
        listFileAssetsMock.mockReset().mockResolvedValue({ files: [], next: null });
        getFileAssetMock.mockReset();
    });

    it('describes sessions, devices, files, and E2E-encrypted member resources with human-readable titles', () => {
        const sessionId = 'cmto0clsmsd7g060u8dh1ud62';
        const machine = makeMachine({ id: 'machine-macmini' });
        const session = makeSession({ id: sessionId });

        const sessionDesc = describeManagedResource(
            { id: sessionId, kind: 'session', createdAt: '2026-11-03T04:00:00.000Z', active: true, size: null },
            {
                sessionsById: { [sessionId]: session },
                machinesById: { [machine.id]: machine },
                filesById: {},
            },
        );
        expect(sessionDesc.title).toBe('【产品】参考 dots 复盘 LMC 中枢与执行节点');
        expect(sessionDesc.contextLine).toBe('MacMini · Antigravity · ~/Work/MacMini Claude');
        expect(sessionDesc.shortId).toBe('cmto0c…ud62');
        expect(sessionDesc.isOnline).toBe(true);

        const machineDesc = describeManagedResource(
            { id: machine.id, kind: 'machine', createdAt: '2026-11-03T04:00:00.000Z', active: true, size: null },
            {
                sessionsById: {},
                machinesById: { [machine.id]: machine },
                filesById: {},
            },
        );
        expect(machineDesc.title).toBe('MacMini');
        expect(machineDesc.contextLine).toBe('darwin · 在线');

        const fileDesc = describeManagedResource(
            { id: 'file_9876543210abcdef1234', kind: 'file', createdAt: '2026-11-03T04:00:00.000Z', size: 1572864 },
            {
                sessionsById: {},
                machinesById: {},
                filesById: { file_9876543210abcdef1234: { name: 'quant-backtest-report.pdf', size: 1572864 } },
            },
        );
        expect(fileDesc.title).toBe('quant-backtest-report.pdf');
        expect(fileDesc.fileName).toBe('quant-backtest-report.pdf');

        const opaqueDesc = describeManagedResource(
            { id: 'cmtxopaque999999999999999', kind: 'session', createdAt: '2026-11-03T04:00:00.000Z', size: null },
            { sessionsById: {}, machinesById: {}, filesById: {} },
        );
        expect(opaqueDesc.title).toBe('成员私有会话（端到端加密）');
        expect(opaqueDesc.contextLine).toBe(shortenResourceId('cmtxopaque999999999999999'));
    });

    it('formats recipient grant summaries accurately instead of mislabeling private resources', () => {
        const nameOf = (id: string) => ({ 'u-bob': 'bob', 'u-alice': 'alice' }[id] ?? id);
        expect(formatGrantSummary('session', [], nameOf)).toBe('未对其他成员开放');
        expect(
            formatGrantSummary(
                'session',
                [
                    { accountId: 'u-bob', actions: ['read', 'send', 'stop'] },
                    { accountId: 'u-alice', actions: ['read'] },
                ],
                nameOf,
            ),
        ).toBe('共享给：bob（发言/停止）、alice（只读）');
        expect(
            formatGrantSummary('machine', [{ accountId: 'u-bob', actions: ['read', 'execute'] }], nameOf),
        ).toBe('共享给：bob（运行会话）');
    });

    it('sorts shared resources first, prioritizes sessions/devices ahead of files, and filters by tab and search query', () => {
        const sPriv = { id: 's-private', kind: 'session' as const, createdAt: '2026-11-03T05:00:00.000Z', size: null, grants: [] };
        const sShared = {
            id: 's-shared',
            kind: 'session' as const,
            createdAt: '2026-11-03T03:00:00.000Z',
            size: null,
            grants: [{ accountId: 'u-bob', actions: ['read', 'send'] }],
        };
        const fOld = { id: 'f-1', kind: 'file' as const, createdAt: '2026-11-03T06:00:00.000Z', size: 1024, grants: [] };

        const descriptors = new Map([
            [
                'session:s-private',
                {
                    kind: 'session',
                    id: 's-private',
                    shortId: 's-private',
                    title: '本地私有调试',
                    contextLine: 'MacBook · Codex',
                    isOnline: false,
                    isArchived: false,
                    sortTimestamp: 200,
                    searchText: '本地私有调试 macbook codex s-private',
                },
            ],
            [
                'session:s-shared',
                {
                    kind: 'session',
                    id: 's-shared',
                    shortId: 's-shared',
                    title: '黄金队列实盘监控',
                    contextLine: 'MacMini · Antigravity',
                    isOnline: true,
                    isArchived: false,
                    sortTimestamp: 100,
                    searchText: '黄金队列实盘监控 macmini antigravity s-shared',
                },
            ],
            [
                'file:f-1',
                {
                    kind: 'file',
                    id: 'f-1',
                    shortId: 'f-1',
                    title: 'notes.md',
                    contextLine: '1 KB',
                    isOnline: false,
                    isArchived: false,
                    sortTimestamp: 300,
                    searchText: 'notes.md 1 kb f-1',
                },
            ],
        ]);
        const nameOf = (id: string) => (id === 'u-bob' ? 'bob' : id);

        const allOrdered = sortAndFilterManagedResources([fOld, sPriv, sShared], descriptors, {}, nameOf, 'all', '');
        expect(allOrdered.map((r) => r.id)).toEqual(['s-shared', 's-private', 'f-1']);

        const onlyShared = sortAndFilterManagedResources([fOld, sPriv, sShared], descriptors, {}, nameOf, 'shared', '');
        expect(onlyShared.map((r) => r.id)).toEqual(['s-shared']);

        const byRecipient = sortAndFilterManagedResources([fOld, sPriv, sShared], descriptors, {}, nameOf, 'all', 'bob');
        expect(byRecipient.map((r) => r.id)).toEqual(['s-shared']);
    });

    it('renders ResourceSharingList with readable session titles, device/engine context, and hydrated grant badges', async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const sharedId = 'cmto0clsmsd7g060u8dh1ud62';
        const privateId = 'cmtpriv999999999999999999';
        mockMachinesMap['machine-macmini'] = makeMachine({ id: 'machine-macmini' });
        mockSessionsMap[sharedId] = makeSession({ id: sharedId });
        mockSessionsMap[privateId] = makeSession({
            id: privateId,
            active: false,
            customName: '量化回测只读实验',
            metadata: {
                path: '/Volumes/OC-WORK-4T/Work/Quant',
                host: 'yukinamnideMini',
                homeDir: '/Volumes/OC-WORK-4T',
                flavor: 'codex',
                machineId: 'machine-macmini',
            },
        });

        // Simulate legacy server response without inline `grants` so client hydration via `getSharing` is also exercised
        const fetchMock = vi.fn(async (url: string) => {
            const path = url.replace('https://lmc.moeaisaka.cn:11455/', '');
            if (path === '/v1/lmc/sharing/resources') {
                return {
                    ok: true,
                    json: async () => ({
                        resources: [
                            { id: privateId, kind: 'session', createdAt: '2026-11-03T05:00:00.000Z', size: null },
                            { id: sharedId, kind: 'session', createdAt: '2026-11-03T04:00:00.000Z', size: null },
                        ],
                    }),
                };
            }
            if (path === '/v1/lmc/accounts/directory') {
                return {
                    ok: true,
                    json: async () => ({
                        accounts: [
                            { id: 'u-admin', username: 'Yukina' },
                            { id: 'u-bob', username: 'bob' },
                        ],
                    }),
                };
            }
            if (path === '/v1/lmc/accounts/me') {
                return {
                    ok: true,
                    json: async () => ({
                        account: { id: 'u-admin', username: 'Yukina', role: 'admin', enabled: true, accessVersion: 1 },
                        capabilities: { version: 3, fileSharing: true, sessionSharing: true, sharedExecution: true },
                    }),
                };
            }
            if (path === `/v1/lmc/sharing/session/${sharedId}`) {
                return {
                    ok: true,
                    json: async () => ({
                        kind: 'session',
                        resourceId: sharedId,
                        ownerAccountId: 'u-admin',
                        version: 1,
                        adminManaged: false,
                        canManage: true,
                        sharingSupported: true,
                        unavailableReason: null,
                        grants: [{ accountId: 'u-bob', actions: ['read', 'send', 'stop'] }],
                    }),
                };
            }
            if (path === `/v1/lmc/sharing/session/${privateId}`) {
                return {
                    ok: true,
                    json: async () => ({
                        kind: 'session',
                        resourceId: privateId,
                        ownerAccountId: 'u-admin',
                        version: 0,
                        adminManaged: false,
                        canManage: true,
                        sharingSupported: true,
                        unavailableReason: null,
                        grants: [],
                    }),
                };
            }
            throw new Error(`Unexpected URL: ${path}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        let tree: any;
        try {
            await act(async () => {
                tree = create(React.createElement(ResourceSharingList, { onClose: vi.fn() }));
            });
            // Flush microtasks for async grant hydration
            await act(async () => {
                await Promise.resolve();
                await Promise.resolve();
            });

            const text = () =>
                tree.root
                    .findAllByType('Text')
                    .map((n: any) => n.children.join(''))
                    .join(' | ');

            expect(text()).toContain('【产品】参考 dots 复盘 LMC 中枢与执行节点');
            expect(text()).toContain('MacMini · Antigravity · ~/Work/MacMini Claude');
            expect(text()).toContain('已共享 · 1 人');
            expect(text()).toContain('共享给：bob（发言/停止）');
            expect(text()).toContain('量化回测只读实验');
            expect(text()).toContain('独占');
            expect(text()).toContain('未对其他成员开放');
            // Never render opaque raw "会话 cmto0clsmsd7g060u8dh1ud62" title
            expect(text()).not.toContain(`会话 ${sharedId}`);
            expect(ensureSessionsLoaded).toHaveBeenCalledWith([privateId, sharedId]);
        } finally {
            if (tree) await act(async () => tree.unmount());
            vi.unstubAllGlobals();
        }
    });

    it('renders ResourceSharingDialog target session identity card and quick Open Session button', async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const sessionId = 'cmto0clsmsd7g060u8dh1ud62';
        mockMachinesMap['machine-macmini'] = makeMachine({ id: 'machine-macmini' });
        mockSessionsMap[sessionId] = makeSession({ id: sessionId });
        const onClose = vi.fn();

        const fetchMock = vi.fn(async (url: string) => {
            const path = url.replace('https://lmc.moeaisaka.cn:11455/', '');
            if (path === `/v1/lmc/sharing/session/${sessionId}`) {
                return {
                    ok: true,
                    json: async () => ({
                        kind: 'session',
                        resourceId: sessionId,
                        ownerAccountId: 'u-admin',
                        version: 2,
                        adminManaged: false,
                        canManage: true,
                        sharingSupported: true,
                        unavailableReason: null,
                        grants: [{ accountId: 'u-bob', actions: ['read', 'send'] }],
                    }),
                };
            }
            if (path === '/v1/lmc/accounts/directory') {
                return {
                    ok: true,
                    json: async () => ({
                        accounts: [
                            { id: 'u-admin', username: 'Yukina' },
                            { id: 'u-bob', username: 'bob' },
                        ],
                    }),
                };
            }
            if (path === '/v1/lmc/accounts/me') {
                return {
                    ok: true,
                    json: async () => ({
                        account: { id: 'u-admin', username: 'Yukina', role: 'admin', enabled: true, accessVersion: 1 },
                        capabilities: { version: 3, fileSharing: true, sessionSharing: true, sharedExecution: true },
                    }),
                };
            }
            if (path === `/v1/lmc/sharing/session/${sessionId}/audit`) {
                return { ok: true, json: async () => ({ events: [] }) };
            }
            throw new Error(`Unexpected URL: ${path}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        let tree: any;
        try {
            await act(async () => {
                tree = create(React.createElement(ResourceSharingDialog, { kind: 'session', id: sessionId, onClose }));
            });

            const text = () =>
                tree.root
                    .findAllByType('Text')
                    .map((n: any) => n.children.join(''))
                    .join(' | ');

            expect(text()).toContain('【产品】参考 dots 复盘 LMC 中枢与执行节点');
            expect(text()).toContain('MacMini · Antigravity · ~/Work/MacMini Claude · cmto0c…ud62');
            expect(text()).toContain('打开会话');

            const saveBtn = tree.root
                .findAllByType('Pressable')
                .find((b: any) => b.findAllByType('Text').some((tNode: any) => tNode.children.join('') === '保存'));
            const reloadBtn = tree.root
                .findAllByType('Pressable')
                .find((b: any) => b.findAllByType('Text').some((tNode: any) => tNode.children.join('') === '重新加载'));
            expect(saveBtn).toBeDefined();
            expect(reloadBtn).toBeDefined();
            const saveStyle = saveBtn!.props.style({ pressed: false });
            const reloadStyle = reloadBtn!.props.style({ pressed: false });
            expect(saveStyle).toMatchObject({ minHeight: 36, minWidth: 76, paddingVertical: 7, borderWidth: 1 });
            expect(reloadStyle).toMatchObject({ minHeight: 36, paddingVertical: 7, borderWidth: 1 });
            expect(saveBtn!.findByType('Text').props.style.lineHeight).toBe(20);
            expect(reloadBtn!.findByType('Text').props.style.lineHeight).toBe(20);

            const openBtn = tree.root
                .findAllByType('Pressable')
                .find((b: any) => b.findAllByType('Text').some((tNode: any) => tNode.children.join('') === '打开会话'));
            expect(openBtn).toBeDefined();
            await act(async () => {
                openBtn!.props.onPress();
            });
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(navigateToSession).toHaveBeenCalledWith(sessionId);
        } finally {
            if (tree) await act(async () => tree.unmount());
            vi.unstubAllGlobals();
        }
    });
});

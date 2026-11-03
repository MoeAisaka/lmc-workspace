import React from 'react';
// @ts-expect-error local renderer has no declarations
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    modalShow,
    routerPush,
    navigateToSession,
    accountMeMock,
    accountListMock,
    accountDirectoryMock,
    accountRequestMock,
    getSharingMock,
    putSharingMock,
    mockMachines,
    mockSessions,
} = vi.hoisted(() => ({
    modalShow: vi.fn(),
    routerPush: vi.fn(),
    navigateToSession: vi.fn(),
    accountMeMock: vi.fn(),
    accountListMock: vi.fn(),
    accountDirectoryMock: vi.fn(),
    accountRequestMock: vi.fn(),
    getSharingMock: vi.fn(),
    putSharingMock: vi.fn(),
    mockMachines: [
        {
            id: 'm-mini',
            active: true,
            activeAt: 1_790_000_000_000,
            metadataVersion: 1,
            daemonStateVersion: 1,
            metadata: {
                displayName: 'MacMini',
                host: 'macmini.local',
                platform: 'darwin',
                managedUpgrades: false,
            },
            daemonState: null,
        },
    ] as any[],
    mockSessions: [
        {
            id: 's-alpha',
            seq: 1,
            createdAt: 1_790_000_000_000,
            updatedAt: 1_790_000_100_000,
            active: true,
            activeAt: 1_790_000_100_000,
            metadataVersion: 1,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            metadata: {
                path: '/work/lmc',
                host: 'macmini.local',
                machineId: 'm-mini',
                name: '设置窗口改造会话',
                flavor: 'claude',
            },
            agentState: null,
        },
    ] as any[],
}));

vi.mock('react-native', () => ({
    View: 'View',
    ScrollView: 'ScrollView',
    Pressable: 'Pressable',
    TextInput: 'TextInput',
    ActivityIndicator: 'ActivityIndicator',
    RefreshControl: 'RefreshControl',
    Image: 'RNImage',
    Keyboard: { dismiss: vi.fn() },
    Appearance: { getColorScheme: () => 'light', setColorScheme: vi.fn() },
    Platform: {
        OS: 'web',
        select: (map: Record<string, unknown>) => map.web ?? map.default,
    },
    useWindowDimensions: () => ({ width: 1280, height: 900 }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('expo-image', () => ({ Image: 'ExpoImage' }));
vi.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn().mockResolvedValue(true) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn() }));
vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPush, back: vi.fn() }),
    useLocalSearchParams: () => ({}),
    Stack: { Screen: 'StackScreen' },
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('react-native-reanimated', () => ({
    default: { View: 'AnimatedView' },
    Easing: { out: (fn: any) => fn, in: (fn: any) => fn, cubic: {} },
    runOnJS: (fn: any) => fn,
    useSharedValue: (v: any) => ({ value: v }),
    useDerivedValue: (fn: () => any) => ({ value: fn() }),
    useAnimatedStyle: (fn: () => any) => fn(),
    withTiming: (v: any) => v,
}));
vi.mock('react-native-unistyles', () => {
    const theme = {
        dark: false,
        personalization: { messageGap: 8 },
        colors: {
            surface: '#ffffff',
            surfaceHigh: '#f8f8f8',
            surfacePressed: '#f0f0f2',
            divider: '#e5e7eb',
            text: '#111827',
            textSecondary: '#6b7280',
            textLink: '#0060F0',
            textDestructive: '#dc2626',
            success: '#34C759',
            groupped: { background: '#f9fafb', chevron: '#9ca3af' },
            status: { connected: '#34C759', connecting: '#0060F0', disconnected: '#9ca3af' },
            glass: { overlay: '#fff', backgroundStrong: '#fff', border: '#eee', shadow: '#000' },
            switch: { track: { active: '#2563eb', inactive: '#d1d5db' }, thumb: { active: '#fff' } },
        },
    };
    return {
        StyleSheet: {
            hairlineWidth: 1,
            absoluteFillObject: {},
            create: (fn: any) => (typeof fn === 'function' ? fn(theme) : fn),
        },
        UnistylesRuntime: {
            setAdaptiveThemes: vi.fn(),
            setTheme: vi.fn(),
            setRootViewBackgroundColor: vi.fn(),
        },
        useUnistyles: () => ({ theme }),
    };
});
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/Switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/FileIcon', () => ({ FileIcon: 'FileIcon' }));
vi.mock('@/components/MobileGlass', () => ({ MobileGlassSurface: 'MobileGlassSurface' }));
vi.mock('@/components/OAuthView', () => ({ OAuthView: 'OAuthView' }));
vi.mock('@/components/RuntimeUpdatesPanel', () => ({
    RuntimeUpdatesPanel: 'RuntimeUpdatesPanel',
    RuntimeUpdatesRows: 'RuntimeUpdatesRows',
}));
vi.mock('@/components/lmc/DetailSummary', () => ({ DetailSummary: 'DetailSummary' }));
vi.mock('@/components/lmc/settings/ProfileSection', () => ({ ProfileSection: 'ProfileSection' }));
vi.mock('@/app/(app)/settings/appearance', () => ({
    default: () => React.createElement('View', { testID: 'appearance-pane' }),
}));
vi.mock('@/app/(app)/settings/agents', () => ({
    default: () => React.createElement('View', { testID: 'agents-pane' }),
}));
vi.mock('@/app/(app)/changelog', () => ({
    default: () => React.createElement('View', { testID: 'changelog-screen-body' }),
}));
vi.mock('@/modal', () => ({
    Modal: { show: modalShow, confirm: vi.fn().mockResolvedValue(true), alert: vi.fn(), prompt: vi.fn() },
}));
vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({ credentials: { token: 'tok', secret: 'sec' }, logout: vi.fn() }),
}));
vi.mock('@/hooks/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: vi.fn(), isLoading: false }),
}));
vi.mock('@/hooks/useMultiClick', () => ({ useMultiClick: (cb: () => void) => cb }));
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: () => navigateToSession }));
vi.mock('@/utils/webInputProbeBootstrap', () => ({
    clearWebInputProbeQuery: vi.fn(),
    setWebInputProbeEnabled: vi.fn(),
    webInputProbeQueryEnabled: () => false,
}));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://lmc.moeaisaka.cn:11455' }));
vi.mock('@/sync/apiServices', () => ({ disconnectService: vi.fn(), connectService: vi.fn() }));
vi.mock('@/sync/apiFileAssets', () => ({
    listFileAssets: vi.fn().mockResolvedValue({ files: [], next: null }),
    getFileAsset: vi.fn(),
}));
vi.mock('@/sync/ops', () => ({
    machineStopDaemon: vi.fn(),
    machineUpdateMetadata: vi.fn(),
    machineDelete: vi.fn(),
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        refreshProfile: vi.fn(),
        refreshMachines: vi.fn(),
        ensureSessionsLoaded: vi.fn().mockResolvedValue(undefined),
        getCredentials: () => ({ token: 'tok', secret: 'sec' }),
    },
}));
vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            sessions: Object.fromEntries(mockSessions.map((s) => [s.id, s])),
            machines: Object.fromEntries(mockMachines.map((m) => [m.id, m])),
        }),
    },
    useProfile: () => ({ id: 'u-admin', firstName: 'Alice', connectedServices: [] }),
    useLocalSettingMutable: () => [false, vi.fn()],
    useSettingMutable: () => [{}, vi.fn()],
    useSetting: () => 'blue',
    useAllMachines: () => mockMachines,
    useAllSessions: () => mockSessions,
    useSessions: () => mockSessions,
    useMachine: (id: string) => mockMachines.find((m) => m.id === id) ?? null,
    useSession: (id: string) => mockSessions.find((s) => s.id === id) ?? null,
}));
vi.mock('@/sync/apiAccounts', () => ({
    accountMe: accountMeMock,
    accountList: accountListMock,
    accountDirectory: accountDirectoryMock,
    accountRequest: accountRequestMock,
    accountUpdate: vi.fn(),
    getSharing: getSharingMock,
    putSharing: putSharingMock,
}));
vi.mock('@/text', () => ({
    getDateLocale: () => 'zh-CN',
    t: (key: string, params?: Record<string, unknown>) =>
        ({
            'common.back': '返回',
            'common.save': '保存',
            'common.cancel': '取消',
            'common.rename': '重命名',
            'common.delete': '删除',
            'settings.title': '设置',
            'settings.machines': '设备',
            'settings.account': '账户',
            'tabs.sessions': '会话',
            'status.online': '在线',
            'status.offline': '离线',
            'lmc.settings.close': '关闭设置',
            'lmc.settings.search': '搜索设置',
            'lmc.settings.general': '常规',
            'lmc.settings.generalKeywords': '外观',
            'lmc.settings.devices': '设备与 Agent 升级',
            'lmc.settings.devicesKeywords': '升级',
            'lmc.settings.agents': 'Agent 默认参数',
            'lmc.settings.agentsKeywords': '模型',
            'lmc.settings.account': '账户与设备授权',
            'lmc.settings.accountKeywords': '账号 共享',
            'lmc.settings.about': '关于',
            'lmc.settings.aboutKeywords': '更新日志',
            'lmc.dialogs.closeDialog': `关闭${params?.title ?? ''}`,
            'lmc.dialogs.changelog': '更新日志',
            'lmc.dialogs.machineDetails': '设备详情',
            'lmc.about.title': '关于 Link my Cli',
            'lmc.about.changelog': '更新日志',
            'lmc.about.changelogSubtitle': '看看最近改了什么',
            'lmc.about.webVersion': '网页版本',
            'lmc.about.localBuild': '本地构建',
            'lmc.about.developerMode': '开发者模式',
            'lmc.about.developerModeSubtitle': '',
            'lmc.devices.section': '设备',
            'lmc.devices.detail': '设备详情',
            'lmc.devices.stopDaemon': '停止守护进程',
            'lmc.account.sharingSection': '共享与成员',
            'lmc.account.mySharing': '我的共享',
            'lmc.account.mySharingSubtitle': '',
            'lmc.account.members': '成员与权限',
            'lmc.account.membersSubtitle': '',
            'lmc.account.connectClaude': '连接 Claude Code 账号',
            'lmc.sharing.membersTitle': '成员与权限',
            'lmc.sharing.resourceSharingTitle': '资源共享',
            'lmc.sharing.sharedResources': '共享资源',
            'lmc.sharing.settingsTitle': '共享设置',
            'lmc.sharing.openSession': '打开会话',
            'lmc.sharing.kindSession': '会话',
            'lmc.sharing.kindMachine': '设备',
            'lmc.sharing.privateOnly': '仅自己可见',
        }[key] ?? key),
}));

import { LmcSettingsDialog } from './LmcSettingsDialog';
import { UtilityDialog } from '../UtilityDialog';

describe('LmcSettingsDialog single-window navigation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                json: async () => ({ devices: [] }),
            })),
        );
        accountMeMock.mockResolvedValue({
            account: { id: 'u-admin', username: 'alice', role: 'admin', enabled: true, accessVersion: 1 },
            capabilities: { version: 1, fileSharing: true, sessionSharing: true, sharedExecution: true },
        });
        accountListMock.mockResolvedValue({
            accounts: [
                { id: 'u-admin', username: 'alice', role: 'admin', enabled: true, accessVersion: 1 },
                { id: 'u-bob', username: 'bob', role: 'member', enabled: true, accessVersion: 1 },
            ],
        });
        accountDirectoryMock.mockResolvedValue({
            accounts: [
                { id: 'u-admin', username: 'alice' },
                { id: 'u-bob', username: 'bob' },
            ],
        });
        accountRequestMock.mockImplementation(async (url: string) => {
            if (url === '/v1/lmc/invitations') {
                return { invitations: [] };
            }
            if (url.startsWith('/v1/lmc/sharing/resources')) {
                return {
                    resources: [
                        {
                            id: 's-alpha',
                            kind: 'session',
                            createdAt: '2026-11-03T07:00:00.000Z',
                            updatedAt: '2026-11-03T07:10:00.000Z',
                            grants: [],
                        },
                    ],
                };
            }
            if (url.endsWith('/audit')) {
                return { events: [] };
            }
            return {};
        });
        getSharingMock.mockImplementation(async (kind: string, id: string) => ({
            kind,
            id,
            ownerAccountId: 'u-admin',
            canManage: true,
            sharingSupported: true,
            adminManaged: false,
            grants: [],
        }));
    });

    it('opens Changelog in-place inside About without spawning a new Modal or closing Settings', async () => {
        const onClose = vi.fn();
        let tree: any;
        await act(async () => {
            tree = create(React.createElement(LmcSettingsDialog, { section: 'about', onClose }));
        });

        expect(tree.root.findAllByProps({ testID: 'settings-subpage-header' })).toHaveLength(0);
        const changelogRow = tree.root.findAllByType('Item').find((n: any) => n.props.title === '更新日志');
        expect(changelogRow).toBeDefined();

        await act(async () => {
            changelogRow.props.onPress();
        });

        expect(modalShow).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(tree.root.findAllByProps({ testID: 'lmc-settings-dialog' })).toHaveLength(1);
        expect(tree.root.findByProps({ testID: 'settings-subpage-header' })).toBeDefined();
        expect(tree.root.findByProps({ testID: 'changelog-dialog' })).toBeDefined();
        expect(tree.root.findByProps({ testID: 'changelog-screen-body' })).toBeDefined();
        expect(
            tree.root.findAllByProps({ accessibilityLabel: '关闭更新日志' }),
        ).toHaveLength(0);

        const backButton = tree.root.findByProps({ testID: 'settings-back-button' });
        await act(async () => {
            backButton.props.onPress();
        });

        expect(tree.root.findAllByProps({ testID: 'settings-subpage-header' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'changelog-dialog' })).toHaveLength(0);

        await act(async () => tree.unmount());
        vi.unstubAllGlobals();
    });

    it('drills Devices -> Machine Details -> Sharing Settings inside one window and closes Settings when opening a session', async () => {
        const onClose = vi.fn();
        let tree: any;
        await act(async () => {
            tree = create(React.createElement(LmcSettingsDialog, { section: 'devices', onClose }));
        });

        const deviceCardHeader = tree.root.findAllByType('Item').find((n: any) => n.props.title === 'MacMini');
        await act(async () => {
            deviceCardHeader.props.onPress();
        });

        const detailItem = tree.root.findAllByType('Item').find((n: any) => n.props.title === '设备详情');
        expect(detailItem).toBeDefined();
        await act(async () => {
            detailItem.props.onPress();
        });
        await act(async () => {
            await Promise.resolve();
        });

        expect(modalShow).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(tree.root.findByProps({ testID: 'machine-dialog' })).toBeDefined();

        const activeSubpage = tree.root.findByProps({ testID: 'settings-active-subpage' });
        const sharingRow = activeSubpage
            .findAllByType('Item')
            .find((n: any) => n.props.title === '共享设置');
        expect(sharingRow).toBeDefined();

        await act(async () => {
            sharingRow.props.onPress();
        });
        await act(async () => {
            await Promise.resolve();
        });

        expect(modalShow).not.toHaveBeenCalled();
        expect(tree.root.findByProps({ testID: 'resource-sharing-dialog' })).toBeDefined();

        // Pop 1 level back to Machine Details
        await act(async () => {
            tree.root.findByProps({ testID: 'settings-back-button' }).props.onPress();
        });
        expect(tree.root.findAllByProps({ testID: 'resource-sharing-dialog' })).toHaveLength(0);
        expect(tree.root.findByProps({ testID: 'machine-dialog' })).toBeDefined();

        // Clicking a session row closes the Settings dialog and navigates to that session
        const sessionRow = tree.root
            .findByProps({ testID: 'settings-active-subpage' })
            .findAllByType('Item')
            .find((n: any) => n.props.title === '设置窗口改造会话');
        expect(sessionRow).toBeDefined();
        await act(async () => {
            sessionRow.props.onPress();
        });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(navigateToSession).toHaveBeenCalledWith('s-alpha');

        await act(async () => tree.unmount());
        vi.unstubAllGlobals();
    });

    it('supports 3-level Account -> Members -> Member Resources -> Sharing Settings navigation, breadcrumb jump, Connect Claude, and tab reset', async () => {
        const onClose = vi.fn();
        let tree: any;
        await act(async () => {
            tree = create(React.createElement(LmcSettingsDialog, { section: 'account', onClose }));
            await Promise.resolve();
        });

        // Connect Claude stays in-window instead of pushing a route
        const connectClaudeItem = tree.root
            .findByProps({ testID: 'settings-root-pane' })
            .findAllByType('Item')
            .find((n: any) => n.props.title === '连接 Claude Code 账号');
        expect(connectClaudeItem).toBeDefined();
        await act(async () => {
            connectClaudeItem.props.onPress();
        });
        expect(routerPush).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(tree.root.findByProps({ testID: 'settings-subpage-header' })).toBeDefined();

        await act(async () => {
            tree.root.findByProps({ testID: 'settings-back-button' }).props.onPress();
        });

        // Level 1: Members
        const membersItem = tree.root
            .findByProps({ testID: 'settings-root-pane' })
            .findAllByType('Item')
            .find((n: any) => n.props.title === '成员与权限');
        await act(async () => {
            membersItem.props.onPress();
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(modalShow).not.toHaveBeenCalled();
        expect(tree.root.findByProps({ testID: 'members-dialog' })).toBeDefined();

        // Level 2: Member's shared resources (bob)
        const sharedResourcesButtons = tree.root
            .findByProps({ testID: 'settings-active-subpage' })
            .findAllByType('Pressable')
            .filter((node: any) =>
                node.findAllByType('Text').some((tNode: any) => tNode.children.join('') === '共享资源'),
            );
        expect(sharedResourcesButtons.length).toBeGreaterThanOrEqual(2);
        await act(async () => {
            sharedResourcesButtons[1].props.onPress();
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(modalShow).not.toHaveBeenCalled();
        expect(tree.root.findByProps({ testID: 'resource-sharing-list' })).toBeDefined();

        // Level 3: Resource sharing settings for s-alpha
        const sessionCard = tree.root
            .findByProps({ testID: 'settings-active-subpage' })
            .findAllByType('Pressable')
            .find((node: any) =>
                node.findAllByType('Text').some((tNode: any) => tNode.children.join('') === '设置窗口改造会话'),
            );
        expect(sessionCard).toBeDefined();
        await act(async () => {
            sessionCard.props.onPress();
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(modalShow).not.toHaveBeenCalled();
        expect(tree.root.findByProps({ testID: 'resource-sharing-dialog' })).toBeDefined();

        const headerTexts = tree.root
            .findByProps({ testID: 'settings-subpage-header' })
            .findAllByType('Text')
            .map((n: any) => n.children.join(''));
        expect(headerTexts).toEqual(['返回', '账户', '成员与权限', 'bob · 共享资源', '共享设置']);

        // Jump straight back to Level 1 via breadcrumb
        const membersCrumb = tree.root
            .findByProps({ testID: 'settings-subpage-header' })
            .findAllByType('Pressable')
            .find((node: any) =>
                node.findAllByType('Text').some((tNode: any) => tNode.children.join('') === '成员与权限'),
            );
        await act(async () => {
            membersCrumb.props.onPress();
        });
        expect(tree.root.findAllByProps({ testID: 'resource-sharing-dialog' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'resource-sharing-list' })).toHaveLength(0);
        expect(tree.root.findByProps({ testID: 'members-dialog' })).toBeDefined();

        // Switching top-level tab resets subpage stack
        await act(async () => {
            tree.root.findByProps({ testID: 'settings-tab-about' }).props.onPress();
        });
        expect(tree.root.findAllByProps({ testID: 'settings-subpage-header' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'members-dialog' })).toHaveLength(0);

        await act(async () => tree.unmount());
        vi.unstubAllGlobals();
    });

    it('keeps standalone UtilityDialog chrome intact when rendered outside LmcSettingsDialog', async () => {
        const onClose = vi.fn();
        let tree: any;
        await act(async () => {
            tree = create(
                React.createElement(UtilityDialog, {
                    title: '共享设置',
                    onClose,
                    testID: 'standalone-utility',
                    children: React.createElement('View', { testID: 'standalone-body' }),
                }),
            );
        });
        const closeBtn = tree.root.findByProps({ accessibilityLabel: '关闭共享设置' });
        expect(closeBtn).toBeDefined();
        await act(async () => {
            closeBtn.props.onPress();
        });
        expect(onClose).toHaveBeenCalledTimes(1);
        await act(async () => tree.unmount());
        vi.unstubAllGlobals();
    });
});

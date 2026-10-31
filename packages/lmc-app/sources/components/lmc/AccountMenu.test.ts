import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
// @ts-expect-error local renderer has no declarations
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const { openLmcSettings, openUsage, openChangelog, openMembers, openResourceSharingList, accountMe } = vi.hoisted(() => ({
    openLmcSettings: vi.fn(),
    openUsage: vi.fn(),
    openChangelog: vi.fn(),
    openMembers: vi.fn(),
    openResourceSharingList: vi.fn(),
    accountMe: vi.fn(),
}));

vi.mock('react-native', () => ({
    View: 'View',
    ScrollView: 'ScrollView',
    Pressable: 'Pressable',
    Platform: { OS: 'web' },
    useWindowDimensions: () => ({ width: 1200, height: 800 }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 1,
        create: (fn: (theme: any) => any) => fn({
            colors: {
                surface: '#fff',
                surfacePressed: '#f3f4f6',
                divider: '#e5e7eb',
                text: '#111827',
                textSecondary: '#6b7280',
                textDestructive: '#dc2626',
                switch: { track: { active: '#2563eb', inactive: '#d1d5db' }, thumb: { active: '#fff' } },
            },
        }),
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                surfacePressed: '#f3f4f6',
                divider: '#e5e7eb',
                text: '#111827',
                textSecondary: '#6b7280',
                textDestructive: '#dc2626',
                switch: { track: { active: '#2563eb', inactive: '#d1d5db' }, thumb: { active: '#fff' } },
            },
        },
    }),
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
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/lmc/settings/ProfileSection', () => ({ ProfileSection: 'ProfileSection' }));
vi.mock('@/modal', () => ({ Modal: { show: vi.fn(), confirm: vi.fn(), alert: vi.fn() } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: { token: 't', secret: 's' }, logout: vi.fn() }) }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('@/utils/webInputProbeBootstrap', () => ({
    clearWebInputProbeQuery: vi.fn(),
    setWebInputProbeEnabled: vi.fn(),
    webInputProbeQueryEnabled: () => false,
}));
vi.mock('@/hooks/useMultiClick', () => ({ useMultiClick: (cb: () => void) => cb }));
vi.mock('@/sync/storage', () => ({
    useProfile: () => ({ id: 'u1', firstName: 'Alice', connectedServices: [] }),
    useLocalSettingMutable: () => [false, vi.fn()],
}));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://lmc.example' }));
vi.mock('@/hooks/useConnectTerminal', () => ({ useConnectTerminal: () => ({ connectTerminal: vi.fn(), isLoading: false }) }));
vi.mock('@/sync/apiServices', () => ({ disconnectService: vi.fn() }));
vi.mock('@/sync/sync', () => ({ sync: { refreshProfile: vi.fn() } }));
vi.mock('@/components/lmc/UsageDialog', () => ({ openUsage }));
vi.mock('@/components/lmc/ChangelogDialog', () => ({ openChangelog }));
vi.mock('./elevation', () => ({ lmcElevation: () => ({}), lmcSurfaceBorder: () => ({}) }));
vi.mock('./settings/LmcSettingsDialog', () => ({ openLmcSettings }));
vi.mock('./AccountQuotaCards', () => ({ AccountQuotaCards: 'AccountQuotaCards' }));
vi.mock('@/sync/useAccountQuota', () => ({ useAccountQuota: () => ({ providers: [], loading: false, error: false, refresh: vi.fn() }) }));
vi.mock('@/sync/apiAccounts', () => ({ accountMe }));
vi.mock('@/components/lmc/MembersDialog', () => ({ openMembers }));
vi.mock('@/components/lmc/ResourceSharingDialog', () => ({ openResourceSharingList }));
vi.mock('@/text', () => ({
    t: (key: string) => ({
        'lmc.menu.usage': '用量看板',
        'lmc.menu.settings': '设置',
        'lmc.menu.devices': '设备与 Agent 升级',
        'lmc.menu.profile': '个人资料',
        'lmc.menu.changelog': '更新日志',
        'lmc.menu.signOut': '退出登录',
        'lmc.account.sharingSection': '共享与成员',
        'lmc.account.mySharing': '我的共享',
        'lmc.account.mySharingSubtitle': '管理设备、会话与已保存文件的共享权限',
        'lmc.account.members': '成员与权限',
        'lmc.account.membersSubtitle': '邀请成员、管理角色与账号状态',
        'lmc.account.selfHosted': '自托管账号',
        'lmc.account.selfHostedFooter': '',
        'lmc.account.connectDevice': '连接设备',
        'lmc.account.connectDeviceHint': '',
        'lmc.account.deviceAccess': '设备授权',
        'lmc.account.deviceAccessFooter': '',
        'lmc.account.refresh': '刷新授权列表',
        'lmc.account.noDevices': '暂无设备授权',
        'lmc.account.engines': '引擎账号关联',
        'lmc.account.enginesFooter': '',
        'lmc.account.connectClaude': '连接 Claude Code 账号',
        'lmc.account.noEngines': '暂无关联的引擎账号',
        'lmc.account.signInSection': '登录管理',
        'lmc.about.title': '关于',
        'lmc.about.changelog': '更新日志',
        'lmc.about.changelogSubtitle': '看看最近改了什么',
        'lmc.about.webVersion': 'Web 版本',
        'lmc.about.localBuild': '本地开发构建',
        'lmc.about.developerMode': '开发者模式',
        'lmc.about.developerModeSubtitle': '',
        'lmc.settings.selfHostBlurb': '',
    }[key] ?? key),
}));

import { AccountMenu } from './AccountMenu';
import AccountSettings from '@/app/(app)/settings/account';
import { AboutPane } from './settings/AboutPane';
import { Switch } from '@/components/Switch';

describe('AccountMenu and Settings consolidation', () => {
    it('keeps only usage, settings, and sign-out in AccountMenu (changelog moved into Settings)', async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        accountMe.mockClear();
        let tree: any;
        await act(async () => {
            tree = create(React.createElement(AccountMenu, { anchor: { x: 12, y: 700, width: 320 } }));
        });
        const labels = tree.root.findAllByType('Text').map((node: any) => node.children.join(''));
        expect(labels).toEqual(['用量看板', '设置', '退出登录']);
        expect(labels).not.toContain('设备与 Agent 升级');
        expect(labels).not.toContain('个人资料');
        expect(labels).not.toContain('我的共享');
        expect(labels).not.toContain('成员与权限');
        expect(labels).not.toContain('更新日志');
        expect(accountMe).not.toHaveBeenCalled();
        await act(async () => tree.unmount());
        vi.unstubAllGlobals();
    });

    it('renders Changelog inside AboutPane without dismissing the parent Settings modal', async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        openChangelog.mockClear();
        const onNavigate = vi.fn();
        let tree: any;
        await act(async () => {
            tree = create(React.createElement(AboutPane, { onNavigate }));
        });
        const item = tree.root.findAllByType('Item').find((n: any) => n.props.title === '更新日志');
        expect(item).toBeDefined();
        await act(async () => item.props.onPress());
        expect(openChangelog).toHaveBeenCalledTimes(1);
        expect(onNavigate).not.toHaveBeenCalled();
        await act(async () => tree.unmount());
        vi.unstubAllGlobals();
    });

    it('renders My Sharing and role-gated Members inside AccountSettings', async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ devices: [] }) })));

        accountMe.mockResolvedValueOnce({ account: { id: 'a1', username: 'alice', role: 'admin', enabled: true, accessVersion: 1 }, capabilities: { version: 1, fileSharing: true, sessionSharing: true, sharedExecution: true } });
        let adminTree: any;
        await act(async () => {
            adminTree = create(React.createElement(AccountSettings));
        });
        const adminTitles = adminTree.root.findAllByType('Item').map((node: any) => node.props.title);
        expect(adminTitles).toContain('我的共享');
        expect(adminTitles).toContain('成员与权限');

        await act(async () => adminTree.root.findAllByType('Item').find((n: any) => n.props.title === '我的共享').props.onPress());
        expect(openResourceSharingList).toHaveBeenCalledTimes(1);
        await act(async () => adminTree.root.findAllByType('Item').find((n: any) => n.props.title === '成员与权限').props.onPress());
        expect(openMembers).toHaveBeenCalledTimes(1);
        await act(async () => adminTree.unmount());

        accountMe.mockResolvedValueOnce({ account: { id: 'm1', username: 'Member', role: 'member', enabled: true, accessVersion: 1 }, capabilities: { version: 1, fileSharing: true, sessionSharing: true, sharedExecution: true } });
        let memberTree: any;
        await act(async () => {
            memberTree = create(React.createElement(AccountSettings));
        });
        const memberTitles = memberTree.root.findAllByType('Item').map((node: any) => node.props.title);
        expect(memberTitles).toContain('我的共享');
        expect(memberTitles).not.toContain('成员与权限');
        await act(async () => memberTree.unmount());
        vi.unstubAllGlobals();
    });
});

describe('Unified Switch component', () => {
    it('forwards accessibilityLabel and testID and prevents raw react-native Switch in production screens', async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        const onChange = vi.fn();
        let tree: any;
        await act(async () => {
            tree = create(React.createElement(Switch, { value: true, accessibilityLabel: '通过', testID: 'agent-mail-switch', onValueChange: onChange }));
        });
        const pressable = tree.root.findByType('Pressable');
        expect(pressable.props.accessibilityRole).toBe('switch');
        expect(pressable.props.accessibilityLabel).toBe('通过');
        expect(pressable.props.testID).toBe('agent-mail-switch');
        expect(pressable.props.accessibilityState).toEqual({ checked: true, disabled: false });
        await act(async () => pressable.props.onPress());
        expect(onChange).toHaveBeenCalledWith(false);
        await act(async () => tree.unmount());
        vi.unstubAllGlobals();

        const sourcesDir = path.resolve(__dirname, '../..');
        const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const full = path.join(dir, entry.name);
            return entry.isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
        });
        const offenders = walk(sourcesDir).filter((file) => {
            const rel = path.relative(sourcesDir, file).replace(/\\/g, '/');
            if (rel.startsWith('app/(app)/dev/') || rel.endsWith('.test.ts') || rel.endsWith('.spec.ts') || rel === 'components/Switch.tsx') return false;
            const code = fs.readFileSync(file, 'utf8');
            return /import\s*\{[^}]*\bSwitch\b[^}]*\}\s*from\s*['"]react-native['"]/.test(code);
        });
        expect(offenders).toEqual([]);
    });
});

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { ProfileSection } from '@/components/lmc/settings/ProfileSection';
import { Modal } from '@/modal';
import { useProfile } from '@/sync/storage';
import { getServerUrl } from '@/sync/serverConfig';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { disconnectService } from '@/sync/apiServices';
import { sync } from '@/sync/sync';
import { t } from '@/text';

type Device = { id: string; createdAt: string; expiresAt: string };
export default function AccountSettings() {
    const auth = useAuth();
    const router = useRouter();
    const profile = useProfile();
    const { connectTerminal, isLoading: pairing } = useConnectTerminal();
    const [devices, setDevices] = useState<Device[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const request = useCallback(async (path: string, method = 'GET') => {
        const response = await fetch(`${getServerUrl()}/v1/lmc/devices${path}`, {
            method, headers: { Authorization: `Bearer ${auth.credentials?.token}` }, cache: 'no-store',
        });
        if (!response.ok) throw new Error(t('lmc.account.requestFailed'));
        return response.json();
    }, [auth.credentials?.token]);
    const reload = useCallback(async () => {
        setBusy(true); setError('');
        try { setDevices((await request('')).devices); }
        catch (e) { setError((e as Error).message); }
        finally { setBusy(false); }
    }, [request]);
    useEffect(() => { void reload(); }, [reload]);
    const revoke = async (device: Device) => {
        if (!await Modal.confirm(t('lmc.account.revokeTitle'), t('lmc.account.revokeBody'), { cancelText: t('common.cancel'), confirmText: t('lmc.account.revoke'), destructive: true })) return;
        setBusy(true);
        try { await request('/' + device.id, 'DELETE'); await reload(); }
        catch (e) { setError((e as Error).message); }
        finally { setBusy(false); }
    };
    return <ItemList>
        <ProfileSection />
        <ItemGroup title={t('lmc.account.selfHosted')} footer={t('lmc.account.selfHostedFooter')}>
            <Item title={profile.firstName || t('lmc.settings.fallbackAccount')} subtitle={getServerUrl()} showChevron={false} />
            <Item title={t('lmc.account.connectDevice')} subtitle={t('lmc.account.connectDeviceHint')} onPress={connectTerminal} loading={pairing} />
        </ItemGroup>
        <ItemGroup title={t('lmc.account.deviceAccess', { count: devices.length })} footer={error || t('lmc.account.deviceAccessFooter')}>
            <Item title={t('lmc.account.refresh')} onPress={reload} loading={busy} disabled={busy} />
            {devices.length === 0 ? <Item title={t('lmc.account.noDevices')} showChevron={false} /> : devices.map((device, index) =>
                <Item key={device.id} title={t('lmc.account.deviceNth', { index: index + 1 })} subtitle={t('lmc.account.deviceMeta', { created: new Date(device.createdAt).toLocaleString(), expires: new Date(device.expiresAt).toLocaleDateString() })} onPress={() => revoke(device)} disabled={busy} />)}
        </ItemGroup>
        {/* Connecting used to be a row on the phone's settings index; it lives
            here now, beside the services it manages. */}
        <ItemGroup title={t('lmc.account.engines')} footer={t('lmc.account.enginesFooter')}>
            {!profile.connectedServices?.includes('anthropic') && (
                <Item title={t('lmc.account.connectClaude')} onPress={() => router.push('/settings/connect/claude')} />
            )}
            {(profile.connectedServices ?? []).length === 0 && <Item title={t('lmc.account.noEngines')} showChevron={false} />}
            {(profile.connectedServices ?? []).map(service => <Item key={service} title={service} subtitle={t('lmc.account.unlink')} onPress={async () => {
                if (!await Modal.confirm(t('lmc.account.unlinkTitle'), t('lmc.account.unlinkBody', { service }), { cancelText: t('common.cancel'), confirmText: t('lmc.account.unlink'), destructive: true })) return;
                try { await disconnectService(auth.credentials!, service); await sync.refreshProfile(); }
                catch { Modal.alert(t('lmc.devices.stopFailed'), t('lmc.menu.retryHint')); }
            }} />)}
        </ItemGroup>
        <ItemGroup title={t('lmc.account.signInSection')}>
            <Item title={t('lmc.menu.signOut')} destructive onPress={async () => {
                if (!await Modal.confirm(t('lmc.menu.signOut'), t('lmc.menu.signOutConfirm'), { cancelText: t('common.cancel'), confirmText: t('lmc.menu.signOut') })) return;
                try { await auth.logout(); } catch { Modal.alert(t('lmc.menu.signOutFailed'), t('lmc.menu.retryHint')); }
            }} />
        </ItemGroup>
    </ItemList>;
}

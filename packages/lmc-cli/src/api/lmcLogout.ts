import { configuration } from '@/configuration';
export async function revokeDeviceLogin(token: string): Promise<void> {
    const response = await fetch(`${configuration.serverUrl}/v1/lmc/device/logout`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok && response.status !== 401) throw new Error('无法撤销设备授权，请恢复连接后重试；本地凭据仍保留');
}

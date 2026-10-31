import { getCurrentLanguage } from '@/text';

const CODE_MESSAGES_EN: Record<string, string> = {
    not_enabled: 'Multi-account features are not enabled on this center',
    account_unavailable: 'Your account is disabled or your sign-in has expired',
    admin_required: 'Administrator permission is required',
    not_found: 'Resource or account not found',
    account_conflict: 'Account was updated elsewhere; refresh and try again',
    invite_limit: 'Too many pending invitations; revoke unused invitations first',
    invite_unavailable: 'This invitation has already been used, revoked, or does not exist',
    invite_expired: 'This invitation has expired, been revoked, or already been used',
    username_taken: 'That username is not available',
    legacy_key: 'This legacy resource uses an older key format and must be upgraded or migrated before sharing',
    invalid_message: 'Failed to decrypt message',
    command_forbidden: 'Use plain text in shared messages; runtime settings are managed by the session owner',
    agent_required: 'Session Agent mismatch or unavailable',
    action_unconfirmed: 'Action outcome is not confirmed yet; check session status before retrying',
    device_forbidden: 'Device execution access has been revoked or not granted',
    legacy_machine: 'This device uses an older key format; upgrade the Agent and reconnect to share',
    device_changed: 'Device ownership or sharing scope changed; reopen the session',
    identity_required: 'Sign-in identity mismatch',
    start_failed: 'The device did not finish starting the session; check device status and retry',
    request_conflict: 'Creation request was already used for another device or engine',
    launch_unavailable: 'Launch request was already claimed or expired',
    machine_missing: 'No recoverable device is associated with this session',
    host_mismatch: 'Session and device ownership do not match',
    resume_unconfirmed: 'Resume outcome is not confirmed yet; check session status',
    resume_failed: 'The device could not resume this session; check device status',
    start_in_progress: 'The device is still starting this session; wait a moment rather than creating another',
    scope: 'Session identity mismatch',
    agent_upgrade_required: 'Connect an updated Agent that supports multi-account sharing first',
    agent_unavailable: 'Agent is offline, unsupported, or running duplicate instances',
    action_forbidden: 'You do not have permission for this action, or access was revoked',
    sharing_forbidden: 'You do not have permission to change sharing for this resource',
    sharing_conflict: 'Sharing settings changed; reload and try again',
    invalid_grants: 'Invalid sharing recipients or permission scope',
    last_admin: 'At least one enabled administrator account must remain',
    web_required: 'Sign in with an LMC web account first',
    owner_changed: 'Resource ownership changed; reconfigure sharing permissions',
    sharing_not_ready: 'Sharing is not available for this resource yet',
    invalid_actions: 'Shared resources must include view access; runtime settings remain with the owner',
    invalid_member: 'Recipient account does not exist or is disabled',
    key_unavailable: 'Could not distribute encryption keys for this resource; existing sharing was kept',
    invalid_input: 'Invalid input',
    account_error: 'Account operation failed; try again in a moment',
    rate_limit: 'Too many attempts; try again in a moment',
};

const MESSAGE_MAP_EN: Record<string, string> = {
    '请求来源无效': 'Invalid request origin',
    '请登录': 'Please sign in first',
    '参数不合法': 'Invalid parameters',
    '尝试次数过多，请稍后重试': 'Too many attempts; try again in a moment',
    '请输入账号和密码': 'Enter both username and password',
    '账号或密码错误': 'Incorrect username or password',
    '请使用 LMC 账号登录或在浏览器配对设备': 'Sign in with an LMC account or pair the device in your browser',
    '配对已失效，请重新发起': 'Pairing link expired; start again on the device',
    '配对已完成': 'Pairing has already been completed',
    '配对已失效或已被处理': 'Pairing link expired or was already handled',
    '设备授权已失效': 'Device authorization has expired',
    '设备不存在': 'Device not found',
    '多账号功能尚未启用': 'Multi-account features are not enabled on this center',
    '消息格式无效': 'Invalid message format',
    '协作操作未完成，请稍后重试': 'Shared action could not be completed; try again in a moment',
    '输入无效': 'Invalid input',
    '设备操作未完成，请稍后重试': 'Device operation could not be completed; try again in a moment',
    '共享操作失败，请稍后重试': 'Sharing operation failed; try again in a moment',
    '账号操作失败，请稍后重试': 'Account operation failed; try again in a moment',
    '此旧会话使用账号级密钥，须迁移为独立会话密钥后才能共享': 'This older session uses an account-level key and must migrate to a per-session key before sharing',
    '此资源的执行隔离或密钥分发尚未接通，暂不开放共享': 'Execution isolation or key distribution is not available for this resource yet',
};

export function translateLmcServerMessage(message?: string | null, code?: string | null): string | undefined {
    if (getCurrentLanguage() === 'zh-Hans') {
        return message || undefined;
    }
    if (code && CODE_MESSAGES_EN[code]) {
        return CODE_MESSAGES_EN[code];
    }
    if (message && MESSAGE_MAP_EN[message]) {
        return MESSAGE_MAP_EN[message];
    }
    return message || undefined;
}

/** LMC's own restore flags are identity, not unsupported custom settings. */
export function nativeResumeIdentity(args: string[] = [], knownId: string | null): string | null {
    let id = knownId;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--chrome' || arg === '--no-chrome' || arg === '--dangerously-skip-permissions') continue;
        if (arg === '--resume') {
            const value = args[++i];
            if (!value || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new Error('Claude 恢复参数缺少明确的会话 ID');
            if (id && id !== value) throw new Error('Claude 恢复参数与当前会话身份不一致，已保留原会话');
            id = value;
            continue;
        }
        if (arg === '--continue' && id) continue;
        throw new Error(`原生模式暂不支持 CLI 参数 ${arg.startsWith('-') ? arg : '(参数值)'}，已保留原会话`);
    }
    return id;
}

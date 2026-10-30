import { SESSION_REGISTRATION_TIMEOUT_MS } from 'lmc-wire';
import type { SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

/** Registration is independent of the provider and of regular/tmux spawning. */
export class SessionRegistration {
    private pending = new Map<number, (result: SpawnSessionResult) => void>();

    wait(pid: number): Promise<SpawnSessionResult> {
        if (this.pending.has(pid)) throw new Error(`Already waiting for PID ${pid}`);
        return new Promise(resolve => {
            const finish = (result: SpawnSessionResult) => {
                clearTimeout(timer);
                this.pending.delete(pid);
                resolve(result);
            };
            const timer = setTimeout(() => finish({
                type: 'error',
                errorMessage: `会话启动超过 90 秒，尚未收到注册回调（PID ${pid}）。进程可能仍在启动，请先检查会话列表，避免重复创建。`,
            }), SESSION_REGISTRATION_TIMEOUT_MS);
            this.pending.set(pid, finish);
        });
    }

    complete(pid: number, sessionId: string): void {
        this.pending.get(pid)?.({ type: 'success', sessionId });
    }

    exited(pid: number): void {
        this.pending.get(pid)?.({
            type: 'error',
            errorMessage: `会话进程在注册完成前已退出（PID ${pid}），请查看设备启动日志。`,
        });
    }
}

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AsyncLock } from './lock';

/** Conservative recognition of execution requests, never questions, quoted data or mail. */
export function detectAutomaticGoal(input: string): string | null {
    const text = input.trim();
    if (text.length < 12 || text.length > 2000 || /^(?:\/|\[|>|```|<)/.test(text)) return null;
    if (/[?？]|(?:不要|不用|别|暂不|先不).{0,16}(?:执行|实现|修改|上线|部署|目标)|只(?:需|要)?(?:解释|分析|回答|给|出)|先(?:出|给).{0,8}(?:方案|计划|设计)|\b(?:explain|what|why|how|whether|don't|do not|not yet|propose)\b/i.test(text)) return null;
    const request = /^(?:(?:请|帮我|麻烦|现在|直接|继续|开始|我们|把|将)\s*)*(?:修复|排查|检查|实现|完成|开发|构建|重构|迁移|优化|升级|增加|新增|改造|改成|支持|持续|一直|自动|做一次|做一个|按)/.test(text)
        || /^(?:(?:please|help me|now)\s+)*(?:fix|investigate|implement|build|complete|refactor|migrate|upgrade|add|keep working|continue working)\b/i.test(text);
    if (!request) return null;
    const sustained = /(?:持续|一直|直到|直至|keep working|continue working|\buntil\b)/i.test(text);
    const phases = [
        /排查|分析|调查|复核|审查|investigate|diagnos|audit/i,
        /修复|实现|开发|构建|重构|迁移|改造|fix|implement|build|refactor|migrat/i,
        /验证|测试|验收|回归|test|verif|acceptance/i,
        /上线|部署|发布|同步.*仓库|deploy|publish|release/i,
    ].filter(pattern => pattern.test(text)).length;
    return sustained || phases >= 2 ? text : null;
}

function fingerprint(text: string): string {
    return createHash('sha256').update(text.trim().replace(/\s+/g, ' ')).digest('hex');
}

/** Per-LMC-session, shared by both engines. No prompt text or credentials are stored. */
export function automaticGoalStatePath(home: string, sessionId: string): string {
    return join(home, 'automatic-goals', `${fingerprint(sessionId)}.json`);
}

export class AutomaticGoalPolicy {
    private lock = new AsyncLock();
    constructor(private path: string) {}

    async claim(text: string, opts: { supported: boolean; available: boolean; permissionMode?: string }): Promise<string | null> {
        const objective = detectAutomaticGoal(text);
        if (!objective || !opts.supported || !opts.available || opts.permissionMode === 'plan') return null;
        return this.lock.inLock(async () => {
            let hashes: string[] = [];
            try {
                const state = JSON.parse(await readFile(this.path, 'utf8'));
                if (state.version !== 1 || !Array.isArray(state.hashes) || !state.hashes.every((h: unknown) => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h))) throw new Error('Invalid automatic goal state');
                hashes = state.hashes;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            const hash = fingerprint(objective);
            if (hashes.includes(hash)) return null;
            hashes.push(hash);
            await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
            const temporary = `${this.path}.${process.pid}.tmp`;
            await writeFile(temporary, JSON.stringify({ version: 1, hashes }), { mode: 0o600 });
            await rename(temporary, this.path);
            // Record before dispatch: uncertain provider delivery must never duplicate a goal.
            return objective;
        });
    }
}

import { existsSync } from 'node:fs';

import type { Metadata } from '@/api/types';
import { encodeBase64 } from '@/api/encryption';
import { hasLocalHappyAgentAuth } from '@/resume/localHappyAgentAuth';
import { spawnLmcCLI } from '@/utils/spawnLmcCLI';
import { buildSessionChildEnvironment, sanitizeSessionEnvironment } from '@/daemon/sessionEnvironment';

import { LocalResumeSessionError, resolveLocalReconnectableSession } from './localResumeStore';
import { resolveLmcSession, type ReconnectableLmcSession, type ResumableLmcSession } from './resolveLmcSession';

export type ResumeLaunch = {
    cwd: string;
    args: string[];
};

export type ResumeLaunchOptions = {
    claudeStartingMode?: 'local' | 'remote';
    startedBy?: 'daemon' | 'terminal';
    /**
     * Start the engine on a new native thread instead of resuming one.
     *
     * Only an engine switch asks for this. A missing thread id is otherwise a
     * real fault — the session lost track of its own conversation — and
     * starting fresh on its behalf would drop the history without saying so.
     */
    startFresh?: boolean;
};

export function parseResumeCommandArgs(args: string[]): { showHelp: boolean; sessionId: string } {
    if (args.includes('-h') || args.includes('--help')) {
        return {
            showHelp: true,
            sessionId: '',
        };
    }

    if (args.length === 0) {
        throw new Error('LMC session ID is required: lmc resume <session-id>');
    }
    if (args.length > 1) {
        throw new Error(`Unexpected arguments for lmc resume: ${args.slice(1).join(' ')}`);
    }

    return {
        showHelp: false,
        sessionId: args[0],
    };
}

function resolveFlavor(metadata: Metadata): 'codex' | 'claude' | null {
    // The declared flavor wins over a thread id. They used to agree, because a
    // session never changed engines; now a switch leaves the previous engine's
    // id behind for a moment, and reading that first would relaunch the engine
    // the session just moved off.
    if (metadata.flavor === 'codex' || metadata.flavor === 'claude') {
        return metadata.flavor;
    }
    if (metadata.codexThreadId) {
        return 'codex';
    }
    if (metadata.claudeSessionId) {
        return 'claude';
    }
    return null;
}

export function buildResumeLaunch(session: ResumableLmcSession, options: ResumeLaunchOptions = {}): ResumeLaunch {
    const { metadata } = session;
    const flavor = resolveFlavor(metadata);

    if (flavor === 'codex') {
        if (!metadata.codexThreadId && !options.startFresh) {
            throw new Error(`LMC session ${session.id} is missing its Codex thread ID.`);
        }
        const args = ['codex'];
        if (metadata.codexThreadId && !options.startFresh) {
            args.push('--resume', metadata.codexThreadId);
        }
        if (options.startedBy) {
            args.push('--started-by', options.startedBy);
        }
        return {
            cwd: metadata.path,
            args,
        };
    }

    if (flavor === 'claude') {
        if (!metadata.claudeSessionId && !options.startFresh) {
            throw new Error(`LMC session ${session.id} is missing its Claude session ID.`);
        }
        const args = ['claude'];
        if (options.claudeStartingMode) {
            args.push('--happy-starting-mode', options.claudeStartingMode);
        }
        if (options.startedBy) {
            args.push('--started-by', options.startedBy);
        }
        if (metadata.claudeSessionId && !options.startFresh) {
            args.push('--resume', metadata.claudeSessionId);
        }
        return {
            cwd: metadata.path,
            args,
        };
    }

    throw new Error(`LMC session ${session.id} uses unsupported flavor "${metadata.flavor ?? 'unknown'}".`);
}

export function formatResumeHelp(): string {
    return [
        'lmc resume - Resume a previous LMC session',
        '',
        'Usage:',
        '  lmc resume <lmc-session-id>',
        '',
        'Examples:',
        '  lmc resume cmmij8olq00dp5jcxr3wtbpau',
        '  lmc resume cmmij8',
        '',
        'This reuses the saved worktree/path and resumes the underlying agent session',
        'when the backend supports it.',
    ].join('\n');
}

function buildReconnectEnv(session: ReconnectableLmcSession): NodeJS.ProcessEnv {
    return buildSessionChildEnvironment(process.env, {
        HAPPY_RECONNECT_SESSION_ID: session.id,
        HAPPY_RECONNECT_ENCRYPTION_KEY: encodeBase64(session.encryptionKey),
        HAPPY_RECONNECT_ENCRYPTION_VARIANT: session.encryptionVariant,
        HAPPY_RECONNECT_SEQ: String(session.seq),
        HAPPY_RECONNECT_METADATA_VERSION: String(session.metadataVersion),
        HAPPY_RECONNECT_AGENT_STATE_VERSION: String(session.agentStateVersion),
    });
}

function spawnResumeChild(launch: ResumeLaunch, env: NodeJS.ProcessEnv = sanitizeSessionEnvironment(process.env)): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const child = spawnLmcCLI(launch.args, {
            cwd: launch.cwd,
            env,
            stdio: 'inherit',
        });

        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`Resumed session exited via signal ${signal}`));
                return;
            }
            resolve(code);
        });
    });
}

async function resolveLegacySessionIfAvailable(sessionId: string): Promise<ResumableLmcSession | null> {
    if (!hasLocalHappyAgentAuth()) {
        return null;
    }
    return resolveLmcSession(sessionId);
}

export async function handleResumeCommand(args: string[]): Promise<void> {
    const parsed = parseResumeCommandArgs(args);
    if (parsed.showHelp) {
        console.log(formatResumeHelp());
        return;
    }

    let localError: unknown;
    let reconnectableSession: ReconnectableLmcSession | null = null;
    try {
        reconnectableSession = await resolveLocalReconnectableSession(parsed.sessionId);
    } catch (error) {
        localError = error;
        if (error instanceof LocalResumeSessionError && error.code === 'ambiguous') {
            throw error;
        }
    }

    if (reconnectableSession) {
        const launch = buildResumeLaunch(reconnectableSession);

        if (!existsSync(launch.cwd)) {
            throw new Error(`Saved session path does not exist: ${launch.cwd}`);
        }

        const exitCode = await spawnResumeChild(launch, buildReconnectEnv(reconnectableSession));
        if (typeof exitCode === 'number' && exitCode !== 0) {
            process.exit(exitCode);
        }
        return;
    }

    const session = await resolveLegacySessionIfAvailable(parsed.sessionId);
    if (!session) {
        throw localError;
    }
    const launch = buildResumeLaunch(session);

    if (!existsSync(launch.cwd)) {
        throw new Error(`Saved session path does not exist: ${launch.cwd}`);
    }

    const exitCode = await spawnResumeChild(launch);
    if (typeof exitCode === 'number' && exitCode !== 0) {
        process.exit(exitCode);
    }
}

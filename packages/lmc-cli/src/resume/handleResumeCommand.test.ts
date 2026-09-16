import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_SCOPED_ENV_KEYS } from '@/daemon/sessionEnvironment';

const mocks = vi.hoisted(() => ({
    mockExistsSync: vi.fn(),
    mockSpawnHappyCLI: vi.fn(),
    mockResolveLocalReconnectableSession: vi.fn(),
    mockHasLocalHappyAgentAuth: vi.fn(),
    mockResolveHappySession: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        existsSync: mocks.mockExistsSync,
    };
});

vi.mock('@/utils/spawnLmcCLI', () => ({
    spawnLmcCLI: mocks.mockSpawnHappyCLI,
}));

vi.mock('./localResumeStore', () => {
    class MockLocalResumeSessionError extends Error {
        constructor(
            message: string,
            public readonly code: 'not_found' | 'ambiguous' | 'unavailable',
        ) {
            super(message);
            this.name = 'LocalResumeSessionError';
        }
    }

    return {
        LocalResumeSessionError: MockLocalResumeSessionError,
        resolveLocalReconnectableSession: mocks.mockResolveLocalReconnectableSession,
    };
});

vi.mock('@/resume/localHappyAgentAuth', () => ({
    hasLocalHappyAgentAuth: mocks.mockHasLocalHappyAgentAuth,
}));

vi.mock('./resolveLmcSession', async () => {
    const actual = await vi.importActual<typeof import('./resolveLmcSession')>('./resolveLmcSession');
    return {
        ...actual,
        resolveLmcSession: mocks.mockResolveHappySession,
    };
});

import { spawnLmcCLI } from '@/utils/spawnLmcCLI';

import { buildResumeLaunch, formatResumeHelp, handleResumeCommand, parseResumeCommandArgs } from './handleResumeCommand';
import { LocalResumeSessionError } from './localResumeStore';

function createChildProcess(exitCode: number | null = 0) {
    const handlers = new Map<string, (...args: any[]) => void>();
    return {
        once: vi.fn((event: string, handler: (...args: any[]) => void) => {
            handlers.set(event, handler);
            if (event === 'exit') {
                queueMicrotask(() => handler(exitCode, null));
            }
            return undefined;
        }),
    };
}

function createReconnectableSession() {
    return {
        id: 'session-1',
        active: false,
        metadata: {
            path: '/tmp/repo',
            flavor: 'codex',
            codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
            host: 'localhost',
            homeDir: '/tmp',
            happyHomeDir: '/tmp/.happy',
            happyLibDir: '/tmp/happy',
            happyToolsDir: '/tmp/happy/tools',
        },
        seq: 42,
        metadataVersion: 7,
        agentStateVersion: 9,
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'dataKey' as const,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockExistsSync.mockReturnValue(true);
    mocks.mockSpawnHappyCLI.mockReturnValue(createChildProcess());
    mocks.mockResolveLocalReconnectableSession.mockRejectedValue(
        new LocalResumeSessionError('no local session', 'not_found'),
    );
    mocks.mockHasLocalHappyAgentAuth.mockReturnValue(false);
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('parseResumeCommandArgs', () => {
    it('parses the happy session id', () => {
        expect(parseResumeCommandArgs(['cmmij8olq00dp5jcxr3wtbpau'])).toEqual({
            showHelp: false,
            sessionId: 'cmmij8olq00dp5jcxr3wtbpau',
        });
    });

    it('recognizes help flags', () => {
        expect(parseResumeCommandArgs(['--help'])).toEqual({
            showHelp: true,
            sessionId: '',
        });
    });

    it('rejects missing session ids', () => {
        expect(() => parseResumeCommandArgs([])).toThrow(
            'LMC session ID is required: lmc resume <session-id>',
        );
    });
});

describe('buildResumeLaunch', () => {
    it('builds a Codex resume command', () => {
        expect(buildResumeLaunch({
            id: 'session-1',
            active: false,
            metadata: {
                path: '/tmp/p1-control-flow',
                flavor: 'codex',
                codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toEqual({
            cwd: '/tmp/p1-control-flow',
            args: ['codex', '--resume', '019ccca5-726b-7c61-b914-16de27dfab6e'],
        });
    });

    it('builds a Claude resume command', () => {
        expect(buildResumeLaunch({
            id: 'session-2',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'claude',
                claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toEqual({
            cwd: '/tmp/repo',
            args: ['claude', '--resume', '93a9705e-bc6a-406d-8dce-8acc014dedbd'],
        });
    });

    it('rejects unsupported flavors', () => {
        expect(() => buildResumeLaunch({
            id: 'session-3',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'gemini',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toThrow('LMC session session-3 uses unsupported flavor "gemini".');
    });
});

describe('formatResumeHelp', () => {
    it('mentions the session id command shape', () => {
        expect(formatResumeHelp()).toContain('lmc resume <lmc-session-id>');
    });
});

describe('handleResumeCommand', () => {
    it('resumes from local persisted encryption data without legacy agent.key auth', async () => {
        const session = createReconnectableSession();
        mocks.mockResolveLocalReconnectableSession.mockResolvedValue(session);
        for (const key of SESSION_SCOPED_ENV_KEYS) {
            vi.stubEnv(key, `stale-${key}`);
        }

        await handleResumeCommand(['session-1']);

        expect(mocks.mockHasLocalHappyAgentAuth).not.toHaveBeenCalled();
        expect(mocks.mockResolveHappySession).not.toHaveBeenCalled();
        expect(spawnLmcCLI).toHaveBeenCalledWith(['codex', '--resume', session.metadata.codexThreadId], {
            cwd: '/tmp/repo',
            stdio: 'inherit',
            env: expect.objectContaining({
                HAPPY_RECONNECT_SESSION_ID: 'session-1',
                HAPPY_RECONNECT_ENCRYPTION_KEY: 'AQIDBA==',
                HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'dataKey',
                HAPPY_RECONNECT_SEQ: '42',
                HAPPY_RECONNECT_METADATA_VERSION: '7',
                HAPPY_RECONNECT_AGENT_STATE_VERSION: '9',
            }),
        });
        const spawnedEnv = mocks.mockSpawnHappyCLI.mock.calls[0][1].env;
        expect(spawnedEnv).not.toHaveProperty('HAPPY_FORK_CODEX_THREAD_ID');
        expect(spawnedEnv).not.toHaveProperty('CODEX_THREAD_ID');
    });

    it('does not suggest happy-agent auth login when no local resume data or agent.key exists', async () => {
        mocks.mockResolveLocalReconnectableSession.mockRejectedValue(
            new LocalResumeSessionError(
                'Cannot resume LMC session "missing" on this machine: no local session encryption data found at /tmp/.happy/sessions.json.',
                'not_found',
            ),
        );
        mocks.mockHasLocalHappyAgentAuth.mockReturnValue(false);

        let thrown: unknown;
        try {
            await handleResumeCommand(['missing']);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain('no local session encryption data found');
        expect((thrown as Error).message).not.toContain('happy-agent auth login');
    });

    it('falls back to legacy account credentials only when agent.key is already present', async () => {
        mocks.mockHasLocalHappyAgentAuth.mockReturnValue(true);
        mocks.mockResolveHappySession.mockResolvedValue({
            id: 'legacy-session',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'claude',
                claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        });
        for (const key of SESSION_SCOPED_ENV_KEYS) {
            vi.stubEnv(key, `stale-${key}`);
        }

        await handleResumeCommand(['legacy-session']);

        expect(mocks.mockResolveHappySession).toHaveBeenCalledWith('legacy-session');
        expect(spawnLmcCLI).toHaveBeenCalledWith(['claude', '--resume', '93a9705e-bc6a-406d-8dce-8acc014dedbd'], expect.objectContaining({
            cwd: '/tmp/repo',
            env: expect.any(Object),
            stdio: 'inherit',
        }));
        const spawnedEnv = mocks.mockSpawnHappyCLI.mock.calls[0][1].env;
        for (const key of SESSION_SCOPED_ENV_KEYS) {
            expect(spawnedEnv).not.toHaveProperty(key);
        }
    });
});

describe('buildResumeLaunch across an engine switch', () => {
    const base = { path: '/tmp/project', machineId: 'm1' } as any;

    it('starts the target engine on a new thread when asked to', () => {
        expect(buildResumeLaunch(
            { id: 's1', active: true, metadata: { ...base, flavor: 'codex' } },
            { startedBy: 'daemon', startFresh: true },
        ).args).toEqual(['codex', '--started-by', 'daemon']);

        expect(buildResumeLaunch(
            { id: 's1', active: true, metadata: { ...base, flavor: 'claude' } },
            { startedBy: 'daemon', claudeStartingMode: 'remote', startFresh: true },
        ).args).toEqual(['claude', '--happy-starting-mode', 'remote', '--started-by', 'daemon']);
    });

    it('ignores a thread id left behind by the engine the session moved off', () => {
        expect(buildResumeLaunch(
            { id: 's1', active: true, metadata: { ...base, flavor: 'claude', codexThreadId: 'stale' } },
            { startedBy: 'daemon', startFresh: true },
        ).args[0]).toBe('claude');
    });

    it('still refuses to start fresh on its own when a thread id has gone missing', () => {
        expect(() => buildResumeLaunch(
            { id: 's1', active: true, metadata: { ...base, flavor: 'codex' } },
            { startedBy: 'daemon' },
        )).toThrow(/Codex thread ID/);
    });
});

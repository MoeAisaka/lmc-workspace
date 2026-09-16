import { UpgradeManager } from '@/runtime/upgradeManager';
import { stageRelease, activateRelease, latestVersion, rollbackRelease } from '@/runtime/releaseInstaller';
import { decideRefresh } from '@/runtime/refreshDecision';
import { runtimeVersion, agentRoot, readRuntimeSelection, refreshSupported } from '@/runtime/managedRuntime';
import { RefreshJournal, type RefreshJob } from './refreshJournal';
import { canRefreshSession, resumeAfterExit, type SessionRefreshOptions } from './sessionRefresh';
import { findProviderSessionPid } from './sessionSpawnGuard';
import { validateCodexContextLimits } from '@/codex/contextLimits';
import { validateCodexServiceTier } from '@/codex/serviceTier';
import { assertCodexModelEffort } from '@/codex/modelEffort';
import { codexServiceTierArgs, type CodexServiceTier } from '@/codex/serviceTier';
import type { CodexContextLimits } from '@/codex/contextLimits';
import { codexContextLimitArgs } from '@/codex/contextLimits';
import fs from 'fs/promises';
import os from 'os';
import * as tmp from 'tmp';
import axios from 'axios';

import { ApiClient } from '@/api/api';
import { TrackedSession, SessionEncryptionData } from './types';
import { MachineMetadata, DaemonState, Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnLmcCLI } from '@/utils/spawnLmcCLI';
import { writeDaemonState, heartbeatDaemonState, DaemonLocallyPersistedState, readDaemonState, acquireDaemonLock, releaseDaemonLock, readPersistedSessions, persistSession } from '@/persistence';
import type { PersistedSession } from '@/persistence';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledLmcVersion, stopDaemon } from './controlClient';
import { SUPERVISED_FLAG } from './supervision';
import { startDaemonControlServer } from './controlServer';
import { statSync } from 'fs';
import { join } from 'path';
import { projectPath } from '@/projectPath';
import { getTmuxUtilities, isTmuxAvailable, parseTmuxSessionIdentifier, formatTmuxSessionIdentifier } from '@/utils/tmux';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { detectCLIAvailability } from '@/utils/detectCLI';
import { buildResumeLaunch } from '@/resume/handleResumeCommand';
import psList from 'ps-list';
import { findLiveSessionProcess, findOrphanedSessionPid, isProcessAlive, SingleFlight } from './sessionSpawnGuard';
import { detectResumeSupport } from '@/resume/localHappyAgentAuth';
import { encodeBase64, decodeBase64, decrypt } from '@/api/encryption';
import {
  buildSessionChildEnvironment,
  sanitizeSessionEnvironment,
  wrapTmuxCommandWithSessionEnvironmentSanitizer,
} from './sessionEnvironment';
import { startHappyTerminalDaemon } from './happyTerminalBoot';
import { appendDaemonSpawnModeArgs, shouldForwardDaemonPermissionMode } from './spawnModeArgs';


/** Shell-escape a string for safe interpolation into tmux commands. */
function shellescape(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Prepare initial metadata
// Suffix host with `-dev` for the HAPPY_VARIANT=dev variant so the dev daemon
// is visually distinct from the stable one in the machine list (they otherwise
// share the same hostname and look identical).
const hostSuffix = process.env.HAPPY_VARIANT === 'dev' ? '-dev' : '';
export const initialMachineMetadata: MachineMetadata = {
  managedUpgrades: true,
  codexServiceTier: true,
  codexContextLimits: true,
  host: os.hostname() + hostSuffix,
  platform: os.platform(),
  happyCliVersion: packageJson.version,
  lmcCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.lmcHomeDir,
  lmcHomeDir: configuration.lmcHomeDir,
  happyLibDir: projectPath(),
  cliAvailability: detectCLIAvailability(),
  resumeSupport: { ...detectResumeSupport(), rpcAvailable: true },
};

export async function startDaemon(): Promise<void> {
  // The daemon may have been launched from a session process. Keep its normal
  // environment, but never let session lineage or reconnect state reach a
  // later, unrelated child session.
  const ambientEnvironment = sanitizeSessionEnvironment(process.env);

  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  let resolvesWhenShutdownRequested = new Promise<({ source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

      // Fallback - in case startup malfunctions - we will force exit the process with code 1
      setTimeout(async () => {
        logger.debug('[DAEMON RUN] Startup malfunctioned, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(1);
      }, 1_000);

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[DAEMON RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[DAEMON RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  process.on('uncaughtException', (error) => {
    logger.debug('[DAEMON RUN] FATAL: Uncaught exception', error);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.debug('[DAEMON RUN] FATAL: Unhandled promise rejection', reason);
    logger.debug(`[DAEMON RUN] Rejected promise:`, promise);
    const error = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${reason}`);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('exit', (code) => {
    logger.debug(`[DAEMON RUN] Process exiting with code: ${code}`);
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
  });

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  // Held only across the takeover: check, stop the unsupervised daemon, claim the role.
  let takeoverLockHandle: Awaited<ReturnType<typeof acquireDaemonLock>> = null;
  // Only the service manager passes this flag. An environment variable cannot
  // carry the answer: launchd's XPC_SERVICE_NAME is inherited by every
  // descendant, so a daemon a session started would claim to be supervised.
  const startedBySupervisor = process.argv.includes(SUPERVISED_FLAG);

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledLmcVersion();
  if (!runningDaemonVersionMatches) {
    // TODO: This hand-rolled self-restart path is awkward to reason about and awkward to test.
    // We should probably migrate this daemon to native system service management
    // (launchd/systemd, similar to OpenClaw's model), so startup/start-at-login and upgrades
    // are owned by the OS instead of by the daemon trying to replace itself in-process.
    logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
    await stopDaemon();
  } else if (startedBySupervisor && (await readDaemonState())?.supervisor !== 'launchd') {
    // launchd owns this invocation but the running daemon was left behind by a
    // session or an upgrade handoff. Exiting would make KeepAlive respawn us
    // every ThrottleInterval forever, so take the role over — once. Starters
    // arrive in herds (launchd plus every session's ensureDaemonRunning), and
    // an unserialised takeover has each of them stop the previous winner and
    // rerun startup, which spawns duplicate wrappers for the same session.
    const takeover = await acquireDaemonLock(1, 0, configuration.daemonTakeoverLockFile);
    if (!takeover) {
      logger.debug('[DAEMON RUN] Another starter is taking over supervision; leaving it to that process');
      process.exit(0);
    }
    // The winner may already have installed a supervised daemon while we waited.
    const supervised = (await readDaemonState())?.supervisor === 'launchd'
      && await isDaemonRunningCurrentlyInstalledLmcVersion();
    if (supervised) {
      await releaseDaemonLock(takeover, configuration.daemonTakeoverLockFile);
      logger.debug('[DAEMON RUN] Supervised daemon already running; keeping it');
      process.exit(0);
    }
    logger.debug('[DAEMON RUN] Same-version daemon running outside the service manager; taking over supervision');
    await stopDaemon();
    takeoverLockHandle = takeover;
  } else {
    logger.debug('[DAEMON RUN] Daemon version matches, keeping existing daemon');
    console.log('Daemon already running with matching version');
    process.exit(0);
  }

  // Acquire exclusive lock (proves daemon is running)
  const daemonLockHandle = await acquireDaemonLock(5, 200);
  if (takeoverLockHandle) await releaseDaemonLock(takeoverLockHandle, configuration.daemonTakeoverLockFile);
  if (!daemonLockHandle) {
    logger.warn('[DAEMON RUN] Failed to acquire daemon lock; daemon startup did not complete');
    process.exit(1);
  }

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

  try {
    // Happy Agent is a machine-level service shared by the mobile app and
    // Happy Terminal. Start it concurrently and keep this daemon boot path
    // independent from its install/download/network state.
    startHappyTerminalDaemon();

    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

    // Ensure auth and machine registration BEFORE anything else
    const { credentials, machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Retain session data after process exits so resume can still find it.
    // Pre-populate from disk so sessions survive daemon restarts.
    const sessionIdToFinishedSession = new Map<string, TrackedSession>();
    const persisted = readPersistedSessions();
    for (const [id, s] of Object.entries(persisted)) {
      sessionIdToFinishedSession.set(id, {
        startedBy: 'persisted',
        happySessionId: id,
        happySessionMetadataFromLocalWebhook: s.metadata,
        encryption: {
          encryptionKey: decodeBase64(s.encryptionKey),
          encryptionVariant: s.encryptionVariant,
          seq: s.seq,
          metadataVersion: s.metadataVersion,
          agentStateVersion: s.agentStateVersion,
        },
        pid: 0,
      });
    }
    if (Object.keys(persisted).length > 0) {
      logger.debug(`[DAEMON RUN] Loaded ${Object.keys(persisted).length} persisted sessions from disk`);
    }

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

    // Handle webhook from happy session reporting itself
    const onHappySessionWebhook = (sessionId: string, sessionMetadata: Metadata, encryption?: SessionEncryptionData) => {
      logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

      const pid = sessionMetadata.hostPid;
      if (!pid) {
        logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
        return;
      }

      logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}, hasEncryption: ${!!encryption}`);
      logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

      // Persist encryption data to disk so it survives daemon restarts
      if (encryption) {
        persistSession(sessionId, {
          encryptionKey: encodeBase64(encryption.encryptionKey),
          encryptionVariant: encryption.encryptionVariant,
          seq: encryption.seq,
          metadataVersion: encryption.metadataVersion,
          agentStateVersion: encryption.agentStateVersion,
          metadata: sessionMetadata,
          savedAt: Date.now(),
        });
      }

      // Check if we already have this PID (daemon-spawned)
      const existingSession = pidToTrackedSession.get(pid);

      if (existingSession && existingSession.startedBy === 'daemon') {
        // Update daemon-spawned session with reported data
        existingSession.happySessionId = sessionId;
        existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
        existingSession.encryption = encryption;
        logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

        // Resolve any awaiter for this PID
        const awaiter = pidToAwaiter.get(pid);
        if (awaiter) {
          pidToAwaiter.delete(pid);
          awaiter(existingSession);
          logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${pid}`);
        }
      } else if (!existingSession) {
        // New session started externally
        const trackedSession: TrackedSession = {
          startedBy: 'happy directly - likely by user from terminal',
          happySessionId: sessionId,
          happySessionMetadataFromLocalWebhook: sessionMetadata,
          encryption,
          pid
        };
        pidToTrackedSession.set(pid, trackedSession);
        logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
      }
    };

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debugLargeJson('[DAEMON RUN] Spawning session', options);

      const { directory, sessionId, machineId, approvedNewDirectoryCreation = true } = options;
      let directoryCreated = false;

      try {
        await fs.access(directory);
        logger.debug(`[DAEMON RUN] Directory exists: ${directory}`);
      } catch (error) {
        logger.debug(`[DAEMON RUN] Directory doesn't exist, creating: ${directory}`);

        // Check if directory creation is approved
        if (!approvedNewDirectoryCreation) {
          logger.debug(`[DAEMON RUN] Directory creation not approved for: ${directory}`);
          return {
            type: 'requestToApproveDirectoryCreation',
            directory
          };
        }

        try {
          await fs.mkdir(directory, { recursive: true });
          logger.debug(`[DAEMON RUN] Successfully created directory: ${directory}`);
          directoryCreated = true;
        } catch (mkdirError: any) {
          let errorMessage = `Unable to create directory at '${directory}'. `;

          // Provide more helpful error messages based on the error code
          if (mkdirError.code === 'EACCES') {
            errorMessage += `Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.`;
          } else if (mkdirError.code === 'ENOTDIR') {
            errorMessage += `A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.`;
          } else if (mkdirError.code === 'ENOSPC') {
            errorMessage += `No space left on device. Your disk is full. Please free up some space and try again.`;
          } else if (mkdirError.code === 'EROFS') {
            errorMessage += `The file system is read-only. Cannot create directories here. Please choose a writable location.`;
          } else {
            errorMessage += `System error: ${mkdirError.message || mkdirError}. Please verify the path is valid and you have the necessary permissions.`;
          }

          logger.debug(`[DAEMON RUN] Directory creation failed: ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }
      }

      try {

        // Build environment variables for session spawning
        // Authentication tokens are resolved here

        // Resolve authentication token if provided
        const authEnv: Record<string, string> = {};
        if (options.token) {
          if (options.agent === 'codex') {

            // Create a temporary directory for Codex
            const codexHomeDir = tmp.dirSync();

            // Write the token to the temporary directory
            await fs.writeFile(join(codexHomeDir.name, 'auth.json'), options.token);

            // Set the environment variable for Codex
            authEnv.CODEX_HOME = codexHomeDir.name;
          } else { // Assuming claude
            authEnv.CLAUDE_CODE_OAUTH_TOKEN = options.token;
          }
        }

        let extraEnv: Record<string, string> = {
          ...authEnv,
          ...sanitizeSessionEnvironment(options.environmentVariables ?? {}),
        };
        if (options.parentSessionId) {
          extraEnv.HAPPY_FORKED_FROM_SESSION_ID = options.parentSessionId;
        }
        if (options.forkedFromMessageId) {
          extraEnv.HAPPY_FORKED_FROM_MESSAGE_ID = options.forkedFromMessageId;
        }
        if (options.isSideChat) {
          extraEnv.HAPPY_SIDE_CHAT = '1';
        }
        if (options.hubSessionId) {
          extraEnv.HAPPY_HUB_SESSION_ID = options.hubSessionId;
        }
        if (options.title) {
          extraEnv.HAPPY_SESSION_TITLE = options.title;
        }
        // For fork: spawned LMC CLI needs to know which Claude JSONL to
        // backfill into the fresh LMC session row. Without this, the
        // SDK reads the JSONL silently as context but never re-emits the
        // historical messages, so the app shows an empty chat.
        if (options.resumeClaudeSessionId) {
          extraEnv.HAPPY_FORK_CLAUDE_SESSION_ID = options.resumeClaudeSessionId;
        }
        if (options.resumeCodexThreadId) {
          extraEnv.HAPPY_FORK_CODEX_THREAD_ID = options.resumeCodexThreadId;
        }
        logger.debug(`[DAEMON RUN] Environment variable keys (before expansion) (${Object.keys(extraEnv).length}): ${Object.keys(extraEnv).join(', ')}`);

        // Expand ${VAR} references from the sanitized daemon environment.
        // This ensures variable substitution works in both tmux and non-tmux modes
        // Example: ANTHROPIC_AUTH_TOKEN="${Z_AI_AUTH_TOKEN}" → ANTHROPIC_AUTH_TOKEN="sk-real-key"
        extraEnv = expandEnvironmentVariables(extraEnv, ambientEnvironment);
        logger.debug(`[DAEMON RUN] After variable expansion: ${Object.keys(extraEnv).join(', ')}`);

        // Fail fast if any passed-through environment variable still contains an
        // unresolved ${VAR} reference after expansion.
        const unresolvedEnvEntries = Object.entries(extraEnv).flatMap(([key, value]) => {
          if (typeof value !== 'string' || !value.includes('${')) {
            return [];
          }

          const unresolvedMatch = value.match(/\$\{([^}]+)\}/);
          if (!unresolvedMatch) {
            return [];
          }

          const expression = unresolvedMatch[1];
          const defaultSeparatorIndex = expression.indexOf(':-');
          const missingVar = defaultSeparatorIndex === -1
            ? expression
            : expression.slice(0, defaultSeparatorIndex);

          return [`${key} references \${${missingVar}} which is not defined`];
        });

        if (unresolvedEnvEntries.length > 0) {
          const errorMessage = `Session environment is invalid - environment variables not found in daemon: ${unresolvedEnvEntries.join('; ')}. ` +
            `Ensure these variables are set in the daemon's environment before starting sessions.`;
          logger.warn(`[DAEMON RUN] ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }

        // Check if tmux is available and should be used
        const tmuxAvailable = await isTmuxAvailable();
        let useTmux = tmuxAvailable;

        // Get tmux session name from environment variables (now set by profile system)
        // Empty string means "use current/most recent session" (tmux default behavior)
        let tmuxSessionName: string | undefined = extraEnv.TMUX_SESSION_NAME;

        // If tmux is not available or session name is explicitly undefined, fall back to regular spawning
        // Note: Empty string is valid (means use current/most recent tmux session)
        if (!tmuxAvailable || tmuxSessionName === undefined) {
          useTmux = false;
          if (tmuxSessionName !== undefined) {
            logger.debug(`[DAEMON RUN] tmux session name specified but tmux not available, falling back to regular spawning`);
          }
        }

        if (useTmux && tmuxSessionName !== undefined) {
          // Try to spawn in tmux session
          const sessionDesc = tmuxSessionName || 'current/most recent session';
          logger.debug(`[DAEMON RUN] Attempting to spawn session in tmux: ${sessionDesc}`);

          const tmux = getTmuxUtilities(tmuxSessionName);

          // Construct command for the CLI
          const cliPath = join(projectPath(), 'dist', 'index.mjs');
          // Determine agent command - support claude, codex, gemini, openclaw, and agy
          const agent = options.agent === 'gemini' ? 'gemini' : (options.agent === 'codex' ? 'codex' : (options.agent === 'openclaw' ? 'openclaw' : (options.agent === 'agy' ? 'agy' : 'claude')));
          const resumeId = agent === 'claude'
            ? options.resumeClaudeSessionId
            : (agent === 'codex' ? options.resumeCodexThreadId : undefined);
          const resumeFragment = resumeId
            ? ` --resume ${shellescape(resumeId)}`
            : '';
          const launchArgs = [
            agent,
            '--happy-starting-mode', 'remote',
            '--started-by', 'daemon',
          ];
          appendDaemonSpawnModeArgs(launchArgs, options, agent);
          const modeFragment = launchArgs.map(shellescape).join(' ');
          const fullCommand = `node --no-warnings --no-deprecation ${shellescape(cliPath)} ${modeFragment}${resumeFragment}`;
          const sanitizedTmuxCommand = wrapTmuxCommandWithSessionEnvironmentSanitizer(fullCommand, extraEnv);

          // Spawn in tmux with environment variables.
          // IMPORTANT: Pass the complete safe environment (ambient + extraEnv) because:
          // 1. tmux sessions need daemon's expanded auth variables (e.g., ANTHROPIC_AUTH_TOKEN)
          // 2. regular spawning uses the same clean environment
          // 3. tmux needs explicit -e values, and the command unsets omitted
          //    session variables that could otherwise survive in its server environment
          const windowName = `happy-${Date.now()}-${agent}`;
          const tmuxEnv: Record<string, string> = {};

          // Add all safe daemon environment variables (filtering out undefined)
          for (const [key, value] of Object.entries(buildSessionChildEnvironment(ambientEnvironment, extraEnv))) {
            if (value !== undefined) {
              tmuxEnv[key] = value;
            }
          }

          const tmuxResult = await tmux.spawnInTmux([sanitizedTmuxCommand], {
            sessionName: tmuxSessionName,
            windowName: windowName,
            cwd: directory
          }, tmuxEnv);  // Pass complete environment for tmux session

          if (tmuxResult.success) {
            logger.debug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

            // Validate we got a PID from tmux
            if (!tmuxResult.pid) {
              throw new Error('Tmux window created but no PID returned');
            }

            // Create a tracked session for tmux windows - now we have the real PID!
            const trackedSession: TrackedSession = {
              startedBy: 'daemon',
              pid: tmuxResult.pid, // Real PID from tmux -P flag
              tmuxSessionId: tmuxResult.sessionId,
              directoryCreated,
              message: directoryCreated
                ? `The path '${directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
                : `Spawned new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
            };

            // Add to tracking map so webhook can find it later
            pidToTrackedSession.set(tmuxResult.pid, trackedSession);

            // Wait for webhook to populate session with happySessionId (exact same as regular flow)
            logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxResult.pid} (tmux)`);

            return new Promise((resolve) => {
              // Set timeout for webhook (same as regular flow)
              const timeout = setTimeout(() => {
                pidToAwaiter.delete(tmuxResult.pid!);
                logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${tmuxResult.pid} (tmux)`);
                resolve({
                  type: 'error',
                  errorMessage: `Session webhook timeout for PID ${tmuxResult.pid} (tmux)`
                });
              }, 15_000); // Same timeout as regular sessions

              // Register awaiter for tmux session (exact same as regular flow)
              pidToAwaiter.set(tmuxResult.pid!, (completedSession) => {
                clearTimeout(timeout);
                logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook (tmux)`);
                resolve({
                  type: 'success',
                  sessionId: completedSession.happySessionId!
                });
              });
            });
          } else {
            logger.debug(`[DAEMON RUN] Failed to spawn in tmux: ${tmuxResult.error}, falling back to regular spawning`);
            useTmux = false;
          }
        }

        // Regular process spawning (fallback or if tmux not available)
        if (!useTmux) {
          logger.debug(`[DAEMON RUN] Using regular process spawning`);

          // Construct arguments for the CLI - support claude, codex, and gemini
          let agentCommand: string;
          switch (options.agent) {
            case 'claude':
            case undefined:
              agentCommand = 'claude';
              break;
            case 'codex':
              agentCommand = 'codex';
              break;
            case 'gemini':
              agentCommand = 'gemini';
              break;
            case 'openclaw':
              agentCommand = 'openclaw';
              break;
            case 'agy':
              agentCommand = 'agy';
              break;
            default:
              return {
                type: 'error',
                errorMessage: `Unsupported agent type: '${options.agent}'. Please update your CLI to the latest version.`
              };
          }
          const args = [
            agentCommand,
            '--happy-starting-mode', 'remote',
            '--started-by', 'daemon'
          ];
          appendDaemonSpawnModeArgs(args, options, agentCommand);

          // Resume ids attach the new LMC session to a pre-existing provider
          // conversation created by the fork / duplicate RPC.
          if (options.resumeClaudeSessionId && agentCommand === 'claude') {
            args.push('--resume', options.resumeClaudeSessionId);
          }
          if (options.resumeCodexThreadId && agentCommand === 'codex') {
            args.push('--resume', options.resumeCodexThreadId);
          }

          // TODO: In future, sessionId could be used with --resume to continue existing sessions
          // For now, we ignore it - each spawn creates a new session
          return spawnTrackedLmcProcess({
            args,
            cwd: directory,
            env: buildSessionChildEnvironment(ambientEnvironment, extraEnv),
            directoryCreated,
            message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined,
          });
        }

        // This should never be reached, but TypeScript requires a return statement
        return {
          type: 'error',
          errorMessage: 'Unexpected error in session spawning'
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
        return {
          type: 'error',
          errorMessage: `Failed to spawn session: ${errorMessage}`
        };
      }
    };

    const spawnTrackedLmcProcess = ({
      args,
      cwd,
      env,
      directoryCreated = false,
      message,
    }: {
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      directoryCreated?: boolean;
      message?: string;
    }): Promise<SpawnSessionResult> => {
      const happyProcess = spawnLmcCLI(args, {
        cwd,
        detached: true,
        stdio: 'ignore',
        env,
      });

      if (!happyProcess.pid) {
        logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
        return Promise.resolve({
          type: 'error',
          errorMessage: 'Failed to spawn the LMC process - no PID returned'
        });
      }

      logger.debug(`[DAEMON RUN] Spawned process with PID ${happyProcess.pid}`);

      const trackedSession: TrackedSession = {
        startedBy: 'daemon',
        pid: happyProcess.pid,
        childProcess: happyProcess,
        directoryCreated,
        message,
      };

      pidToTrackedSession.set(happyProcess.pid, trackedSession);

      happyProcess.on('exit', (code, signal) => {
        logger.debug(`[DAEMON RUN] Child PID ${happyProcess.pid} exited with code ${code}, signal ${signal}`);
        if (happyProcess.pid) {
          onChildExited(happyProcess.pid);
        }
      });

      happyProcess.on('error', (error) => {
        logger.debug(`[DAEMON RUN] Child process error:`, error);
        if (happyProcess.pid) {
          onChildExited(happyProcess.pid);
        }
      });

      logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${happyProcess.pid}`);

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pidToAwaiter.delete(happyProcess.pid!);
          logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${happyProcess.pid}`);
          resolve({
            type: 'error',
            errorMessage: `Session webhook timeout for PID ${happyProcess.pid}`
          });
        }, 15_000);

        pidToAwaiter.set(happyProcess.pid!, (completedSession) => {
          clearTimeout(timeout);
          logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook`);
          resolve({
            type: 'success',
            sessionId: completedSession.happySessionId!
          });
        });
      });
    };

    const findTrackedSessionById = (happySessionId: string): TrackedSession | undefined => {
      for (const session of pidToTrackedSession.values()) {
        if (session.happySessionId === happySessionId) return session;
      }
      return sessionIdToFinishedSession.get(happySessionId);
    };

    /** See sessionSpawnGuard.ts: one live CLI process per LMC session. */
    const findLiveSession = (happySessionId: string): TrackedSession | undefined =>
      findLiveSessionProcess(
        pidToTrackedSession,
        happySessionId,
        isProcessAlive,
        (pid) => logger.debug(`[DAEMON RUN] Tracked PID ${pid} for session ${happySessionId} is gone, dropping`),
      );

    const resumesInFlight = new SingleFlight<SpawnSessionResult>();

    const fetchServerSessionMetadata = async (sessionId: string, encryptionKey: Uint8Array, encryptionVariant: 'legacy' | 'dataKey'): Promise<Metadata | null> => {
      try {
        let cursor: string | undefined;
        let matched: {id:string;metadata:string} | undefined;
        do {
          const response = await axios.get(`${configuration.serverUrl}/v2/sessions`, {
            headers: { Authorization: `Bearer ${credentials.token}` },
            params: {limit:200,...(cursor?{cursor}:{})},timeout:10_000,
          });
          const page=response.data as {sessions:{id:string;metadata:string}[];nextCursor?:string;hasNext?:boolean};
          matched=page.sessions.find(s=>s.id===sessionId);
          if(matched)break;
          const next=page.hasNext?page.nextCursor:undefined;
          if(next===cursor)break;
          cursor=next;
        }while(cursor);
        if(!matched)return null;
        const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(matched.metadata));
        return decrypted as Metadata | null;
      } catch (error) {
        logger.debug(`[DAEMON RUN] Failed to fetch session metadata from server: ${error instanceof Error ? error.message : error}`);
        return null;
      }
    };

    const resumeSession = async (happySessionId: string, options?: { model?: string; permissionMode?: string; receiveSeq?: number; effort?: string; codexServiceTier?: CodexServiceTier; codexContextLimits?: CodexContextLimits }): Promise<SpawnSessionResult> => {
      // Resume is idempotent: one live process per session, always.
      const live = findLiveSession(happySessionId);
      if (live) {
        logger.debug(`[DAEMON RUN] Session ${happySessionId} already running as PID ${live.pid}, not spawning a second process`);
        return { type: 'success', sessionId: happySessionId };
      }

      // The daemon replaces itself when its bundle changes, and sessions are
      // spawned detached — so a session running under a previous daemon is
      // absent from the tracking map but very much alive. See sessionSpawnGuard.
      let orphanPid: number | undefined;
      try {
        orphanPid = await findOrphanedSessionPid(
          sessionIdToFinishedSession.get(happySessionId),
          () => psList(),
        );
      } catch (error) {
        return { type: 'error', errorMessage: error instanceof Error ? error.message : 'Cannot verify existing session process; refusing a duplicate.' };
      }
      if (orphanPid) {
        logger.debug(`[DAEMON RUN] Session ${happySessionId} still running as orphaned PID ${orphanPid}, not spawning a second process`);
        return { type: 'success', sessionId: happySessionId };
      }

      // A replacement spawned through another path answers to neither check above.
      const resumeMetadata = sessionIdToFinishedSession.get(happySessionId)?.happySessionMetadataFromLocalWebhook;
      const providerSessionId = resumeMetadata?.flavor === 'codex' ? resumeMetadata?.codexThreadId : resumeMetadata?.claudeSessionId;
      let providerPid: number | undefined;
      try {
        providerPid = findProviderSessionPid(await psList(), providerSessionId ?? undefined, pid => {
          const owner = pidToTrackedSession.get(pid);
          return !!owner && owner.happySessionId !== happySessionId;
        });
      } catch (error) {
        return { type: 'error', errorMessage: error instanceof Error ? error.message : 'Cannot verify existing session process; refusing a duplicate.' };
      }
      if (providerPid) {
        logger.debug(`[DAEMON RUN] Session ${happySessionId} already resumed by PID ${providerPid} (provider session ${providerSessionId}), not spawning a second process`);
        return { type: 'success', sessionId: happySessionId };
      }

      return resumesInFlight.run(
        happySessionId,
        () => resumeSessionUnguarded(happySessionId, options),
        () => logger.debug(`[DAEMON RUN] Resume of session ${happySessionId} already in flight, joining it`),
      );
    };

    const resumeSessionUnguarded = async (happySessionId: string, options?: SessionRefreshOptions): Promise<SpawnSessionResult> => {
      try {
        const tracked = findTrackedSessionById(happySessionId);
        if (!tracked) {
          return { type: 'error', errorMessage: `Session ${happySessionId} is not tracked by this daemon. It may have been started before the daemon or on another machine.` };
        }
        if (!tracked.happySessionMetadataFromLocalWebhook) {
          return { type: 'error', errorMessage: `Session ${happySessionId} has no metadata. Cannot resume.` };
        }
        if (!tracked.encryption) {
          return { type: 'error', errorMessage: `Session ${happySessionId} has no stored encryption data. It was likely started before this feature was available. Restart the daemon and start a new session to enable resume.` };
        }

        // Webhook metadata may be stale (missing claudeSessionId/codexThreadId set after startup).
        // Fetch fresh metadata from server if needed.
        let metadata = tracked.happySessionMetadataFromLocalWebhook;
        const needsFetch = (!metadata.claudeSessionId && (!metadata.flavor || metadata.flavor === 'claude'))
          || (!metadata.codexThreadId && metadata.flavor === 'codex');
        if (needsFetch) {
          logger.debug(`[DAEMON RUN] Session ${happySessionId} missing agent session ID in webhook metadata, fetching from server`);
          const serverMetadata = await fetchServerSessionMetadata(happySessionId, tracked.encryption.encryptionKey, tracked.encryption.encryptionVariant);
          if (serverMetadata) {
            metadata = serverMetadata;
            tracked.happySessionMetadataFromLocalWebhook = serverMetadata;
          }
        }

        // A switch relaunches as the other engine on a new native thread. The
        // stored flavor still names the engine that just exited; it is the new
        // runner that writes the new one, once it is actually up.
        const target = options?.engine ?? metadata.flavor;
        const launch = buildResumeLaunch(
          { id: happySessionId, active: true, metadata: { ...metadata, flavor: target } },
          { startedBy: 'daemon', claudeStartingMode: 'remote', startFresh: options?.engine !== undefined },
        );

        if (target === 'codex') assertCodexModelEffort(options?.model, options?.effort);
        if (options?.effort) launch.args.push('--effort', options.effort);
        if (options?.model) {
          launch.args.push('--model', options.model);
        }
        const resumePermissionMode = options?.permissionMode;
        if (shouldForwardDaemonPermissionMode(target ?? 'claude', resumePermissionMode)) {
          launch.args.push('--permission-mode', resumePermissionMode);
        }

        if (target === 'codex') launch.args.push(...codexContextLimitArgs(options?.codexContextLimits), ...codexServiceTierArgs(options?.codexServiceTier));

        await fs.access(launch.cwd);

        return spawnTrackedLmcProcess({
          args: launch.args,
          cwd: launch.cwd,
          env: buildSessionChildEnvironment(ambientEnvironment, {
            ...(options?.receiveSeq !== undefined ? { HAPPY_REFRESH_RECEIVE_SEQ: String(options.receiveSeq) } : {}),
            // A switch starts the engine on a thread it has never had. The
            // replacement checks itself against its resume record after a
            // refresh; there is nothing to check against here, and requiring
            // one reports every completed switch as a failure.
            ...(options?.engine !== undefined ? { HAPPY_REFRESH_ENGINE_SWITCH: '1' } : {}),
            HAPPY_RECONNECT_SESSION_ID: happySessionId,
            HAPPY_RECONNECT_ENCRYPTION_KEY: encodeBase64(tracked.encryption.encryptionKey),
            HAPPY_RECONNECT_ENCRYPTION_VARIANT: tracked.encryption.encryptionVariant,
            HAPPY_RECONNECT_SEQ: String(tracked.encryption.seq),
            HAPPY_RECONNECT_METADATA_VERSION: String(tracked.encryption.metadataVersion),
            HAPPY_RECONNECT_AGENT_STATE_VERSION: String(tracked.encryption.agentStateVersion),
          }),
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : (error && typeof error === 'object' ? JSON.stringify(error) : String(error));
        logger.debug(`[DAEMON RUN] Failed to resume session: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
        return {
          type: 'error',
          errorMessage: `Failed to resume session: ${errorMessage}`,
        };
      }
    };

    // Stop a session by sessionId or PID fallback
    const stopSession = (sessionId: string): boolean => {
      logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

      // Try to find by sessionId first
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.happySessionId === sessionId ||
          (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {

          if (session.startedBy === 'daemon' && session.childProcess) {
            // Signal the whole process group, not just the LMC CLI parent.
            // The harness runs its own backend as a grandchild — Codex spawns
            // `codex app-server` (codexAppServerClient.ts:647) and only kills it
            // from its own disconnect path, which a bare SIGTERM to the parent
            // never reaches. Killing the parent alone therefore left the agent
            // running, reparented and invisible. The daemon spawns with
            // `detached: true` (see spawnSession above), which makes the parent
            // a group leader, so the negative pid covers every descendant.
            let signalled = false;
            if (process.platform !== 'win32') {
              try {
                process.kill(-pid, 'SIGTERM');
                signalled = true;
                logger.debug(`[DAEMON RUN] Sent SIGTERM to process group of session ${sessionId}`);
              } catch (error) {
                logger.debug(`[DAEMON RUN] Group kill failed for session ${sessionId}, falling back:`, error);
              }
            }
            // Windows has no process groups to signal, and a group kill can
            // still fail if the child already exited or never led a group.
            // Either way the parent is worth killing on its own.
            if (!signalled) {
              try {
                session.childProcess.kill('SIGTERM');
                logger.debug(`[DAEMON RUN] Sent SIGTERM to daemon-spawned session ${sessionId}`);
              } catch (error) {
                logger.debug(`[DAEMON RUN] Failed to kill session ${sessionId}:`, error);
              }
            }
          } else {
            // For externally started sessions, try to kill by PID
            try {
              process.kill(pid, 'SIGTERM');
              logger.debug(`[DAEMON RUN] Sent SIGTERM to external session PID ${pid}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill external session PID ${pid}:`, error);
            }
          }

          pidToTrackedSession.delete(pid);
          logger.debug(`[DAEMON RUN] Removed session ${sessionId} from tracking`);
          return true;
        }
      }

      logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
      return false;
    };

    // Handle child process exit — preserve session data for resume
    const onChildExited = (pid: number) => {
      const session = pidToTrackedSession.get(pid);
      if (session?.happySessionId && session.encryption) {
        sessionIdToFinishedSession.set(session.happySessionId, session);
        logger.debug(`[DAEMON RUN] Process PID ${pid} exited, preserved session ${session.happySessionId} for resume`);
      } else {
        logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
      }
      pidToTrackedSession.delete(pid);
    };

    const refreshJobs = new Map<string, RefreshJob>();
    const refreshJournal = new RefreshJournal(join(configuration.lmcHomeDir, 'refresh-jobs'));
    const watchRefreshJob = (job: RefreshJob) => {
      refreshJobs.set(job.sessionId, job);
      void resumeAfterExit(job.pid, pid => { try { process.kill(pid, 0); return true; } catch { return false; } }, async () => {
        const tracked = findTrackedSessionById(job.sessionId);
        if (!tracked?.encryption) throw new Error('无法核验恢复身份，刷新任务已保留');
        // The previous daemon may have spawned the replacement moments before handing
        // over; its webhook reaches us before the server copy of hostPid does. A live
        // tracked process other than the one we are waiting for already owns the session.
        const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
        if (tracked.pid && tracked.pid !== job.pid && alive(tracked.pid)) {
          logger.debug(`[DAEMON] Session ${job.sessionId} already replaced by PID ${tracked.pid}; dropping refresh job`);
          await refreshJournal.remove(job.sessionId); return;
        }
        const metadata = await fetchServerSessionMetadata(job.sessionId, tracked.encryption.encryptionKey, tracked.encryption.encryptionVariant);
        if (!metadata) throw new Error('无法读取会话，刷新任务已保留');
        // A replacement already owns the session: never launch another copy.
        if (metadata.hostPid !== job.pid) {
          if (metadata.sessionConfigState !== 'applied') throw new Error('会话所有者已变化，请检查当前会话');
          await refreshJournal.remove(job.sessionId); return;
        }
        tracked.happySessionMetadataFromLocalWebhook = metadata;
        const result = await resumeSession(job.sessionId, job.options);
        if (result.type !== 'success') throw new Error('Failed to resume refreshed session');
        await refreshJournal.remove(job.sessionId);
      }, () => new Promise(resolve => setTimeout(resolve, 500))).catch(async error => {
        logger.warn('[DAEMON] Session refresh failed', error);
        await refreshJournal.put({...job,state:'error',updatedAt:Date.now(),error:error instanceof Error ? error.message : '刷新失败'});
      }).finally(() => refreshJobs.delete(job.sessionId));
    };
    const prepareSessionRefresh = async (sessionId: string, pid: number, options: SessionRefreshOptions): Promise<{ error?: string }> => {
      const tracked = findTrackedSessionById(sessionId);
      if (!await canRefreshSession(tracked, pid, () => psList())) {
        return { error: 'Session identity or resume data unavailable; no process was stopped' };
      }
      try {
        const metadata = await fetchServerSessionMetadata(sessionId, tracked!.encryption!.encryptionKey, tracked!.encryption!.encryptionVariant);
        if (!metadata || metadata.flavor !== tracked!.happySessionMetadataFromLocalWebhook?.flavor
            || metadata.hostPid !== pid) throw new Error('无法核验恢复身份，原会话已保留');
        // A switch is checked against where the session is going, not where it
        // is: the Codex-only settings belong to the destination.
        const target = options.engine ?? metadata.flavor;
        const launch = buildResumeLaunch(
          { id: sessionId, active: true, metadata: { ...metadata, flavor: target } },
          { startedBy: 'daemon', claudeStartingMode: 'remote', startFresh: options.engine !== undefined },
        );
        await fs.access(launch.cwd);
        if (target === 'codex') {
          validateCodexContextLimits(options.codexContextLimits);
          validateCodexServiceTier(options.codexServiceTier);
          assertCodexModelEffort(options.model, options.effort);
        } else if (options.codexContextLimits !== undefined || options.codexServiceTier !== undefined) {
          throw new Error('Claude 不支持 Codex 专属配置');
        }
        tracked!.happySessionMetadataFromLocalWebhook = metadata;
      } catch (error) { return { error: error instanceof Error ? error.message : 'Invalid refresh settings' }; }
      const existing = refreshJobs.get(sessionId);
      if (existing) {
        if (existing.pid !== pid) return { error: 'A different process is already refreshing' };
        // The first accepted cursor is immutable; a retry must not skip queued input.
        return {};
      }
      const job: RefreshJob = { sessionId, pid, options, state:'waiting', updatedAt:Date.now() };
      await refreshJournal.put(job); // Durably accepted before the old session is allowed to exit.
      watchRefreshJob(job);
      return {};
    };

    // Resume accepted handoffs after daemon replacement. Never stop the old process.
    for (const job of await refreshJournal.list()) {
      if (job.state === 'waiting') watchRefreshJob(job);
    }

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      prepareSessionRefresh,
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('happy-cli'),
      onHappySessionWebhook
    });

    // Write initial daemon state (no lock needed for state file)
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      daemonLogPath: logger.logFilePath,
      ...(startedBySupervisor ? { supervisor: 'launchd' as const } : {}),
    };
    writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');

    // Capture the bundled CLI's mtime at startup so the heartbeat can detect
    // when npm replaces `dist/index.mjs` on disk (= the user ran `npm i -g happy`).
    // We previously compared disk `package.json.version` to our bundled version,
    // but that produced infinite restart loops (#1107) when the manifest version
    // diverged from the bundled version (e.g. `happy-coder@0.13.1` deprecation
    // stub bumped package.json without rebuilding dist). File mtime is a more
    // reliable signal: it only changes when the bundle is actually replaced.
    const bundlePath = join(projectPath(), 'dist', 'index.mjs');
    let initialBundleMtimeMs = 0;
    try {
      initialBundleMtimeMs = statSync(bundlePath).mtimeMs;
    } catch {
      // dist/index.mjs not present (e.g. dev mode via tsx) — skip upgrade detection.
      logger.debug(`[DAEMON RUN] Bundle at ${bundlePath} not found; self-restart on upgrade disabled`);
    }

    // Prepare initial daemon state
    const initialDaemonState: DaemonState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now()
    };

    // Create API client
    const api = await ApiClient.create(credentials);

    // Get or create machine
    const machine = await api.getOrCreateMachine({
      machineId,
      metadata: initialMachineMetadata,
      daemonState: initialDaemonState
    });
    logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);
    // Live detections keep their own refresh path; everything else is declared here.
    const { cliAvailability: _cli, resumeSupport: _resume, ...declaredMachineMetadata } = initialMachineMetadata;
    apiMachine.declareMetadata(declaredMachineMetadata);

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      resumeSession,
      stopSession,
      requestShutdown: () => requestShutdown('happy-app')
    });

    // Connect to server
    apiMachine.connect();

    const upgradeManager = new UpgradeManager(configuration.lmcHomeDir, {
      ready: () => agentRoot() === projectPath(),
      stage: stageRelease,
      activate: activateRelease,
      inspect: async () => ({}),
      // Only the Agent's own catalog can be read without cost or effect; an
      // engine upgrade would have to reach npm to answer this, so it offers no
      // answer and a job in flight keeps the slot.
      supersedes: async (engine, inProgress) => {
        if (engine !== 'agent') return false;
        try { return (await latestVersion('agent')) !== inProgress.version; }
        catch { return false; }
      },
      sessions: async engine => {
        const all = new Map([...sessionIdToFinishedSession, ...Array.from(pidToTrackedSession.values()).filter(s=>s.happySessionId).map(s=>[s.happySessionId!,s] as const)]);
        const jobs: {id:string;state:'pending'}[]=[];
        for(const [id,tracked] of all){
          if(engine!=='agent' && tracked.happySessionMetadataFromLocalWebhook?.flavor!==engine)continue;
          const live=findLiveSession(id)?.pid ?? await findOrphanedSessionPid(tracked,()=>psList());
          if(live)jobs.push({id,state:'pending'});
        }
        return jobs;
      },
      // Long enough that an ordinary turn ends first, short enough that a
      // session which never reports a boundary is asked again while anyone is
      // still watching the rollout. Re-asking is idempotent: the runner's own
      // refresh returns early when one is already pending.
      refresh: async (job,release) => {
        const tracked=findTrackedSessionById(job.id);
        if(!tracked?.encryption)return {state:'blocked',error:'缺少会话恢复身份，未停止原进程'};
        const {encryptionKey,encryptionVariant}=tracked.encryption;
        const metadata=await fetchServerSessionMetadata(job.id,encryptionKey,encryptionVariant);
        if(!metadata)throw new Error('暂时无法读取会话状态，将重试');
        const actual=metadata.engineRuntime;
        const matched=release.engine==='agent'
          ? metadata.agentBuild === (release as any).sha256
          : (actual?.packageVersion ?? actual?.version)===release.version;
        const pid=metadata.hostPid ?? tracked.pid;
        let alive=false;
        if(typeof pid==='number'&&pid>0){try{process.kill(pid,0);alive=true;}catch{alive=false;}}
        const decision=decideRefresh(job,{sessionConfigState:metadata.sessionConfigState,sessionConfigError:metadata.sessionConfigError,sessionConfigUpdatedAt:metadata.sessionConfigUpdatedAt,matched,refreshSupported:refreshSupported(metadata)},alive,Date.now());
        if(decision.kind==='complete')return {state:'complete',error:undefined};
        if(decision.kind==='blocked')return {state:'blocked',error:decision.error};
        if(decision.kind==='waiting')return {state:'waiting',error:undefined};
        await apiMachine.callSession(job.id,encryptionKey,encryptionVariant,'configure-session',{refreshCli:true});
        return {state:'waiting',error:undefined,attempts:decision.attempts};
      },
    });
    apiMachine.registerDeviceHandler('runtime-status', async () => ({
      ...await upgradeManager.status(), selection:readRuntimeSelection(), agentVersion:packageJson.version, agentSwitching:agentRoot() !== projectPath(),
      engines:await Promise.all(['codex','claude'].map(async engine=>{
        try{return await runtimeVersion(engine as 'codex'|'claude',true);}catch{return {engine,error:'无法读取实际引擎版本'};}
      })),
    }));
    apiMachine.registerDeviceHandler('runtime-latest',async()=>Object.fromEntries(await Promise.all(['codex','claude','agent'].map(async engine=>{
      try{return [engine,await latestVersion(engine as 'codex'|'claude'|'agent')];}catch{return [engine,null];}
    }))));
    apiMachine.registerDeviceHandler('runtime-upgrade',async data=>upgradeManager.start(data?.engine));
    apiMachine.registerDeviceHandler('runtime-retry',async()=>upgradeManager.retry());
    apiMachine.registerDeviceHandler('runtime-rollback',async()=>{
      const job=(await upgradeManager.status()).job;
      if(job && ['installing','activating','refreshing'].includes(job.state))throw new Error('请等待当前升级交接结束后回退');
      return rollbackRelease();
    });
    const upgradeTimer=setInterval(()=>{void upgradeManager.tick().catch(error=>logger.warn('[UPGRADE] 状态协调失败',error));},5000);
    upgradeTimer.unref();


    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMs = parseInt(process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL || '60000');
    let heartbeatRunning = false
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions
      for (const [pid, _] of pidToTrackedSession.entries()) {
        try {
          // Check if process is still alive (signal 0 doesn't kill, just checks)
          process.kill(pid, 0);
        } catch (error) {
          // Process is dead, remove from tracking
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          pidToTrackedSession.delete(pid);
        }
      }

      // Check if daemon needs update by detecting whether `dist/index.mjs` was
      // replaced on disk since the daemon started (npm install rewrites the file).
      // Skip if we never captured an initial mtime (dev mode).
      let bundleReplaced = false;
      if (initialBundleMtimeMs > 0) {
        try {
          const currentMtimeMs = statSync(bundlePath).mtimeMs;
          bundleReplaced = currentMtimeMs !== initialBundleMtimeMs;
        } catch {
          // File temporarily missing (e.g. mid-install) — retry on next heartbeat.
        }
      }
      if (bundleReplaced || agentRoot() !== projectPath()) {
        // TODO: We probably do not want to keep this in-process self-restart logic long-term.
        // A native service manager would make startup and upgrades much simpler: the CLI would
        // ask the OS to start the latest daemon instead of hand-rolling respawn/kill behavior here.
        logger.debug('[DAEMON RUN] Daemon bundle replaced on disk, handing off to new daemon');

        clearInterval(restartOnStaleVersionAndHeartbeat);

        // Release ownership BEFORE spawning the new daemon. Otherwise the spawned
        // `lmc daemon start` reads our still-present daemon.state.json, sees
        // isDaemonRunningCurrentlyInstalledLmcVersion() === true, and exits —
        // leaving nothing running once we also exit.
        apiMachine.shutdown();
        await stopControlServer();
        await cleanupDaemonState();
        await releaseDaemonLock(daemonLockHandle);
        await stopCaffeinate();

        try {
          spawnLmcCLI(['daemon', 'start'], {
            detached: true,
            stdio: 'ignore',
            env: ambientEnvironment,
          });
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to spawn new daemon, this is quite likely to happen during integration tests as we are cleaning out dist/ directory', error);
        }

        process.exit(0);
      }

      // Before wrecklessly overriting the daemon state file, we should check if we are the ones who own it
      // Race condition is possible, but thats okay for the time being :D
      const daemonState = await readDaemonState();
      if (daemonState && daemonState.pid !== process.pid) {
        logger.debug('[DAEMON RUN] Somehow a different daemon was started without killing us. We should kill ourselves.')
        requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.')
      }

      // Heartbeat
      try {
        const updatedState = heartbeatDaemonState(fileState, {
          pid: process.pid,
          httpPort: controlPort,
          startedWithCliVersion: packageJson.version,
        }, new Date().toLocaleString());
        writeDaemonState(updatedState);
        if (process.env.DEBUG) {
          logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
      }

      heartbeatRunning = false;
    }, heartbeatIntervalMs); // Every 60 seconds in production

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }

      // Update daemon state before shutting down
      await apiMachine.updateDaemonState((state: DaemonState | null) => ({
        ...state,
        status: 'shutting-down',
        shutdownRequestedAt: Date.now(),
        shutdownSource: source
      }));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      apiMachine.shutdown();
      await stopControlServer();
      await cleanupDaemonState();
      await stopCaffeinate();
      await releaseDaemonLock(daemonLockHandle);

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(1);
  }
}

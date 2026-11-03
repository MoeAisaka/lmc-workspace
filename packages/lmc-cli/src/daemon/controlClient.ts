import { assertSessionOwnerAvailable, SessionOwnershipConflict, SESSION_OWNERSHIP_CONFLICT } from './sessionOwnership';
import { SESSION_START_RPC_TIMEOUT_MS } from 'lmc-wire';
import type { SessionRefreshOptions } from './sessionRefresh';
import { isTransientRefreshError } from '@/runtime/refreshDecision';
/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { clearDaemonState, readDaemonState } from '@/persistence';
import { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { listSessionProcesses } from './sessionProcesses';
import { isLmcDaemonProcess } from './sessionSpawnGuard';

async function daemonPost(path: string, body?: any, timeoutMs = 10_000): Promise<{ error?: string } | any> {
  const state = await readDaemonState();
  if (!state?.httpPort) {
    const errorMessage = 'No daemon running, no state file found';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    process.kill(state.pid, 0);
  } catch (error) {
    const errorMessage = 'Daemon is not running, file is stale';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    const timeout = process.env.HAPPY_DAEMON_HTTP_TIMEOUT ? parseInt(process.env.HAPPY_DAEMON_HTTP_TIMEOUT) : timeoutMs;
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      // Mostly increased for stress test
      signal: AbortSignal.timeout(timeout)
    });
    
    if (response.status === 409) {
      const conflict = await response.json().catch(() => null) as { code?: string; error?: string } | null;
      if (conflict?.code === SESSION_OWNERSHIP_CONFLICT) return conflict;
    }
    if (!response.ok) {
      const errorMessage = `Request failed: ${path}, HTTP ${response.status}`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      return {
        error: errorMessage
      };
    }
    
    return await response.json();
  } catch (error) {
    const errorMessage = `Request failed: ${path}, ${error instanceof Error ? error.message : 'Unknown error'}`;
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    }
  }
}

const SESSION_STARTED_RETRY_TIMEOUT_MS = 3000;
const SESSION_STARTED_RETRY_INTERVAL_MS = 100;

export async function notifyDaemonSessionStarted(
  sessionId: string,
  metadata: Metadata,
  encryption?: {
    encryptionKey: string;
    encryptionVariant: 'legacy' | 'dataKey';
    seq: number;
    metadataVersion: number;
    agentStateVersion: number;
  }
): Promise<{ error?: string } | any> {
  // Retry briefly — ensureDaemonRunning already waits for readiness, but we may
  // race a daemon that is mid-restart (version upgrade, crash recovery). Without
  // this, the session's encryption data never reaches the daemon and the mobile
  // app's resume-happy-session RPC fails with "not tracked by this daemon".
  const payload = { sessionId, metadata, encryption };
  const deadline = Date.now() + SESSION_STARTED_RETRY_TIMEOUT_MS;
  let result: { error?: string } | any;

  while (true) {
    result = await daemonPost('/session-started', payload);
    if (result?.code === SESSION_OWNERSHIP_CONFLICT) throw new SessionOwnershipConflict(result.error);
    if (!result?.error) {
      return result;
    }
    if (Date.now() >= deadline) {
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, SESSION_STARTED_RETRY_INTERVAL_MS));
  }
}

export async function listDaemonSessions(): Promise<any[]> {
  const result = await daemonPost('/list');
  return result.children || [];
}

export async function stopDaemonSession(sessionId: string): Promise<boolean> {
  const result = await daemonPost('/stop-session', { sessionId });
  return result.success || false;
}

export async function spawnDaemonSession(directory: string, sessionId?: string): Promise<any> {
  const result = await daemonPost('/spawn-session', { directory, sessionId }, SESSION_START_RPC_TIMEOUT_MS);
  return result;
}

/**
 * A hub starting a worker on its own machine: the daemon spawns it with the
 * binding and title in its environment, so the worker is born bound.
 */
export async function spawnDaemonSessionWith(options: { directory: string; agent: 'claude' | 'codex' | 'agy'; modelMode?: string; effortLevel?: string; permissionMode?: string; hubSessionId: string; title: string }): Promise<{ success: boolean; sessionId?: string; error?: string }> {
  const result = await daemonPost('/spawn-session', options, SESSION_START_RPC_TIMEOUT_MS);
  if (result?.error) return { success: false, error: String(result.error) };
  return { success: !!result?.success, sessionId: result?.sessionId, error: result?.success ? undefined : (result?.actionRequired ?? 'spawn refused') };
}

export async function stopDaemonHttp(): Promise<void> {
  await daemonPost('/stop');
}

/**
 * The version check is still quite naive.
 * For instance we are not handling the case where we upgraded happy,
 * the daemon is still running, and it recieves a new message to spawn a new session.
 * This is a tough case - we need to somehow figure out to restart ourselves,
 * yet still handle the original request.
 * 
 * Options:
 * 1. Periodically check during the health checks whether our version is the same as CLIs version. If not - restart.
 * 2. Wait for a command from the machine session, or any other signal to
 * check for version & restart.
 *   a. Handle the request first
 *   b. Let the request fail, restart and rely on the client retrying the request
 * 
 * I like option 1 a little better.
 * Maybe we can ... wait for it ... have another daemon to make sure 
 * our daemon is always alive and running the latest version.
 * 
 * That seems like an overkill and yet another process to manage - lets not do this :D
 * 
 * TODO: This function should return a state object with
 * clear state - if it is running / or errored out or something else.
 * Not just a boolean.
 * 
 * We can destructure the response on the caller for richer output.
 * For instance when running `lmc daemon status` we can show more information.
 */
export async function checkIfDaemonRunningAndCleanupStaleState(): Promise<boolean> {
  const state = await readDaemonState();
  if (!state) {
    return false;
  }

  // Check if the PID is alive
  try {
    process.kill(state.pid, 0);
  } catch {
    logger.debug('[DAEMON RUN] Daemon PID not running, cleaning up state');
    await cleanupDaemonState(state.pid);
    return false;
  }

  // PID is alive, but on Windows PIDs get reused after reboot.
  // Verify it's actually our daemon by HTTP pinging its control server.
  if (state.httpPort) {
    try {
      const response = await fetch(`http://127.0.0.1:${state.httpPort}/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(2000)
      });
      if (response.ok) {
        return true;
      }
    } catch { /* A timeout is not evidence that the process is unrelated. */ }

    let owner;
    try {
      owner = (await listSessionProcesses()).find(item => item.pid === state.pid);
      if (owner && !owner.cmd?.trim()) throw new Error('Command unavailable');
    } catch {
      throw new Error('Cannot verify existing daemon process; keeping its state and refusing a duplicate. Retry when process discovery is available.');
    }
    if (owner && isLmcDaemonProcess(owner)) {
      logger.debug(`[DAEMON RUN] Control probe unavailable, but PID ${state.pid} is a verified LMC daemon; keeping its state`);
      return true;
    }
    logger.debug(`[DAEMON RUN] PID ${state.pid} no longer belongs to an LMC daemon, cleaning up stale state`);
    await cleanupDaemonState(state.pid);
    return false;
  }

  return true;
}

/**
 * Check if the running daemon version matches the current CLI version.
 * This should work from both the daemon itself & a new CLI process.
 * Works via the daemon.state.json file.
 * 
 * @returns true if versions match, false if versions differ or no daemon running
 */
export async function isDaemonRunningCurrentlyInstalledLmcVersion(): Promise<boolean> {
  logger.debug('[DAEMON CONTROL] Checking if daemon is running same version');
  const runningDaemon = await checkIfDaemonRunningAndCleanupStaleState();
  if (!runningDaemon) {
    logger.debug('[DAEMON CONTROL] No daemon running, returning false');
    return false;
  }

  const state = await readDaemonState();
  if (!state) {
    logger.debug('[DAEMON CONTROL] No daemon state found, returning false');
    return false;
  }
  
  // Compare the running daemon's recorded version against THIS CLI invocation's
  // bundled version. Both are read from the same source of truth: the `version`
  // field baked into `dist/` at build time via `import packageJson from '../package.json'`.
  //
  // Previously we read `package.json` fresh from disk on every check, but that
  // produced infinite restart loops (#1107) when `package.json.version` diverged
  // from the bundled version — e.g. when `happy-coder@0.13.1` was published as
  // a deprecation stub that bumped the manifest without rebuilding `dist/`.
  // The daemon would write its bundled version (0.13.0), read 0.13.1 from disk,
  // detect a mismatch, self-restart, and the new daemon would repeat the cycle.
  //
  // Using `configuration.currentCliVersion` instead guarantees the writer and
  // reader agree whenever they're executing the same `dist/` bundle, and still
  // correctly detects real npm upgrades (the new bundle has a new baked version).
  const currentCliVersion = configuration.currentCliVersion;
  logger.debug(`[DAEMON CONTROL] Current CLI version: ${currentCliVersion}, Daemon started with version: ${state.startedWithCliVersion}`);
  return currentCliVersion === state.startedWithCliVersion;
}

export async function cleanupDaemonState(expectedPid = process.pid): Promise<void> {
  try {
    await clearDaemonState(expectedPid);
    logger.debug('[DAEMON RUN] Daemon state file removed');
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
  }
}

export async function stopDaemon() {
  try {
    const state = await readDaemonState();
    if (!state) {
      logger.debug('No daemon state found');
      return;
    }

    logger.debug(`Stopping daemon with PID ${state.pid}`);

    // Try HTTP graceful stop
    try {
      await stopDaemonHttp();

      // Wait for daemon to die
      await waitForProcessDeath(state.pid, 2000);
      logger.debug('Daemon stopped gracefully via HTTP');
      return;
    } catch (error) {
      logger.debug('HTTP stop failed, will force kill', error);
    }

    // Force kill
    try {
      process.kill(state.pid, 'SIGKILL');
      logger.debug('Force killed daemon');
    } catch (error) {
      logger.debug('Daemon already dead');
    }
  } catch (error) {
    logger.debug('Error stopping daemon', error);
  }
}

async function waitForProcessDeath(pid: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      return; // Process is dead
    }
  }
  throw new Error('Process did not die within timeout');
}
const PREPARE_REFRESH_RETRY_TIMEOUT_MS = 20_000;
const PREPARE_REFRESH_RETRY_INTERVAL_MS = 250;

export async function prepareDaemonSessionRefresh(
  sessionId: string,
  pid: number,
  options: SessionRefreshOptions,
  retry: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ error?: string }> {
  // The daemon lists processes and reads the session from the server first; on
  // a machine restarting several sessions that passed 10 s and the session was
  // left on the old engine. Asking again is safe: an accepted job is kept as is.
  // Also ride out a daemon mid-handoff (when daemon.state.json is briefly absent
  // or stale while the replacement Agent daemon boots).
  const timeoutMs = retry.timeoutMs ?? PREPARE_REFRESH_RETRY_TIMEOUT_MS;
  const intervalMs = retry.intervalMs ?? PREPARE_REFRESH_RETRY_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  const payload = { sessionId, pid, options };

  while (true) {
    const result = await daemonPost('/prepare-session-refresh', payload, 45_000);
    if (!result?.error || !isTransientRefreshError(result.error)) {
      return result;
    }
    if (Date.now() >= deadline) {
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/** Reconnect must prove the previous runner is gone before any server writes. */
export async function assertSessionReconnectAvailable(sessionId: string): Promise<void> {
  const result = await daemonPost('/list');
  if (result?.error || !Array.isArray(result?.children)) {
    throw new Error('Cannot verify existing session ownership; refusing to reconnect.');
  }
  assertSessionOwnerAvailable(sessionId, process.pid, result.children);
}

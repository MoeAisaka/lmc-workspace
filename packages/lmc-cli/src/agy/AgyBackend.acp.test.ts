import { EventEmitter } from 'node:events';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgyBackend, type SpawnFn } from './AgyBackend';
import type { AgyUsageHandoffFs } from './AgyAcpSession';
import {
  AgyRunnerShutdownPersistenceError,
  finalizeAgyRunnerShutdown,
} from './runAgy';
import { agyUsageRecord, UsageOutbox } from '@/api/usageAnalytics';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import type { Metadata } from '@/api/types';
import { isAgyTurnCancelledError } from './stream';
import type { AgentMessage } from '@/agent/core/AgentBackend';

const requireFromHere = createRequire(import.meta.url);

interface MockAcpProcessOptions {
  ignoreSigterm?: boolean;
  ignoreSigkill?: boolean;
  deferCloseManual?: boolean;
}

interface MockAcpProcess {
  stdin: EventEmitter & {
    writable: boolean;
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  stdout: EventEmitter & { setEncoding: () => void };
  stderr: EventEmitter & { setEncoding: () => void };
  killed: boolean;
  exited: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: any[]) => boolean;
  on: (event: string, listener: (...args: any[]) => void) => any;
  once: (event: string, listener: (...args: any[]) => void) => any;
  sent: any[];
  send: (msg: unknown) => void;
  sendRawLine: (raw: string) => void;
  triggerExit: (code: number | null, signal?: NodeJS.Signals | null) => void;
  onRpc?: (msg: any, proc: MockAcpProcess) => void;
}

function createMockAcpProcess(
  onRpc?: (msg: any, proc: MockAcpProcess) => void,
  opts: MockAcpProcessOptions = {},
): MockAcpProcess {
  const emitter = new EventEmitter();
  const stdinEmitter = new EventEmitter();
  const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const sent: any[] = [];
  let inBuf = '';

  const proc: MockAcpProcess = {
    stdin: Object.assign(stdinEmitter, {
      writable: true,
      write: vi.fn((chunk: string, cb?: (err?: Error | null) => void) => {
        if (!proc.stdin.writable) {
          const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
          queueMicrotask(() => {
            stdinEmitter.emit('error', err);
            cb?.(err);
          });
          return false;
        }
        inBuf += chunk;
        let nl: number;
        while ((nl = inBuf.indexOf('\n')) >= 0) {
          const line = inBuf.slice(0, nl).trim();
          inBuf = inBuf.slice(nl + 1);
          if (!line) continue;
          const parsed = JSON.parse(line);
          sent.push(parsed);
          queueMicrotask(() => {
            proc.onRpc?.(parsed, proc);
          });
        }
        cb?.(null);
        return true;
      }),
      end: vi.fn(() => {
        proc.stdin.writable = false;
      }),
    }),
    stdout,
    stderr,
    killed: false,
    exited: false,
    exitCode: null,
    signalCode: null,
    kill: vi.fn((signal?: NodeJS.Signals) => {
      const sig = signal ?? 'SIGTERM';
      if (sig === 'SIGTERM' && opts.ignoreSigterm) {
        return true;
      }
      if (sig === 'SIGKILL' && opts.ignoreSigkill) {
        return true;
      }
      proc.killed = true;
      proc.stdin.writable = false;
      if (!opts.deferCloseManual) {
        queueMicrotask(() => proc.triggerExit(0, sig));
      }
      return true;
    }),
    emit: emitter.emit.bind(emitter),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    sent,
    send: (msg: unknown) => {
      stdout.emit('data', JSON.stringify(msg) + '\n');
    },
    sendRawLine: (raw: string) => {
      stdout.emit('data', raw + '\n');
    },
    triggerExit: (code: number | null, signal: NodeJS.Signals | null = null) => {
      if (proc.exited) return;
      proc.exited = true;
      proc.exitCode = code;
      proc.signalCode = signal;
      proc.stdin.writable = false;
      emitter.emit('exit', code, signal);
      emitter.emit('close', code, signal);
    },
    onRpc,
  };
  return proc;
}

function encodeVarint(n: number): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

function encodeLenField(fieldNo: number, payload: number[]): number[] {
  return [...encodeVarint((fieldNo << 3) | 2), ...encodeVarint(payload.length), ...payload];
}

function encodeVarintField(fieldNo: number, value: number): number[] {
  return [...encodeVarint((fieldNo << 3) | 0), ...encodeVarint(value)];
}

/** Build a valid `CortexStepGeneratorMetadata` protobuf blob for `gen_metadata.data`. */
function buildGenMetadataBlob(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  opts: { stepIndices?: number[]; modelDisplayName?: string; maxContextTokens?: number } = {},
): Uint8Array {
  const usageBytes = [
    ...encodeVarintField(2, inputTokens),
    ...encodeVarintField(3, outputTokens),
    ...encodeVarintField(5, cacheReadTokens),
  ];
  const chatStartBytes =
    opts.maxContextTokens !== undefined
      ? encodeLenField(9, encodeLenField(10, encodeVarintField(4, opts.maxContextTokens)))
      : [];
  const chatModelBytes = [
    ...encodeLenField(4, usageBytes),
    ...chatStartBytes,
    ...(opts.modelDisplayName
      ? encodeLenField(21, Array.from(Buffer.from(opts.modelDisplayName, 'utf8')))
      : []),
  ];
  const packedSteps =
    opts.stepIndices && opts.stepIndices.length > 0
      ? encodeLenField(
          2,
          opts.stepIndices.flatMap((idx) => encodeVarint(idx)),
        )
      : [];
  const rootBytes = [...packedSteps, ...encodeLenField(1, chatModelBytes)];
  return Uint8Array.from(rootBytes);
}

/** Build an in-flight `chat_start_metadata`-only `gen_metadata.data` blob (no `ModelUsageStats` yet). */
function buildInFlightGenMetadataBlob(stepIndices: number[], maxContextTokens = 200_000): Uint8Array {
  const chatStartBytes = encodeLenField(
    9,
    encodeLenField(10, encodeVarintField(4, maxContextTokens)),
  );
  const packedSteps =
    stepIndices.length > 0
      ? encodeLenField(
          2,
          stepIndices.flatMap((idx) => encodeVarint(idx)),
        )
      : [];
  return Uint8Array.from([...packedSteps, ...encodeLenField(1, chatStartBytes)]);
}

function openTestConversationDb(agyHomeDir: string, conversationId: string): any {
  const { DatabaseSync } = requireFromHere('node:sqlite');
  const convDir = join(agyHomeDir, 'conversations');
  mkdirSync(convDir, { recursive: true });
  const db = new DatabaseSync(join(convDir, `${conversationId}.db`));
  db.exec(`
    CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
  `);
  return db;
}

function sessionCatalogPayload(sessionId: string, currentModelId = 'gemini-4-argon-medium') {
  return {
    sessionId,
    models: {
      currentModelId,
      availableModels: [
        { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
        { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
        { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
      ],
    },
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'accept-edits', name: 'Accept edits' },
        { id: 'plan', name: 'Plan' },
      ],
    },
  };
}

describe('AgyBackend persistent ACP mode', () => {
  it('defaults to persistent agy acp --stdio across multiple turns with dynamic model/mode updates', async () => {
    const spawnCalls: { args: string[]; opts: any }[] = [];
    let promptCount = 0;

    const proc = createMockAcpProcess((msg, p) => {
      if (msg.method === 'initialize') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('acp-conv-1') });
      } else if (msg.method === 'session/set_mode' || msg.method === 'session/set_model') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      } else if (msg.method === 'session/prompt') {
        promptCount += 1;
        const turnNum = promptCount;
        p.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'acp-conv-1',
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: `Thinking ${turnNum}` },
            },
          },
        });
        p.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'acp-conv-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Reply ${turnNum}` },
            },
          },
        });
        // Native `agy acp` includes thoughtTokens inside outputTokens (totalTokens = input + output).
        p.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            stopReason: 'end_turn',
            usage: {
              inputTokens: 100 * turnNum,
              outputTokens: 15 * turnNum,
              cachedReadTokens: 50,
              thoughtTokens: 5 * turnNum,
              totalTokens: 100 * turnNum + 15 * turnNum,
            },
          },
        });
      }
    });

    const spawnFn = ((_cmd: string, args: string[], opts: any) => {
      spawnCalls.push({ args, opts });
      return proc;
    }) as unknown as SpawnFn;

    const messages: AgentMessage[] = [];
    const onConversationId = vi.fn();
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'acceptEdits',
      model: 'Gemini 4 Argon (High)',
      spawnFn,
      onConversationId,
      midTurnFlushMs: 10,
    });
    backend.onMessage((m) => messages.push(m));

    await backend.startSession();
    expect(spawnCalls).toHaveLength(0);

    await backend.sendPrompt('/work', 'First turn');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toEqual(['acp', '--stdio', '--sandbox', '--add-dir', '/work']);
    expect(spawnCalls[0].opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(onConversationId).toHaveBeenCalledWith('acp-conv-1');

    // Switch model & mode on second turn — must reuse the SAME warm ACP process without respawning!
    backend.setModel('gemini-3.8-flash-low');
    backend.setPermissionMode('plan');
    await backend.sendPrompt('/work', 'Second turn');
    expect(spawnCalls).toHaveLength(1);
    expect(proc.kill).not.toHaveBeenCalled();

    const methods = proc.sent.map((m) => m.method);
    expect(methods.filter((m) => m === 'initialize')).toHaveLength(1);
    expect(methods.filter((m) => m === 'session/new')).toHaveLength(1);
    expect(methods.filter((m) => m === 'session/prompt')).toHaveLength(2);

    const setModelCalls = proc.sent.filter((m) => m.method === 'session/set_model');
    expect(setModelCalls.map((c) => c.params.modelId)).toEqual([
      'gemini-4-argon-high',
      'gemini-3.8-flash-low',
    ]);
    const setModeCalls = proc.sent.filter((m) => m.method === 'session/set_mode');
    expect(setModeCalls.map((c) => c.params.modeId)).toEqual(['accept-edits', 'plan']);

    // Verify fallback step token usage satisfies agyUsageRecord without double-counting thoughtTokens.
    const stepUsages = messages.filter((m) => m.type === 'token-count' && m.scope === 'step');
    expect(stepUsages).toHaveLength(2);
    const rec = agyUsageRecord(
      stepUsages[0].type === 'token-count' ? stepUsages[0].usage : null,
      { sessionId: 's1', machineId: 'm1' },
      'turn-1',
      'gemini-4-argon-high',
      Date.now(),
    );
    expect(rec).not.toBeNull();
    expect(rec?.tokens).toEqual({ input: 100, output: 15, cacheRead: 50, cacheWrite: 0 });

    await backend.dispose();
    expect(proc.sent.some((m) => m.method === 'session/close')).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('sends session/cancel without SIGTERM on mid-turn cancel, accounts for cancelled turn usage, emits zero error status, and keeps ACP server warm', async () => {
    let pendingPromptId: number | null = null;
    const proc = createMockAcpProcess((msg, p) => {
      if (msg.method === 'initialize') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('acp-cancel-conv') });
      } else if (msg.method === 'session/prompt') {
        if (pendingPromptId === null) {
          pendingPromptId = msg.id;
          p.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'acp-cancel-conv',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Partial before interrupt' },
              },
            },
          });
        } else {
          p.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'acp-cancel-conv',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Clean follow-up turn' },
              },
            },
          });
          p.send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 4, totalTokens: 54 } },
          });
        }
      } else if (msg.method === 'session/cancel') {
        p.send({
          jsonrpc: '2.0',
          id: pendingPromptId,
          result: { stopReason: 'cancelled', usage: { inputTokens: 40, outputTokens: 3, totalTokens: 43 } },
        });
      }
    });

    const spawnCalls: string[][] = [];
    const messages: AgentMessage[] = [];
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn: ((_cmd: string, args: string[]) => {
        spawnCalls.push(args);
        return proc;
      }) as unknown as SpawnFn,
    });
    backend.onMessage((m) => messages.push(m));

    const firstTurn = backend.sendPrompt('/work', 'Long running task');
    await vi.waitFor(() =>
      expect(messages.some((m) => m.type === 'model-output' && m.textDelta === 'Partial before interrupt')).toBe(true),
    );

    await backend.cancel();
    let caughtErr: unknown;
    try {
      await firstTurn;
    } catch (err) {
      caughtErr = err;
    }

    expect(isAgyTurnCancelledError(caughtErr)).toBe(true);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(proc.sent.some((m) => m.method === 'session/cancel' && m.params?.sessionId === 'acp-cancel-conv')).toBe(
      true,
    );
    expect(messages.filter((m) => m.type === 'status' && m.status === 'error')).toHaveLength(0);
    expect(messages.at(-1)).toMatchObject({ type: 'status', status: 'idle' });

    // Cancelled turn's returned usage MUST still be accounted for!
    const stepUsagesAfterCancel = messages.filter((m) => m.type === 'token-count' && m.scope === 'step');
    expect(stepUsagesAfterCancel).toHaveLength(1);
    expect(stepUsagesAfterCancel[0].type === 'token-count' ? stepUsagesAfterCancel[0].usage : null).toEqual({
      input_tokens: 40,
      output_tokens: 3,
      cache_read_tokens: 0,
      total_tokens: 43,
    });

    // Next turn runs on the exact same warm ACP child (spawnCalls stays 1)!
    await backend.sendPrompt('/work', 'Follow-up after cancel');
    expect(spawnCalls).toHaveLength(1);
    expect(
      messages.some((m) => m.type === 'model-output' && m.textDelta === 'Clean follow-up turn'),
    ).toBe(true);
  });

  it('keeps a single streaming response intact across >300ms-1500ms chunk pauses without splitting backticks, links, or words (IMG_4791 regression)', async () => {
    vi.useFakeTimers();
    const tmpHome = mkdtempSync(join(tmpdir(), 'agy-acp-img4791-'));
    try {
      const db = openTestConversationDb(tmpHome, 'acp-stream-intact');
      let resolvePromptId: number | null = null;
      const proc = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('acp-stream-intact') });
        } else if (msg.method === 'session/prompt') {
          resolvePromptId = msg.id;
          // User input step (14, DONE=3) + in-flight planner response step (15, RUNNING=2) + in-flight gen_metadata (no usage yet)
          db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(0, 14, 3);
          db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(1, 15, 2);
          const inFlightBlob = buildInFlightGenMetadataBlob([1]);
          db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(
            0,
            inFlightBlob,
            inFlightBlob.byteLength,
          );
          p.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'acp-stream-intact',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'r228-5win-v2-mc89' },
              },
            },
          });
        }
      });

      const messages: AgentMessage[] = [];
      const sessionManager = new AcpSessionManager();
      const envelopes = [...sessionManager.startTurn()];

      const backend = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        agyHomeDir: tmpHome,
        midTurnFlushMs: 300,
        spawnFn: (() => proc) as unknown as SpawnFn,
      });
      backend.onMessage((m) => {
        messages.push(m);
        envelopes.push(...sessionManager.mapMessage(m));
      });

      const turn = backend.sendPrompt('/work', 'Run quant verification');
      const remainingChunks = [
        '-or5125-wfopp-and-mc90-upper-shk-audit-20',
        '261107. 现在派发轻量哨兵 `r228-wakeup-',
        'sentinel`（`gpt-5.6-luna`）等待全量 `3,488` 行核验与 [analyze.py](file:///work/gold-r228-5win-v2-mc89-or5125',
        '-wfopp-and-mc90-upper-shk-audit-20261107/analyze.py) 收敛，随后立即生成报告并提交封',
        '机。',
      ];
      const gapsMs = [650, 900, 1_500, 450, 1_200];

      for (let i = 0; i < remainingChunks.length; i++) {
        await vi.advanceTimersByTimeAsync(gapsMs[i]);
        // Must NEVER flush output-complete while the planner response step is still mid-stream!
        expect(messages.filter((m) => m.type === 'event' && m.name === 'output-complete')).toHaveLength(0);
        proc.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'acp-stream-intact',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: remainingChunks[i] },
            },
          },
        });
      }

      // Finalize SQLite step + resolve prompt turn
      db.prepare('UPDATE steps SET status = 3 WHERE idx = 1').run();
      const doneBlob = buildGenMetadataBlob(500, 80, 0, { stepIndices: [1] });
      db.prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 0').run(
        doneBlob,
        doneBlob.byteLength,
      );
      proc.send({
        jsonrpc: '2.0',
        id: resolvePromptId,
        result: { stopReason: 'end_turn', usage: { inputTokens: 500, outputTokens: 80, totalTokens: 580 } },
      });
      await vi.advanceTimersByTimeAsync(10);
      await turn;
      envelopes.push(...sessionManager.endTurn('completed'));
      db.close();

      expect(messages.filter((m) => m.type === 'event' && m.name === 'output-complete')).toHaveLength(1);
      const textEnvelopes = envelopes.filter(
        (e) => e.ev.t === 'text' && !(e.ev as { thinking?: boolean }).thinking,
      );
      expect(textEnvelopes).toHaveLength(1);
      expect((textEnvelopes[0].ev as { text: string }).text).toBe(
        'r228-5win-v2-mc89-or5125-wfopp-and-mc90-upper-shk-audit-20261107. 现在派发轻量哨兵 `r228-wakeup-sentinel`（`gpt-5.6-luna`）等待全量 `3,488` 行核验与 [analyze.py](file:///work/gold-r228-5win-v2-mc89-or5125-wfopp-and-mc90-upper-shk-audit-20261107/analyze.py) 收敛，随后立即生成报告并提交封机。',
      );
    } finally {
      vi.useRealTimers();
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('flushes mid-turn output-complete after 300ms idle gap once SQLite confirms a tool-less planner step reached DONE (WaitForConversationFullyIdle), without splitting subsequent wakeup steps', async () => {
    vi.useFakeTimers();
    const tmpHome = mkdtempSync(join(tmpdir(), 'agy-acp-idle-done-'));
    try {
      const db = openTestConversationDb(tmpHome, 'acp-flush-conv');
      let resolvePromptId: number | null = null;
      const proc = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('acp-flush-conv') });
        } else if (msg.method === 'session/prompt') {
          resolvePromptId = msg.id;
          db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(0, 14, 3);
          db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(1, 15, 2);
          const inFlight = buildInFlightGenMetadataBlob([1]);
          db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(
            0,
            inFlight,
            inFlight.byteLength,
          );
          p.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'acp-flush-conv',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Milestone progress ' },
              },
            },
          });
        }
      });

      const messages: AgentMessage[] = [];
      const sessionManager = new AcpSessionManager();
      const envelopes = [...sessionManager.startTurn()];

      const backend = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        agyHomeDir: tmpHome,
        midTurnFlushMs: 300,
        spawnFn: (() => proc) as unknown as SpawnFn,
      });
      backend.onMessage((m) => {
        messages.push(m);
        envelopes.push(...sessionManager.mapMessage(m));
      });

      const turn = backend.sendPrompt('/work', 'Run multi-step job');
      // 500ms mid-stream pause while step 1 is still status=2 (generating) -> MUST NOT flush!
      await vi.advanceTimersByTimeAsync(500);
      expect(messages.filter((m) => m.type === 'event' && m.name === 'output-complete')).toHaveLength(0);

      // Second chunk of step 1 arrives, then native `agy` finalizes step 1 (`status=3` + usage) and enters `WaitForConversationFullyIdle`
      proc.send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'acp-flush-conv',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'update before background wait.' },
          },
        },
      });
      await vi.advanceTimersByTimeAsync(50);
      db.prepare('UPDATE steps SET status = 3 WHERE idx = 1').run();
      const step1Done = buildGenMetadataBlob(100, 12, 0, { stepIndices: [1] });
      db.prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 0').run(
        step1Done,
        step1Done.byteLength,
      );

      await vi.advanceTimersByTimeAsync(300);
      expect(messages.filter((m) => m.type === 'event' && m.name === 'output-complete')).toHaveLength(1);
      expect(
        envelopes
          .filter((e) => e.ev.t === 'text' && !(e.ev as { thinking?: boolean }).thinking)
          .map((e) => (e.ev as { text: string }).text),
      ).toEqual(['Milestone progress update before background wait.']);

      // Background task wakes `agy` up (`step_type = 101` SYSTEM_MESSAGE) and step 2 streams with an 800ms mid-word pause!
      db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(2, 101, 3);
      proc.send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'acp-flush-conv',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Background job finished — final ' },
          },
        },
      });
      await vi.advanceTimersByTimeAsync(800);
      // Must NOT falsely reuse step 1's finalized baseline to split step 2!
      expect(messages.filter((m) => m.type === 'event' && m.name === 'output-complete')).toHaveLength(1);

      proc.send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'acp-flush-conv',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'summary complete.' },
          },
        },
      });
      db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(3, 15, 3);
      const step2Done = buildGenMetadataBlob(140, 18, 0, { stepIndices: [3] });
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(
        1,
        step2Done,
        step2Done.byteLength,
      );
      proc.send({
        jsonrpc: '2.0',
        id: resolvePromptId,
        result: { stopReason: 'end_turn', usage: { inputTokens: 240, outputTokens: 30, totalTokens: 270 } },
      });
      await vi.advanceTimersByTimeAsync(10);
      await turn;
      envelopes.push(...sessionManager.endTurn('completed'));
      db.close();

      expect(messages.filter((m) => m.type === 'event' && m.name === 'output-complete')).toHaveLength(2);
      expect(
        envelopes
          .filter((e) => e.ev.t === 'text' && !(e.ev as { thinking?: boolean }).thinking)
          .map((e) => (e.ev as { text: string }).text),
      ).toEqual([
        'Milestone progress update before background wait.',
        'Background job finished — final summary complete.',
      ]);
    } finally {
      vi.useRealTimers();
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('uses session/resume on restored conversations, enforces strict kind-only permission policy, and cycles ACP when switching to bypassPermissions', async () => {
    const procs: MockAcpProcess[] = [];
    const spawnArgs: string[][] = [];

    const makeServer = (sessionIdToReturn = 'restored-conv-9') =>
      createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/resume') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(sessionIdToReturn) });
        } else if (msg.method === 'session/set_mode') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          p.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sessionIdToReturn,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-1',
                name: 'run_command',
                args: { CommandLine: 'echo hi' },
                status: 'pending',
                kind: 'execute',
              },
            },
          });
          p.send({
            jsonrpc: '2.0',
            id: 'perm-1',
            method: 'session/request_permission',
            params: {
              sessionId: sessionIdToReturn,
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          });
        } else if (msg.id === 'perm-1') {
          const optionId = msg.result?.outcome?.optionId;
          p.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sessionIdToReturn,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-1',
                name: 'run_command',
                status: optionId === 'allow' ? 'completed' : 'failed',
                rawOutput: optionId === 'allow' ? { output: 'hi\n' } : { error: 'denied' },
              },
            },
          });
          p.send({
            jsonrpc: '2.0',
            id: p.sent.find((x) => x.method === 'session/prompt').id,
            result: { stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } },
          });
        }
      });

    procs.push(makeServer(), makeServer());
    let idx = 0;
    const messages: AgentMessage[] = [];
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'acceptEdits',
      conversationId: 'restored-conv-9',
      spawnFn: ((_cmd: string, args: string[]) => {
        spawnArgs.push(args);
        return procs[idx++];
      }) as unknown as SpawnFn,
    });
    backend.onMessage((m) => messages.push(m));

    await backend.sendPrompt('/work', 'Check command');
    expect(spawnArgs[0]).toContain('--sandbox');
    expect(procs[0].sent.some((m) => m.method === 'session/resume')).toBe(true);
    expect(procs[0].sent.some((m) => m.method === 'session/new')).toBe(false);
    const permResp1 = procs[0].sent.find((m) => m.id === 'perm-1');
    expect(permResp1.result.outcome).toEqual({ outcome: 'selected', optionId: 'deny' });

    backend.setPermissionMode('bypassPermissions');
    await backend.sendPrompt('/work', 'Now bypass');
    expect(spawnArgs).toHaveLength(2);
    expect(spawnArgs[1]).toContain('--dangerously-skip-permissions');
    expect(procs[1].sent.some((m) => m.method === 'session/resume')).toBe(true);
    const permResp2 = procs[1].sent.find((m) => m.id === 'perm-1');
    expect(permResp2.result.outcome).toEqual({ outcome: 'selected', optionId: 'allow' });
  });

  it('rejects spoofed optionId="deny" with kind="allow_once", absent reject options, and foreign sessionIds with cancelled outcome', async () => {
    const proc = createMockAcpProcess((msg, p) => {
      if (msg.method === 'initialize') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('acp-perm-sec') });
      } else if (msg.method === 'session/prompt') {
        // 1. Spoofed optionId="deny" whose kind is actually allow_once!
        p.send({
          jsonrpc: '2.0',
          id: 'spoof-1',
          method: 'session/request_permission',
          params: {
            sessionId: 'acp-perm-sec',
            options: [{ optionId: 'deny', name: 'Misleading Allow', kind: 'allow_once' }],
          },
        });
      } else if (msg.id === 'spoof-1') {
        // 2. Contradictory duplicate optionId mapping to both reject_once and allow_once!
        p.send({
          jsonrpc: '2.0',
          id: 'dup-2',
          method: 'session/request_permission',
          params: {
            sessionId: 'acp-perm-sec',
            options: [
              { optionId: 'ambig', kind: 'reject_once' },
              { optionId: 'ambig', kind: 'allow_once' },
            ],
          },
        });
      } else if (msg.id === 'dup-2') {
        // 3. Foreign sessionId!
        p.send({
          jsonrpc: '2.0',
          id: 'foreign-3',
          method: 'session/request_permission',
          params: {
            sessionId: 'other-session-id',
            options: [{ optionId: 'allow', kind: 'allow_once' }],
          },
        });
      } else if (msg.id === 'foreign-3') {
        p.send({
          jsonrpc: '2.0',
          id: p.sent.find((x) => x.method === 'session/prompt').id,
          result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
        });
      }
    });

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn: (() => proc) as unknown as SpawnFn,
    });

    await backend.sendPrompt('/work', 'Test adversarial permissions');

    expect(proc.sent.find((m) => m.id === 'spoof-1')?.result).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(proc.sent.find((m) => m.id === 'dup-2')?.result).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(proc.sent.find((m) => m.id === 'foreign-3')?.result).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });

  it('escalates SIGTERM -> SIGKILL to confirm exit before 400 media repair, refuses repair if unkillable, and isolates retired-child delayed close', async () => {
    let promptAttempt = 0;
    // proc1 ignores SIGTERM so closeProcess MUST escalate to SIGKILL and wait for exit!
    const proc1 = createMockAcpProcess(
      (msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('acp-repair-barrier') });
        } else if (msg.method === 'session/prompt') {
          promptAttempt += 1;
          if (promptAttempt === 1) {
            p.send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'acp-repair-barrier',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Part 1... ' },
                },
              },
            });
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32603, message: 'generating and executing: stream idle timeout (5m0s)' },
            });
          } else {
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32603, message: 'INVALID_ARGUMENT (code 400): Request contains an invalid argument.' },
            });
          }
        }
      },
      { ignoreSigterm: true, deferCloseManual: true },
    );
    // On SIGKILL, exit after 15ms and ALSO emit a late duplicate close later to test generation isolation!
    proc1.kill.mockImplementation((sig?: NodeJS.Signals) => {
      if (sig === 'SIGKILL') {
        setTimeout(() => proc1.triggerExit(137, 'SIGKILL'), 15);
      }
      return true;
    });

    const proc2 = createMockAcpProcess((msg, p) => {
      if (msg.method === 'initialize') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/resume') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('acp-repair-barrier') });
      } else if (msg.method === 'session/prompt') {
        // While proc2's prompt is in flight, fire a late `close` event on retired proc1!
        proc1.emit('close', 137, 'SIGKILL');
        setTimeout(() => {
          p.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'acp-repair-barrier',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Recovered!' },
              },
            },
          });
          p.send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 6, totalTokens: 36 } },
          });
        }, 10);
      }
    });

    const procs = [proc1, proc2];
    let idx = 0;
    let proc1ExitedWhenRepairRan = false;
    const repairConversationMedia = vi.fn(() => {
      proc1ExitedWhenRepairRan = proc1.exited;
      return { repairedCount: 1, repairedSteps: [42] };
    });

    const messages: AgentMessage[] = [];
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      transientStreamRetryDelaysMs: [5, 5],
      acpCloseSigtermMs: 20,
      acpCloseSigkillMs: 100,
      repairConversationMedia,
      spawnFn: (() => procs[idx++]) as unknown as SpawnFn,
    });
    backend.onMessage((m) => messages.push(m));

    await backend.sendPrompt('/work', 'Analyze long benchmark');

    expect(proc1.kill).toHaveBeenCalledWith('SIGTERM');
    expect(proc1.kill).toHaveBeenCalledWith('SIGKILL');
    expect(proc1ExitedWhenRepairRan).toBe(true);
    expect(messages.filter((m) => m.type === 'model-output').map((m) => m.textDelta).join('')).toBe(
      'Part 1... Recovered!',
    );

    // Now verify that if an ACP process ignores BOTH SIGTERM and SIGKILL, media repair NEVER runs!
    const unkillableProc = createMockAcpProcess(
      (msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('unkillable-conv') });
        } else if (msg.method === 'session/prompt') {
          p.send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: 'INVALID_ARGUMENT (code 400): Request contains an invalid argument.' },
          });
        }
      },
      { ignoreSigterm: true, ignoreSigkill: true },
    );

    const unkillableRepairSpy = vi.fn(() => ({ repairedCount: 1, repairedSteps: [1] }));
    const backendUnkillable = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      acpCloseSigtermMs: 15,
      acpCloseSigkillMs: 15,
      repairConversationMedia: unkillableRepairSpy,
      spawnFn: (() => unkillableProc) as unknown as SpawnFn,
    });

    await expect(backendUnkillable.sendPrompt('/work', 'Trigger 400')).rejects.toThrow(
      /did not exit within shutdown timeout/,
    );
    expect(unkillableRepairSpy).not.toHaveBeenCalled();
  });

  it('handles asynchronous stdin EPIPE, preserves original prompt on pre-delivery crash, and blocks auto-retry after tool activity', async () => {
    // Part A: Asynchronous stdin EPIPE mid-write on session/prompt -> must NOT crash Node and must replay ORIGINAL prompt!
    const procEpipe = createMockAcpProcess((msg, p) => {
      if (msg.method === 'initialize') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('epipe-conv') });
      } else if (msg.method === 'session/prompt') {
        p.stdin.writable = false;
        p.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      }
    });

    const procRecovered = createMockAcpProcess((msg, p) => {
      if (msg.method === 'initialize') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/resume') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('epipe-conv') });
      } else if (msg.method === 'session/prompt') {
        p.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 3, totalTokens: 18 } },
        });
      }
    });

    let idx = 0;
    const epipeProcs = [procEpipe, procRecovered];
    const backendEpipe = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      transientStreamRetryDelaysMs: [5],
      spawnFn: (() => epipeProcs[idx++]) as unknown as SpawnFn,
    });

    await backendEpipe.sendPrompt('/work', 'EXACT_USER_INSTRUCTION_42');
    const retriedPromptCall = procRecovered.sent.find((m) => m.method === 'session/prompt');
    expect(retriedPromptCall?.params?.prompt).toEqual([{ type: 'text', text: 'EXACT_USER_INSTRUCTION_42' }]);

    // Part B: Crash AFTER a tool_call started -> ambiguous side effect, MUST NOT auto-retry!
    const procToolCrash = createMockAcpProcess((msg, p) => {
      if (msg.method === 'initialize') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('tool-crash-conv') });
      } else if (msg.method === 'session/prompt') {
        p.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'tool-crash-conv',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'mutating-cmd-1',
              name: 'run_command',
              args: { CommandLine: 'rm -rf something' },
              status: 'in_progress',
            },
          },
        });
        p.triggerExit(1, null);
      }
    });

    let toolSpawnCount = 0;
    const backendToolCrash = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      transientStreamRetryDelaysMs: [5, 5],
      spawnFn: (() => {
        toolSpawnCount += 1;
        return procToolCrash;
      }) as unknown as SpawnFn,
    });

    await expect(backendToolCrash.sendPrompt('/work', 'Run command')).rejects.toThrow();
    expect(toolSpawnCount).toBe(1);
  });

  it('fences turn timeout and pre-prompt set_mode cancellation so subsequent turns never overlap', async () => {
    // 1. Turn 1 times out while server ignores session/cancel -> grace barrier kills server before Turn 2 runs!
    const hungProc = createMockAcpProcess((msg, p) => {
      if (msg.method === 'initialize') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('timeout-conv') });
      }
      // Deliberately never respond to session/prompt or session/cancel!
    });

    let slowSetModeResolve: (() => void) | null = null;
    const cleanProc = createMockAcpProcess((msg, p) => {
      if (msg.method === 'initialize') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/resume') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('timeout-conv') });
      } else if (msg.method === 'session/set_mode') {
        if (!slowSetModeResolve) {
          slowSetModeResolve = () => {
            p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
          };
        } else {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        }
      } else if (msg.method === 'session/prompt') {
        p.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'timeout-conv',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Turn 3 clean!' },
            },
          },
        });
        p.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } },
        });
      }
    });

    const procs = [hungProc, cleanProc];
    let pIdx = 0;
    const messages: AgentMessage[] = [];
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      printTimeout: '1ms', // parsed to 1ms, turnTimeoutMs = 30_001ms — let's use fake timers for deterministic speed!
      acpCancelGraceMs: 25,
      acpCloseSigtermMs: 20,
      acpCloseSigkillMs: 20,
      transientStreamRetryDelaysMs: [],
      spawnFn: (() => procs[pIdx++]) as unknown as SpawnFn,
    });
    backend.onMessage((m) => messages.push(m));

    vi.useFakeTimers();
    try {
      const t1 = backend.sendPrompt('/work', 'Hang forever');
      const t1Rejection = t1.catch((e) => e);
      await vi.advanceTimersByTimeAsync(30_050);
      const err1 = await t1Rejection;
      expect(err1).toBeInstanceOf(Error);
      expect(hungProc.exited).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    // 2. Turn 2 cancels while `session/set_mode` (`accept-edits`) is in flight; Turn 3 (`plan`) starts concurrently!
    backend.setPermissionMode('acceptEdits');
    const t2 = backend.sendPrompt('/work', 'Cancel during set_mode');
    await vi.waitFor(() => expect(slowSetModeResolve).not.toBeNull());
    await backend.cancel();
    slowSetModeResolve!();
    await expect(t2).rejects.toSatisfy(isAgyTurnCancelledError);
    // session/prompt must NOT have been sent for Turn 2!
    expect(cleanProc.sent.filter((m) => m.method === 'session/prompt')).toHaveLength(0);

    // 3. Turn 3 in restrictive `plan` mode runs cleanly after Turn 2 drained!
    backend.setPermissionMode('plan');
    await backend.sendPrompt('/work', 'Run in plan mode');
    const modeCalls = cleanProc.sent.filter((m) => m.method === 'session/set_mode').map((m) => m.params.modeId);
    expect(modeCalls).toEqual(['accept-edits', 'plan']);
    expect(messages.some((m) => m.type === 'model-output' && m.textDelta === 'Turn 3 clean!')).toBe(true);
  });

  it('reconciles delayed/partial local gen_metadata without double-charging or undercounting, paginates >20 rows, retries failed resume seeds, and guards integer overflow', async () => {
    const tmpAgyHome = mkdtempSync(join(tmpdir(), 'agy-acp-test-home-'));
    try {
      const convId = 'reconcile-conv-1';
      let turnNo = 0;

      const proc = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convId) });
        } else if (msg.method === 'session/prompt') {
          turnNo += 1;
          if (turnNo === 1) {
            // Turn 1: DB has only step 0 (100 in, 20 out), while turn ran 2 steps totaling (300 in, 50 out)!
            const db = openTestConversationDb(tmpAgyHome, convId);
            db.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 1), (1, 2)').run();
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, 10)').run(
              buildGenMetadataBlob(100, 20, 5),
            );
            db.close();
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                stopReason: 'end_turn',
                usage: { inputTokens: 300, outputTokens: 50, cachedReadTokens: 15, totalTokens: 350 },
              },
            });
          } else if (turnNo === 2) {
            // Before Turn 2 finishes: delayed step 1 from Turn 1 (200 in, 30 out, 10 cache) arrives,
            // PLUS 25 new steps for Turn 2 (each 10 in, 2 out = 250 in, 50 out)!
            const db = openTestConversationDb(tmpAgyHome, convId);
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, 10)').run(
              buildGenMetadataBlob(200, 30, 10),
            );
            const stmt = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, 10)');
            for (let i = 2; i < 27; i++) {
              stmt.run(i, buildGenMetadataBlob(10, 2, 0));
            }
            db.close();
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                stopReason: 'end_turn',
                usage: { inputTokens: 250, outputTokens: 50, cachedReadTokens: 0, totalTokens: 300 },
              },
            });
          } else if (turnNo === 3) {
            // Turn 3: Unsafe overflow in fallback usage -> must NOT emit invalid agyUsageRecord!
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                stopReason: 'end_turn',
                usage: {
                  inputTokens: Number.MAX_SAFE_INTEGER,
                  outputTokens: 10,
                  totalTokens: Number.MAX_SAFE_INTEGER,
                },
              },
            });
          }
        }
      });

      const messages: AgentMessage[] = [];
      const backend = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        agyHomeDir: tmpAgyHome,
        spawnFn: (() => proc) as unknown as SpawnFn,
      });
      backend.onMessage((m) => messages.push(m));

      await backend.sendPrompt('/work', 'Turn 1 partial DB');
      await backend.sendPrompt('/work', 'Turn 2 delayed + 25 steps');
      await backend.sendPrompt('/work', 'Turn 3 overflow');

      const stepMsgs = messages.filter(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> =>
          m.type === 'token-count' && m.scope === 'step',
      );
      let sumIn = 0;
      let sumOut = 0;
      let sumCache = 0;
      for (const sm of stepMsgs) {
        const rec = agyUsageRecord(
          sm.usage,
          { sessionId: 's', machineId: 'm' },
          typeof sm.usageKey === 'string' ? sm.usageKey : 'k',
          'gemini-4-argon-medium',
          Date.now(),
        );
        expect(rec).not.toBeNull();
        sumIn += rec!.tokens.input;
        sumOut += rec!.tokens.output;
        sumCache += rec!.tokens.cacheRead;
      }
      // Exact total across Turn 1 (300, 50, 15) + Turn 2 (250, 50, 0) + Turn 3 (0 overflow rejected) = (550, 100, 15)!
      expect({ sumIn, sumOut, sumCache }).toEqual({ sumIn: 550, sumOut: 100, sumCache: 15 });

      // Test failed historical seed read on resume: corrupt file on Turn 1 MUST block `session/prompt` before dispatch
      // so a later recovery never classifies owned rows as historical (R8-P2-5)!
      const resumeConv = 'corrupt-seed-conv';
      mkdirSync(join(tmpAgyHome, 'conversations'), { recursive: true });
      const corruptDbPath = join(tmpAgyHome, 'conversations', `${resumeConv}.db`);
      writeFileSync(corruptDbPath, 'NOT_A_VALID_SQLITE_HEADER');

      let resumeTurn = 0;
      const procResume = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/resume') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(resumeConv) });
        } else if (msg.method === 'session/prompt') {
          resumeTurn += 1;
          const db = openTestConversationDb(tmpAgyHome, resumeConv);
          db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (5, ?, 10)').run(
            buildGenMetadataBlob(77, 11, 0),
          );
          db.close();
          p.send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              stopReason: 'end_turn',
              usage: { inputTokens: 77, outputTokens: 11, totalTokens: 88 },
            },
          });
        }
      });

      const resumeMsgs: AgentMessage[] = [];
      const backendResume = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        conversationId: resumeConv,
        agyHomeDir: tmpAgyHome,
        transientStreamRetryDelaysMs: [],
        spawnFn: (() => procResume) as unknown as SpawnFn,
      });
      backendResume.onMessage((m) => resumeMsgs.push(m));

      // Turn 1: DB is corrupt/unreadable -> refuses to dispatch `session/prompt` while unseeded!
      await expect(
        backendResume.sendPrompt('/work', 'Resume turn 1 while DB corrupt'),
      ).rejects.toThrow(/unseeded usage baseline/);
      expect(resumeTurn).toBe(0);

      // Now replace corrupt file with valid DB containing 5 pre-existing historical rows (idx 0..4, 999 tokens each)!
      rmSync(corruptDbPath, { force: true });
      const dbValid = openTestConversationDb(tmpAgyHome, resumeConv);
      for (let i = 0; i < 5; i++) {
        dbValid.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, 10)').run(
          i,
          buildGenMetadataBlob(999, 111, 0),
        );
      }
      dbValid.close();

      // Turn 2: Pre-prompt seed now succeeds at maxGenIdx=4 -> historical 5*999 tokens MUST NOT be charged; only idx=5 (77, 11) is charged!
      await backendResume.sendPrompt('/work', 'Resume turn 2 after DB unlocked');
      expect(resumeTurn).toBe(1);
      const resumeSteps = resumeMsgs.filter(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> =>
          m.type === 'token-count' && m.scope === 'step',
      );
      const totalResumedIn = resumeSteps.reduce((acc, m) => acc + Number((m.usage as any).input_tokens), 0);
      expect(totalResumedIn).toBe(77);
    } finally {
      rmSync(tmpAgyHome, { recursive: true, force: true });
    }
  });

  it('rejects malformed JSON-RPC envelopes (missing jsonrpc 2.0, empty response without result/error, or string ID for numeric RPC)', async () => {
    for (const badFrame of [
      JSON.stringify({ id: 1, result: { protocolVersion: 1 } }), // missing jsonrpc: '2.0'
      JSON.stringify({ jsonrpc: '2.0', id: 1 }), // neither result nor error
      JSON.stringify({ jsonrpc: '2.0', id: '01', result: { protocolVersion: 1 } }), // string ID coercion attempt
    ]) {
      const proc = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.sendRawLine(badFrame);
        }
      });
      const backend = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        transientStreamRetryDelaysMs: [],
        spawnFn: (() => proc) as unknown as SpawnFn,
      });
      await expect(backend.sendPrompt('/work', 'Test malformed RPC')).rejects.toThrow(/Invalid Antigravity/);
    }
  });

  it('enforces mandatory exit barrier before sendPrompt settles or replacement spawns, and permanently fails closed on unkillable process', async () => {
    // Part A: Delayed exit after SIGKILL — sendPrompt() MUST NOT settle and replacement MUST NOT spawn until old child actually exits!
    vi.useFakeTimers();
    try {
      let spawnCount = 0;
      const proc1 = createMockAcpProcess(
        (msg, p) => {
          if (msg.method === 'initialize') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
          } else if (msg.method === 'session/new') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('barrier-conv-1') });
          }
          // Hang on session/prompt and session/cancel!
        },
        { ignoreSigterm: true, deferCloseManual: true },
      );
      const proc2 = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/resume') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('barrier-conv-1') });
        } else if (msg.method === 'session/prompt') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
      });

      const backend = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        transientStreamRetryDelaysMs: [],
        spawnFn: (() => {
          spawnCount += 1;
          return spawnCount === 1 ? proc1 : proc2;
        }) as unknown as SpawnFn,
      });

      let turn1Settled = false;
      const t1 = backend.sendPrompt('/work', 'Turn 1 hangs').finally(() => {
        turn1Settled = true;
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(proc1.sent.some((m) => m.method === 'session/prompt')).toBe(true);

      const cancelP = backend.cancel();
      // Advance past cancel grace (5s) + SIGTERM wait (1s) = 6s -> SIGKILL sent, now inside SIGKILL 2s wait (6.5s)!
      await vi.advanceTimersByTimeAsync(6_500);
      expect(proc1.kill).toHaveBeenCalledWith('SIGKILL');
      expect(turn1Settled).toBe(false);
      expect(spawnCount).toBe(1);

      // Start Turn 2 while proc1 has STILL not exited — must queue behind barrier without spawning proc2!
      const t2 = backend.sendPrompt('/work', 'Turn 2 waits for proc1 exit');
      await vi.advanceTimersByTimeAsync(500);
      expect(spawnCount).toBe(1);
      expect(turn1Settled).toBe(false);

      // Now proc1 finally exits cleanly within SIGKILL window -> t1 rejects cancelled, proc2 spawns & completes t2!
      proc1.triggerExit(0, 'SIGKILL');
      await cancelP;
      await expect(t1).rejects.toSatisfy(isAgyTurnCancelledError);
      await t2;
      expect(spawnCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }

    // Part B: Unkillable child ignoring both SIGTERM and SIGKILL permanently fails closed across subsequent turns!
    vi.useFakeTimers();
    try {
      let unkillableSpawns = 0;
      const zombie = createMockAcpProcess(
        (msg, p) => {
          if (msg.method === 'initialize') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
          } else if (msg.method === 'session/new') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('zombie-conv') });
          }
          // Hang on session/prompt with short turnTimeoutMs!
        },
        { ignoreSigterm: true, ignoreSigkill: true, deferCloseManual: true },
      );

      const backend2 = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        printTimeout: '1s',
        transientStreamRetryDelaysMs: [],
        spawnFn: (() => {
          unkillableSpawns += 1;
          return zombie;
        }) as unknown as SpawnFn,
      });

      const z1 = backend2.sendPrompt('/work', 'Turn 1 hits turnTimeout + unkillable');
      const z1Assertion = expect(z1).rejects.toThrow(/did not exit within shutdown timeout/);
      await vi.advanceTimersByTimeAsync(45_000);
      await z1Assertion;
      expect(unkillableSpawns).toBe(1);

      // Subsequent turn MUST ALSO refuse to spawn while zombie remains alive!
      await expect(backend2.sendPrompt('/work', 'Turn 2 blocked by zombie')).rejects.toThrow(
        /did not exit within shutdown timeout/,
      );
      expect(unkillableSpawns).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat kill EPERM error on a running child as process exit and blocks unsafe SQLite repair', async () => {
    vi.useFakeTimers();
    const tmpAgyHome = mkdtempSync(join(tmpdir(), 'agy-acp-eperm-'));
    try {
      const convId = 'eperm-conv-1';
      const db = openTestConversationDb(tmpAgyHome, convId);
      // Seed malformed image media row that repairConversationMedia would touch if allowed
      db.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 1)').run();
      db.close();

      const proc = createMockAcpProcess(
        (msg, p) => {
          if (msg.method === 'initialize') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
          } else if (msg.method === 'session/resume') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convId) });
          } else if (msg.method === 'session/prompt') {
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              error: {
                code: -32603,
                message: '400 INVALID_ARGUMENT: Unable to process input image',
              },
            });
          }
        },
        { ignoreSigterm: true, ignoreSigkill: true, deferCloseManual: true },
      );
      (proc as any).pid = 42424;
      proc.kill.mockImplementation((sig?: NodeJS.Signals) => {
        const err = Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' });
        proc.emit('error', err);
        return false;
      });

      const backend = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        conversationId: convId,
        agyHomeDir: tmpAgyHome,
        transientStreamRetryDelaysMs: [],
        spawnFn: (() => proc) as unknown as SpawnFn,
      });

      const p = backend.sendPrompt('/work', 'Trigger 400 media repair with EPERM kill');
      const pAssert = expect(p).rejects.toThrow(/did not exit within shutdown timeout/);
      await vi.advanceTimersByTimeAsync(15_000);
      await pAssert;
      expect(proc.exited).toBe(false);
    } finally {
      vi.useRealTimers();
      rmSync(tmpAgyHome, { recursive: true, force: true });
    }
  });

  it('repairs corrupted media without auto-retrying after unsafe tool side effects, and aborts media repair on mid-shutdown cancel', async () => {
    const tmpAgyHome = mkdtempSync(join(tmpdir(), 'agy-acp-media-sidefx-'));
    try {
      // Part A: 400 media error AFTER tool_call (`unsafe_side_effects`) -> closes ACP & repairs DB, NO auto-retry!
      const convId = 'media-sidefx-conv';
      let spawns = 0;
      const proc1 = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convId) });
        } else if (msg.method === 'session/prompt') {
          p.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: convId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-mutating-1',
                title: 'Bash',
                kind: 'execute',
                rawInput: { command: 'touch side-effect' },
              },
            },
          });
          p.send({
            jsonrpc: '2.0',
            id: msg.id,
            error: {
              code: -32603,
              message: '400 INVALID_ARGUMENT: Unable to process input image',
            },
          });
        }
      });

      const backend = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        agyHomeDir: tmpAgyHome,
        transientStreamRetryDelaysMs: [],
        spawnFn: (() => {
          spawns += 1;
          return proc1;
        }) as unknown as SpawnFn,
      });

      await expect(backend.sendPrompt('/work', 'Mutate then 400 image')).rejects.toThrow(/400 INVALID_ARGUMENT/);
      // Must NOT have spawned a 2nd process to auto-replay the mutating prompt!
      expect(spawns).toBe(1);
      expect(proc1.exited).toBe(true);

      // Part B: Clean 400 media error (no side effects), but user calls `backend.cancel()` while ACP server is shutting down!
      let cancelSpawns = 0;
      const slowExitProc = createMockAcpProcess(
        (msg, p) => {
          if (msg.method === 'initialize') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
          } else if (msg.method === 'session/new') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('cancel-repair-conv') });
          } else if (msg.method === 'session/prompt') {
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              error: {
                code: -32603,
                message: '400 INVALID_ARGUMENT: Unable to process input image',
              },
            });
          }
        },
        { deferCloseManual: true },
      );

      const backendCancel = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        agyHomeDir: tmpAgyHome,
        transientStreamRetryDelaysMs: [],
        spawnFn: (() => {
          cancelSpawns += 1;
          return slowExitProc;
        }) as unknown as SpawnFn,
      });

      const turnP = backendCancel.sendPrompt('/work', 'Cancel during 400 shutdown');
      await vi.waitFor(() => expect(slowExitProc.kill).toHaveBeenCalledWith('SIGTERM'));
      const cancelCall = backendCancel.cancel();
      slowExitProc.triggerExit(0, 'SIGTERM');
      await cancelCall;
      await expect(turnP).rejects.toSatisfy(isAgyTurnCancelledError);
      // Must NOT spawn replacement or replay prompt after cancel!
      expect(cancelSpawns).toBe(1);
    } finally {
      rmSync(tmpAgyHome, { recursive: true, force: true });
    }
  });

  it('produces unique residual usageKeys across recreated AgyBackend instances and separates contextUsage from fallback residuals', async () => {
    const makeFallbackProc = (convId: string) =>
      createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/resume') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convId) });
        } else if (msg.method === 'session/prompt') {
          p.send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              stopReason: 'end_turn',
              usage: { inputTokens: 120, outputTokens: 30, cachedReadTokens: 10, totalTokens: 150 },
            },
          });
        }
      });

    const msgs1: AgentMessage[] = [];
    const b1 = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      conversationId: 'shared-conv-uuid',
      spawnFn: (() => makeFallbackProc('shared-conv-uuid')) as unknown as SpawnFn,
    });
    b1.onMessage((m) => msgs1.push(m));
    await b1.sendPrompt('/work', 'Instance 1 Turn 1');

    const msgs2: AgentMessage[] = [];
    const b2 = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      conversationId: 'shared-conv-uuid',
      spawnFn: (() => makeFallbackProc('shared-conv-uuid')) as unknown as SpawnFn,
    });
    b2.onMessage((m) => msgs2.push(m));
    await b2.sendPrompt('/work', 'Instance 2 Turn 1');

    const step1 = msgs1.find(
      (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
    )!;
    const step2 = msgs2.find(
      (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
    )!;

    expect(step1.usageKey).toBeDefined();
    expect(step2.usageKey).toBeDefined();
    expect(step1.usageKey).not.toBe(step2.usageKey);
    // Residual fallback messages carry `contextUsage: null` so they never overwrite context-window gauge!
    expect(step1.contextUsage).toBeNull();
    expect(step2.contextUsage).toBeNull();
  });

  it('drains buffered stdout tool_call frames arriving between child exit and close before classifying retry safety, and fails closed on dispose/closeForHandoff when child is unkillable', async () => {
    // Part A: `exit(1)` fires BEFORE buffered stdout `tool_call` data and `close(1)` -> must NOT replay prompt!
    const procExitBeforeStdout = createMockAcpProcess((msg, p) => {
      if (msg.method === 'initialize') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('exit-before-close-conv') });
      } else if (msg.method === 'session/prompt') {
        // Emit OS `'exit'` FIRST while stdout still has a buffered `tool_call` notification in flight!
        (p as any).emit('exit', 1, null);
        setTimeout(() => {
          p.stdout.emit(
            'data',
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'exit-before-close-conv',
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: 'late-pipe-tool-1',
                  name: 'write_file',
                  args: { Path: '/work/out.txt' },
                  status: 'completed',
                },
              },
            }) + '\n',
          );
          (p as any).emit('close', 1, null);
        }, 5);
      }
    });

    let exitCloseSpawns = 0;
    const backendDrain = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      transientStreamRetryDelaysMs: [5, 5],
      spawnFn: (() => {
        exitCloseSpawns += 1;
        return procExitBeforeStdout;
      }) as unknown as SpawnFn,
    });

    await expect(backendDrain.sendPrompt('/work', 'Mutate file')).rejects.toThrow();
    expect(exitCloseSpawns).toBe(1);

    // Part B: `closeForHandoff()` and `dispose()` reject when ACP child ignores SIGTERM and SIGKILL.
    const unkillableAcp = createMockAcpProcess(
      (msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('handoff-unkillable') });
        } else if (msg.method === 'session/prompt') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
      },
      { ignoreSigterm: true, ignoreSigkill: true },
    );

    const backendHandoff = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      acpCloseSigtermMs: 15,
      acpCloseSigkillMs: 15,
      spawnFn: (() => unkillableAcp) as unknown as SpawnFn,
    });

    await backendHandoff.sendPrompt('/work', 'Warm up ACP');
    await expect(backendHandoff.closeForHandoff()).rejects.toThrow(/did not exit within shutdown timeout/);
    await expect(backendHandoff.dispose()).rejects.toThrow(/did not exit within shutdown timeout/);
  });

  it('preserves Turn-A model and startedAt attribution when a delayed Turn-A SQLite row is reconciled at the start of Turn-B', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'lmc-agy-attr-'));
    try {
      const convId = 'delayed-attr-conv';
      const db = openTestConversationDb(tmpHome, convId);

      const proc = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convId) });
        } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          const text = msg.params?.prompt?.[0]?.text;
          if (text === 'Turn A') {
            // Turn A commits step 0, finishes with partial fallback usage (gen_metadata row delayed!)
            db.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 15)').run();
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
            });
          } else {
            // Turn B commits step 1 and writes its own SQLite row 2 (input=300, output=50)
            db.prepare('INSERT INTO steps (idx, step_type) VALUES (1, 15)').run();
            const blob2 = buildGenMetadataBlob(300, 50, 0, { stepIndices: [1] });
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(
              2,
              blob2,
              blob2.byteLength,
            );
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: 50, totalTokens: 350 } },
            });
          }
        }
      });

      const emitted: AgentMessage[] = [];
      const backend = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'claude-opus-4-6-thinking',
        agyHomeDir: tmpHome,
        spawnFn: (() => proc) as unknown as SpawnFn,
      });
      backend.onMessage((m) => emitted.push(m));

      // Turn A runs at t = 1_700_000_000_000 on `claude-opus-4-6-thinking`
      backend.setTurnStartedAt(1_700_000_000_000);
      await backend.sendPrompt('/work', 'Turn A');

      // Delayed Turn-A SQLite row 1 arrives (input=140, output=30 -> net delta +40/+10 after absorbing 100/20 fallback!)
      // Notice we omit displayModel in protobuf so fallback attribution must supply Turn A's model & startedAt!
      const blob1 = buildGenMetadataBlob(140, 30, 0, { stepIndices: [0] });
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(
        1,
        blob1,
        blob1.byteLength,
      );

      // Turn B switches model to `gemini-3.1-pro-high` at t = 1_700_000_999_000!
      backend.setModel('gemini-3.1-pro-high');
      backend.setTurnStartedAt(1_700_000_999_000);
      await backend.sendPrompt('/work', 'Turn B');

      db.close();

      const steps = emitted.filter(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
      );
      expect(steps).toHaveLength(3);

      // 1. Turn A residual
      expect(steps[0].usageModel).toBe('claude-opus-4-6-thinking');
      expect(steps[0].usageStartedAt).toBe(1_700_000_000_000);

      // 2. Delayed Turn A SQLite row reconciled at start of Turn B MUST retain Turn A's model & startedAt!
      expect(steps[1].usageKey).toBe(`${convId}:sql:1`);
      expect(steps[1].usage).toEqual({
        input_tokens: 40,
        output_tokens: 10,
        cache_read_tokens: 0,
        total_tokens: 50,
      });
      expect(steps[1].usageModel).toBe('claude-opus-4-6-thinking');
      expect(steps[1].usageStartedAt).toBe(1_700_000_000_000);

      // 3. Turn B SQLite row carries Turn B's model & startedAt!
      expect(steps[2].usageKey).toBe(`${convId}:sql:2`);
      expect(steps[2].usageModel).toBe('gemini-3.1-pro-high');
      expect(steps[2].usageStartedAt).toBe(1_700_000_999_000);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('awaits post-exit stdout drain when a JSON-RPC prompt error arrives between exit and close before classifying 401 retry safety', async () => {
    let authRetrySpawns = 0;
    const procRpcErrDuringDrain = createMockAcpProcess((msg, p) => {
      if (msg.method === 'initialize') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('rpc-err-before-close-conv') });
      } else if (msg.method === 'session/prompt') {
        // 1. OS exit fires first, without close
        (p as any).emit('exit', 1, null);
        // 2. Matching session/prompt error response arrives first in the drain window
        p.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: 'UNAUTHENTICATED: OAuth token expired (401)' },
        });
        // 3. Allow promise continuations to run, then deliver buffered tool_call + close!
        setTimeout(() => {
          p.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'rpc-err-before-close-conv',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'drain-tool-after-rpc-err',
                name: 'write_file',
                args: { Path: '/work/side-effect.txt' },
                status: 'completed',
              },
            },
          });
          (p as any).emit('close', 1, null);
        }, 10);
      }
    });

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      authRetryDelayMs: 5,
      spawnFn: (() => {
        authRetrySpawns += 1;
        return procRpcErrDuringDrain;
      }) as unknown as SpawnFn,
    });

    await expect(backend.sendPrompt('/work', 'Run mutating prompt')).rejects.toThrow(/UNAUTHENTICATED/);
    expect(authRetrySpawns).toBe(1);
  });

  it('retains per-row ownership across multi-turn unfinished generations (A -> B -> C) and emits unknown attribution when delayed insertion is genuinely ambiguous', async () => {
    // Part A: Turn A creates unfinished gen_metadata row 1; Turn B runs & finishes row 2;
    // row 1 finishes after Turn B; Turn C reconciles row 1 with Turn A's model & startedAt (never Turn B's!).
    const tmpHome1 = mkdtempSync(join(tmpdir(), 'lmc-agy-abc-'));
    try {
      const convId = 'abc-ownership-conv';
      const db = openTestConversationDb(tmpHome1, convId);
      const unfinishedStartBlob = Uint8Array.from(encodeLenField(2, encodeVarint(1)));

      const proc = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convId) });
        } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          const text = msg.params?.prompt?.[0]?.text;
          if (text === 'Turn A') {
            db.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 14), (1, 15)').run();
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(
              1,
              unfinishedStartBlob,
              unfinishedStartBlob.byteLength,
            );
            p.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          } else if (text === 'Turn B') {
            db.prepare('INSERT INTO steps (idx, step_type) VALUES (2, 14), (3, 15)').run();
            const blob2 = buildGenMetadataBlob(200, 40, 0, { stepIndices: [3] });
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(
              2,
              blob2,
              blob2.byteLength,
            );
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240 } },
            });
          } else {
            db.prepare('INSERT INTO steps (idx, step_type) VALUES (4, 14), (5, 15)').run();
            const blob3 = buildGenMetadataBlob(300, 60, 0, { stepIndices: [5] });
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(
              3,
              blob3,
              blob3.byteLength,
            );
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: 60, totalTokens: 360 } },
            });
          }
        }
      });

      const emitted: AgentMessage[] = [];
      const backend = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'gemini-3.1-pro-high',
        agyHomeDir: tmpHome1,
        spawnFn: (() => proc) as unknown as SpawnFn,
      });
      backend.onMessage((m) => emitted.push(m));

      backend.setTurnStartedAt(1_700_000_001_000);
      await backend.sendPrompt('/work', 'Turn A');

      backend.setModel('claude-opus-4-6-thinking');
      backend.setTurnStartedAt(1_700_000_002_000);
      await backend.sendPrompt('/work', 'Turn B');

      // Row 1 finally gets its ModelUsageStats AFTER Turn B has finished!
      const finishedBlob1 = buildGenMetadataBlob(110, 25, 0, { stepIndices: [1] });
      db.prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 1').run(
        finishedBlob1,
        finishedBlob1.byteLength,
      );

      backend.setModel('claude-sonnet-4-6');
      backend.setTurnStartedAt(1_700_000_003_000);
      await backend.sendPrompt('/work', 'Turn C');
      db.close();

      const steps = emitted.filter(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
      );
      const stepRow1 = steps.find((s) => s.usageKey === `${convId}:sql:1`)!;
      const stepRow2 = steps.find((s) => s.usageKey === `${convId}:sql:2`)!;
      const stepRow3 = steps.find((s) => s.usageKey === `${convId}:sql:3`)!;

      expect(stepRow1.usageModel).toBe('gemini-3.1-pro-high');
      expect(stepRow1.usageStartedAt).toBe(1_700_000_001_000);
      expect(stepRow2.usageModel).toBe('claude-opus-4-6-thinking');
      expect(stepRow2.usageStartedAt).toBe(1_700_000_002_000);
      expect(stepRow3.usageModel).toBe('claude-sonnet-4-6');
      expect(stepRow3.usageStartedAt).toBe(1_700_000_003_000);
    } finally {
      rmSync(tmpHome1, { recursive: true, force: true });
    }

    // Part B: Turn A finishes without inserting a SQLite row yet, and row 1 is first inserted
    // AFTER Turn B's pre-prompt snapshot -> emits unknown attribution (null / undefined), never Turn B's metadata!
    const tmpHome2 = mkdtempSync(join(tmpdir(), 'lmc-agy-ambig-'));
    try {
      const convId = 'ambig-late-insert-conv';
      const db = openTestConversationDb(tmpHome2, convId);

      const proc = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convId) });
        } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          const text = msg.params?.prompt?.[0]?.text;
          if (text === 'Turn A') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          } else {
            // During Turn B (after prePromptSnap), a single row without normalizedModelId is inserted!
            const blob1 = buildGenMetadataBlob(90, 15, 0);
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(
              1,
              blob1,
              blob1.byteLength,
            );
            p.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          }
        }
      });

      const emitted: AgentMessage[] = [];
      const backend = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'gemini-3.1-pro-high',
        agyHomeDir: tmpHome2,
        spawnFn: (() => proc) as unknown as SpawnFn,
      });
      backend.onMessage((m) => emitted.push(m));

      backend.setTurnStartedAt(1_700_000_010_000);
      await backend.sendPrompt('/work', 'Turn A');

      backend.setModel('claude-opus-4-6-thinking');
      backend.setTurnStartedAt(1_700_000_020_000);
      await backend.sendPrompt('/work', 'Turn B');
      db.close();

      const stepRow1 = emitted.find(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> =>
          m.type === 'token-count' && m.scope === 'step' && m.usageKey === `${convId}:sql:1`,
      )!;
      expect(stepRow1).toBeDefined();
      expect(stepRow1.usageModel).toBeNull();
      expect('usageStartedAt' in stepRow1).toBe(true);
      expect(stepRow1.usageStartedAt).toBeUndefined();
    } finally {
      rmSync(tmpHome2, { recursive: true, force: true });
    }
  });

  it('revokes automatic retry when late tool activity arrives during media-repair retirement or 401 auth backoff (R5-P1-1)', async () => {
    // Part A: Live ACP returns 400 INVALID_ARGUMENT (`replay_original_prompt`); buffered `tool_call`
    // arrives while `closeProcess({ requireExit: true })` is waiting for child exit -> MUST NOT replay!
    let mediaRepairSpawns = 0;
    const retiringToolProc = createMockAcpProcess(
      (msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('r5-media-late-tool') });
        } else if (msg.method === 'session/prompt') {
          p.send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: '400 INVALID_ARGUMENT: Unable to process input image' },
          });
        }
      },
      { deferCloseManual: true },
    );
    retiringToolProc.kill.mockImplementation((sig?: NodeJS.Signals) => {
      retiringToolProc.killed = true;
      retiringToolProc.stdin.writable = false;
      setTimeout(() => {
        retiringToolProc.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'r5-media-late-tool',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'late-retire-tool-1',
              name: 'write_file',
              args: { Path: '/work/mutated.txt' },
              status: 'completed',
            },
          },
        });
        retiringToolProc.triggerExit(0, sig ?? 'SIGTERM');
      }, 10);
      return true;
    });

    const backendMedia = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      transientStreamRetryDelaysMs: [],
      repairConversationMedia: () => ({ repairedCount: 1, repairedSteps: [42], backupPath: '/tmp/b.bak' }),
      spawnFn: (() => {
        mediaRepairSpawns += 1;
        return retiringToolProc;
      }) as unknown as SpawnFn,
    });

    await expect(backendMedia.sendPrompt('/work', 'Mutating prompt hitting 400')).rejects.toThrow(
      /400 INVALID_ARGUMENT/,
    );
    expect(mediaRepairSpawns).toBe(1);

    // Part B: Warm ACP returns 401 UNAUTHENTICATED (`replay_original_prompt`); late `tool_call`
    // arrives on the still-live ACP process during `authRetryDelayMs` -> MUST NOT retry!
    let authPromptsSent = 0;
    const warmAuthProc = createMockAcpProcess((msg, p) => {
      if (msg.method === 'initialize') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('r5-auth-late-tool') });
      } else if (msg.method === 'session/prompt') {
        authPromptsSent += 1;
        p.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: 'UNAUTHENTICATED: OAuth token expired (401)' },
        });
        setTimeout(() => {
          p.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'r5-auth-late-tool',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'late-backoff-tool-1',
                name: 'run_command',
                args: { CommandLine: 'rm -rf /tmp/x' },
                status: 'completed',
              },
            },
          });
        }, 5);
      }
    });

    const backendAuth = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      authRetryDelayMs: 25,
      transientStreamRetryDelaysMs: [],
      spawnFn: (() => warmAuthProc) as unknown as SpawnFn,
    });

    await expect(backendAuth.sendPrompt('/work', 'Mutating prompt hitting 401')).rejects.toThrow(
      /UNAUTHENTICATED/,
    );
    expect(authPromptsSent).toBe(1);
  });

  it('does not infer complete multi-generation turn roster from kTurn > 0 without step-identity proof, and isolates per-turn fallback credit (R5-P2-1 & R5-P2-2)', async () => {
    // Part A (R5-P2-1): Multi-generation Turn A observes row 1 (no stepIndices, no usable prompt usage);
    // Turn A's delayed 2nd row inserted after Turn B's prePromptSnap MUST emit unknown attribution, never Turn B!
    const tmpHome1 = mkdtempSync(join(tmpdir(), 'lmc-agy-r5-p2-1-'));
    try {
      const convId = 'r5-multigen-ambig-conv';
      const db = openTestConversationDb(tmpHome1, convId);

      const proc = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convId) });
        } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          const text = msg.params?.prompt?.[0]?.text;
          if (text === 'Turn A') {
            const row1 = buildGenMetadataBlob(50, 10, 0);
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)').run(row1, row1.byteLength);
            p.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          } else {
            // Delayed 2nd row from Turn A arrives after Turn B's snapshot without stepIndices!
            const row2 = buildGenMetadataBlob(80, 15, 0);
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (2, ?, ?)').run(row2, row2.byteLength);
            p.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          }
        }
      });

      const emitted: AgentMessage[] = [];
      const backend = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'gemini-3.1-pro-high',
        agyHomeDir: tmpHome1,
        spawnFn: (() => proc) as unknown as SpawnFn,
      });
      backend.onMessage((m) => emitted.push(m));

      backend.setTurnStartedAt(1_700_000_100_000);
      await backend.sendPrompt('/work', 'Turn A');

      backend.setModel('claude-opus-4-6-thinking');
      backend.setTurnStartedAt(1_700_000_200_000);
      await backend.sendPrompt('/work', 'Turn B');
      db.close();

      const steps = emitted.filter(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
      );
      const r1 = steps.find((s) => s.usageKey === `${convId}:sql:1`)!;
      const r2 = steps.find((s) => s.usageKey === `${convId}:sql:2`)!;
      expect(r1.usageModel).toBe('gemini-3.1-pro-high');
      expect(r1.usageStartedAt).toBe(1_700_000_100_000);
      expect(r2.usageModel).toBeNull();
      expect('usageStartedAt' in r2).toBe(true);
      expect(r2.usageStartedAt).toBeUndefined();
    } finally {
      rmSync(tmpHome1, { recursive: true, force: true });
    }

    // Part B (R5-P2-2): Turn A creates unfinished row 1 (no fallback credit); Turn B creates unfinished
    // row 2 and emits 200/40 fallback credit; before Turn C, row 1 finishes (100/20) and row 2 finishes (200/40).
    // Row 1 MUST NOT consume Turn B's credit -> final accounting MUST be A = 100/20 and B = 200/40!
    const tmpHome2 = mkdtempSync(join(tmpdir(), 'lmc-agy-r5-p2-2-'));
    try {
      const convId = 'r5-credit-isolation-conv';
      const db = openTestConversationDb(tmpHome2, convId);
      const unfinishedRow1 = Uint8Array.from(encodeLenField(2, encodeVarint(1)));
      const unfinishedRow2 = Uint8Array.from(encodeLenField(2, encodeVarint(3)));

      const proc = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convId) });
        } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          const text = msg.params?.prompt?.[0]?.text;
          if (text === 'Turn A') {
            db.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 14), (1, 15)').run();
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)').run(
              unfinishedRow1,
              unfinishedRow1.byteLength,
            );
            p.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          } else if (text === 'Turn B') {
            db.prepare('INSERT INTO steps (idx, step_type) VALUES (2, 14), (3, 15)').run();
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (2, ?, ?)').run(
              unfinishedRow2,
              unfinishedRow2.byteLength,
            );
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240 } },
            });
          } else {
            p.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          }
        }
      });

      const emitted: AgentMessage[] = [];
      const backend = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'gemini-3.1-pro-high',
        agyHomeDir: tmpHome2,
        spawnFn: (() => proc) as unknown as SpawnFn,
      });
      backend.onMessage((m) => emitted.push(m));

      backend.setTurnStartedAt(1_700_000_300_000);
      await backend.sendPrompt('/work', 'Turn A');

      backend.setModel('claude-opus-4-6-thinking');
      backend.setTurnStartedAt(1_700_000_400_000);
      await backend.sendPrompt('/work', 'Turn B');

      // Before Turn C: row 1 finishes with 100/20 (A) and row 2 finishes with 200/40 (B)!
      const finished1 = buildGenMetadataBlob(100, 20, 0, { stepIndices: [1] });
      const finished2 = buildGenMetadataBlob(200, 40, 0, { stepIndices: [3] });
      db.prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 1').run(finished1, finished1.byteLength);
      db.prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 2').run(finished2, finished2.byteLength);

      backend.setModel('claude-sonnet-4-6');
      backend.setTurnStartedAt(1_700_000_500_000);
      await backend.sendPrompt('/work', 'Turn C');
      db.close();

      const steps = emitted.filter(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
      );
      const byModel = new Map<string, { inTok: number; outTok: number; startedAt: number | undefined }>();
      for (const s of steps) {
        const mKey = String(s.usageModel);
        const startedAtVal = typeof s.usageStartedAt === 'number' ? s.usageStartedAt : undefined;
        const cur = byModel.get(mKey) ?? { inTok: 0, outTok: 0, startedAt: startedAtVal };
        const u = s.usage as Record<string, number>;
        cur.inTok += u.input_tokens ?? 0;
        cur.outTok += u.output_tokens ?? 0;
        byModel.set(mKey, cur);
      }

      expect(byModel.get('gemini-3.1-pro-high')).toEqual({
        inTok: 100,
        outTok: 20,
        startedAt: 1_700_000_300_000,
      });
      expect(byModel.get('claude-opus-4-6-thinking')).toEqual({
        inTok: 200,
        outTok: 40,
        startedAt: 1_700_000_400_000,
      });
      expect(byModel.has('claude-sonnet-4-6')).toBe(false);
    } finally {
      rmSync(tmpHome2, { recursive: true, force: true });
    }
  });

  it('aborts retry before writing session/prompt when late tool activity arrives during retry setup RPCs (R6-P1-1)', async () => {
    let spawns = 0;
    let promptsSent = 0;
    let setModesSent = 0;

    const warmSetupRaceProc = createMockAcpProcess((msg, p) => {
      if (msg.method === 'initialize') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('r6-setup-race-conv') });
      } else if (msg.method === 'session/set_mode') {
        setModesSent += 1;
        if (promptsSent === 1) {
          // Retry attempt is inside `ensureSessionReady()` awaiting `session/set_mode`!
          // Deliver Prompt A's delayed mutating `tool_call` BEFORE acknowledging `session/set_mode`.
          p.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'r6-setup-race-conv',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'delayed-turn-a-mutation',
                name: 'write_file',
                args: { Path: '/work/once-only.txt' },
                status: 'completed',
              },
            },
          });
        }
        p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      } else if (msg.method === 'session/prompt') {
        promptsSent += 1;
        p.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: 'UNAUTHENTICATED: OAuth token expired (401)' },
        });
        // During OAuth 401 backoff, server sends `current_mode_update` -> `plan` (non-turn-activity),
        // forcing the retry attempt to await `session/set_mode` (`default`) during setup!
        setTimeout(() => {
          p.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'r6-setup-race-conv',
              update: {
                sessionUpdate: 'current_mode_update',
                currentModeId: 'plan',
              },
            },
          });
        }, 5);
      }
    });

    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      authRetryDelayMs: 25,
      transientStreamRetryDelaysMs: [],
      spawnFn: (() => {
        spawns += 1;
        return warmSetupRaceProc;
      }) as unknown as SpawnFn,
    });

    await expect(backend.sendPrompt('/work', 'Mutating prompt A')).rejects.toThrow(/UNAUTHENTICATED/);
    expect(spawns).toBe(1);
    expect(setModesSent).toBeGreaterThanOrEqual(1);
    // CRITICAL: Only ONE `session/prompt` was ever written to the warm ACP server!
    expect(promptsSent).toBe(1);
  });

  it('conserves exact per-turn and aggregate usage when an unknown row precedes a delayed known row (R6-P2-1)', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'lmc-agy-r6-p2-1-'));
    try {
      const convId = 'r6-unknown-credit-conv';
      const db = openTestConversationDb(tmpHome, convId);

      const proc = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convId) });
        } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          const text = msg.params?.prompt?.[0]?.text;
          if (text === 'Turn A') {
            // A commits step 0 and returns prompt usage 100/20, but its generation row 1 is absent.
            db.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 14)').run();
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
            });
          } else if (text === 'Turn B') {
            // B commits step 1; row 2 becomes visible with 200/40 WITHOUT stepIndices or model label (`unknown([A, B])`),
            // and B returns prompt usage 200/40.
            db.prepare('INSERT INTO steps (idx, step_type) VALUES (1, 14)').run();
            const row2Unknown = buildGenMetadataBlob(200, 40, 0);
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (2, ?, ?)').run(
              row2Unknown,
              row2Unknown.byteLength,
            );
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240 } },
            });
          } else {
            p.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          }
        }
      });

      const emitted: AgentMessage[] = [];
      const backend = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'gemini-3.1-pro-high',
        agyHomeDir: tmpHome,
        spawnFn: (() => proc) as unknown as SpawnFn,
      });
      backend.onMessage((m) => emitted.push(m));

      backend.setTurnStartedAt(1_700_001_000_000);
      await backend.sendPrompt('/work', 'Turn A');

      backend.setModel('claude-opus-4-6-thinking');
      backend.setTurnStartedAt(1_700_002_000_000);
      await backend.sendPrompt('/work', 'Turn B');

      // Before Turn C: insert A's delayed generation row 1 with usage 100/20 and `stepIndices: [0]`.
      const row1KnownA = buildGenMetadataBlob(100, 20, 0, { stepIndices: [0] });
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)').run(
        row1KnownA,
        row1KnownA.byteLength,
      );

      backend.setModel('claude-sonnet-4-6');
      backend.setTurnStartedAt(1_700_003_000_000);
      await backend.sendPrompt('/work', 'Turn C');
      db.close();

      const steps = emitted.filter(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
      );
      let totalIn = 0;
      let totalOut = 0;
      const byModel = new Map<string, { inTok: number; outTok: number; startedAt: number | undefined }>();
      for (const s of steps) {
        const u = s.usage as Record<string, number>;
        totalIn += u.input_tokens ?? 0;
        totalOut += u.output_tokens ?? 0;
        const mKey = String(s.usageModel);
        const cur = byModel.get(mKey) ?? {
          inTok: 0,
          outTok: 0,
          startedAt: typeof s.usageStartedAt === 'number' ? s.usageStartedAt : undefined,
        };
        cur.inTok += u.input_tokens ?? 0;
        cur.outTok += u.output_tokens ?? 0;
        byModel.set(mKey, cur);
      }

      // Exact conservation: A = 100/20, B = 200/40, Unknown = 0, Total = 300/60 (never 400/80!).
      expect(totalIn).toBe(300);
      expect(totalOut).toBe(60);
      expect(byModel.get('gemini-3.1-pro-high')).toEqual({
        inTok: 100,
        outTok: 20,
        startedAt: 1_700_001_000_000,
      });
      expect(byModel.get('claude-opus-4-6-thinking')).toEqual({
        inTok: 200,
        outTok: 40,
        startedAt: 1_700_002_000_000,
      });
      expect(byModel.has('null')).toBe(false);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('preserves genIdx, contextWindowTokens, and belongsToCurrentTurn=false on delayed step usage events (R6-P2-2)', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'lmc-agy-r6-p2-2-'));
    try {
      const convId = 'r6-delayed-window-conv';
      const db = openTestConversationDb(tmpHome, convId);
      const unfinishedRow1 = Uint8Array.from([
        ...encodeLenField(2, encodeVarint(0)),
        ...encodeLenField(1, encodeLenField(9, encodeLenField(10, encodeVarintField(4, 128_000)))),
      ]);
      const inFlightHeadRow2 = Uint8Array.from(
        encodeLenField(1, encodeLenField(9, encodeLenField(10, encodeVarintField(4, 1_000_000)))),
      );

      const proc = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convId) });
        } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          const text = msg.params?.prompt?.[0]?.text;
          if (text === 'Turn A') {
            db.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 14)').run();
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)').run(
              unfinishedRow1,
              unfinishedRow1.byteLength,
            );
            p.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          } else {
            // During Turn B: Row 1 finishes (128,000 window, M-A), while B creates unlabeled Row 2 (1,000,000 window).
            const finishedRow1 = buildGenMetadataBlob(5000, 300, 0, {
              stepIndices: [0],
              modelDisplayName: 'Gemini 3.1 Pro (High)',
              maxContextTokens: 128_000,
            });
            db.prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 1').run(
              finishedRow1,
              finishedRow1.byteLength,
            );
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (2, ?, ?)').run(
              inFlightHeadRow2,
              inFlightHeadRow2.byteLength,
            );
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn', usage: { inputTokens: 8000, outputTokens: 500, totalTokens: 8500 } },
            });
          }
        }
      });

      const emitted: AgentMessage[] = [];
      const backend = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'gemini-3.1-pro-high',
        agyHomeDir: tmpHome,
        spawnFn: (() => proc) as unknown as SpawnFn,
      });
      backend.onMessage((m) => emitted.push(m));

      await backend.sendPrompt('/work', 'Turn A');
      backend.setModel('claude-opus-4-6-thinking');
      await backend.sendPrompt('/work', 'Turn B');
      db.close();

      const row1Msg = emitted.find(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> =>
          m.type === 'token-count' && m.scope === 'step' && m.usageKey === `${convId}:sql:1`,
      )!;
      expect(row1Msg).toBeDefined();
      expect(row1Msg.genIdx).toBe(1);
      expect(row1Msg.contextWindowTokens).toBe(128_000);
      expect(row1Msg.belongsToCurrentTurn).toBe(false);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('reconciles delayed SQLite usage corrections on closeForHandoff/dispose and preserves unresolved in-flight rows across backend recreation without double-billing (R7-P2-2)', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'lmc-agy-r7-p2-2-'));
    try {
      // Part A (direct R7-P2-2 scenario): Turn A emits fallback 100/20; delayed SQLite row commits 140/30
      // while idle; `closeForHandoff()` retires child and emits +40/+10 immediately; replacement backend
      // resumes conversation and does NOT drop or re-emit the +40/+10 correction!
      const convIdA = 'r7-handoff-delayed-conv-a';
      const dbA = openTestConversationDb(tmpHome, convIdA);

      const procA1 = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convIdA) });
        } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          dbA.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 15)').run();
          p.send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
          });
        }
      });

      const emittedA: AgentMessage[] = [];
      const backendA1 = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'claude-opus-4-6-thinking',
        agyHomeDir: tmpHome,
        spawnFn: (() => procA1) as unknown as SpawnFn,
      });
      backendA1.onMessage((m) => emittedA.push(m));
      backendA1.setTurnStartedAt(1_700_000_000_000);
      await backendA1.sendPrompt('/work', 'Turn A before refresh');

      // Delayed SQLite row commits 140/30 after terminal scan while backendA1 is idle:
      const delayedBlobA = buildGenMetadataBlob(140, 30, 0, { stepIndices: [0] });
      dbA.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)').run(
        delayedBlobA,
        delayedBlobA.byteLength,
      );

      // User refreshes instead of sending Turn B on backendA1:
      await backendA1.closeForHandoff();

      const stepsAfterHandoffClose = emittedA.filter(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
      );
      expect(stepsAfterHandoffClose).toHaveLength(2);
      expect(stepsAfterHandoffClose[0].usage).toEqual({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 0,
        total_tokens: 120,
      });
      expect(stepsAfterHandoffClose[1].usageKey).toBe(`${convIdA}:sql:1`);
      expect(stepsAfterHandoffClose[1].usage).toEqual({
        input_tokens: 40,
        output_tokens: 10,
        cache_read_tokens: 0,
        total_tokens: 50,
      });
      expect(stepsAfterHandoffClose[1].usageModel).toBe('claude-opus-4-6-thinking');
      expect(stepsAfterHandoffClose[1].usageStartedAt).toBe(1_700_000_000_000);

      // Recreate replacement backend for the same conversation and run Turn B (300/50):
      const procA2 = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/resume') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convIdA) });
        } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          dbA.prepare('INSERT INTO steps (idx, step_type) VALUES (1, 15)').run();
          const blobB = buildGenMetadataBlob(300, 50, 0, { stepIndices: [1] });
          dbA.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (2, ?, ?)').run(
            blobB,
            blobB.byteLength,
          );
          p.send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: 50, totalTokens: 350 } },
          });
        }
      });

      const backendA2 = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        conversationId: convIdA,
        model: 'gemini-3.1-pro-high',
        agyHomeDir: tmpHome,
        spawnFn: (() => procA2) as unknown as SpawnFn,
      });
      backendA2.onMessage((m) => emittedA.push(m));
      backendA2.setTurnStartedAt(1_700_000_999_000);
      await backendA2.sendPrompt('/work', 'Turn B after refresh');
      await backendA2.dispose();
      dbA.close();

      const allStepsA = emittedA.filter(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
      );
      // Correction +40/+10 was emitted ONCE (total steps: A residual 100/20, A sql:1 40/10, B sql:2 300/50 = 440/80).
      expect(allStepsA).toHaveLength(3);
      expect(allStepsA.filter((s) => s.usageKey === `${convIdA}:sql:1`)).toHaveLength(1);

      // Part B (unresolved state preserved across handoff):
      // Row 1 exists in `gen_metadata` at `closeForHandoff()` with `chat_start_metadata` ONLY (no `ModelUsageStats` yet);
      // `closeForHandoff()` persists `.lmc-usage-handoff.json`; Row 1 finishes (140/30) right before replacement
      // backend runs -> replacement backend MUST NOT absorb Row 1 into `baselineMaxGenIdx` and MUST emit +40/+10 once!
      const convIdB = 'r7-handoff-unresolved-conv-b';
      const dbB = openTestConversationDb(tmpHome, convIdB);
      const unfinishedHeaderRow1 = Uint8Array.from([
        ...encodeLenField(2, encodeVarint(0)),
        ...encodeLenField(1, encodeLenField(9, encodeLenField(10, encodeVarintField(4, 256_000)))),
      ]);

      const procB1 = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convIdB) });
        } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          dbB.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 15)').run();
          dbB.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)').run(
            unfinishedHeaderRow1,
            unfinishedHeaderRow1.byteLength,
          );
          p.send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
          });
        }
      });

      const emittedB: AgentMessage[] = [];
      const backendB1 = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'claude-opus-4-6-thinking',
        agyHomeDir: tmpHome,
        spawnFn: (() => procB1) as unknown as SpawnFn,
      });
      backendB1.onMessage((m) => emittedB.push(m));
      backendB1.setTurnStartedAt(1_700_010_000_000);
      await backendB1.sendPrompt('/work', 'Turn A with unfinished row at handoff');
      await backendB1.closeForHandoff();

      const handoffFileB = join(tmpHome, 'conversations', `${convIdB}.lmc-usage-handoff.json`);
      expect(existsSync(handoffFileB)).toBe(true);

      // Now Row 1 commits its final 140/30 `ModelUsageStats` before replacement backendB2 starts!
      const finishedBlobB1 = buildGenMetadataBlob(140, 30, 0, { stepIndices: [0] });
      dbB.prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 1').run(
        finishedBlobB1,
        finishedBlobB1.byteLength,
      );

      const procB2 = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/resume') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convIdB) });
        }
      });

      const backendB2 = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        conversationId: convIdB,
        model: 'gemini-3.1-pro-high',
        agyHomeDir: tmpHome,
        spawnFn: (() => procB2) as unknown as SpawnFn,
      });
      backendB2.onMessage((m) => emittedB.push(m));
      // Even if backendB2 is disposed WITHOUT running another prompt, it reconciles the hydrated ledger!
      await backendB2.dispose();
      dbB.close();

      expect(existsSync(handoffFileB)).toBe(false);
      const allStepsB = emittedB.filter(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
      );
      expect(allStepsB).toHaveLength(2);
      expect(allStepsB[1].usageKey).toBe(`${convIdB}:sql:1`);
      expect(allStepsB[1].usage).toEqual({
        input_tokens: 40,
        output_tokens: 10,
        cache_read_tokens: 0,
        total_tokens: 50,
      });
      expect(allStepsB[1].usageModel).toBe('claude-opus-4-6-thinking');
      expect(allStepsB[1].usageStartedAt).toBe(1_700_010_000_000);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('rejects malformed session/prompt and control RPC results as non-retryable protocol failures without completing the turn (R7-P2-4)', async () => {
    const invalidPromptResults: unknown[] = [
      {}, // missing stopReason
      { stopReason: null },
      { stopReason: 123 },
      { stopReason: 'bogus_unsupported_reason' },
      { stopReason: 'end_turn', usage: 'not-an-object' },
    ];

    for (const badResult of invalidPromptResults) {
      let spawns = 0;
      let promptsSent = 0;
      const statuses: string[] = [];

      const badPromptProc = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload('r7-bad-prompt-res') });
        } else if (msg.method === 'session/set_mode' || msg.method === 'session/set_model') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          promptsSent += 1;
          p.send({ jsonrpc: '2.0', id: msg.id, result: badResult });
        }
      });

      const backend = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        transientStreamRetryDelaysMs: [5, 5],
        spawnFn: (() => {
          spawns += 1;
          return badPromptProc;
        }) as unknown as SpawnFn,
      });
      backend.onMessage((m) => {
        if (m.type === 'status') statuses.push(m.status);
      });

      await expect(backend.sendPrompt('/work', 'Do work once')).rejects.toThrow(
        /Invalid Antigravity ACP session\/prompt result/,
      );
      // Must NOT auto-retry after dispatching prompt (`retrySafety === 'unsafe_side_effects'`),
      // and must retire the protocol-violating ACP server process!
      expect(spawns).toBe(1);
      expect(promptsSent).toBe(1);
      expect(badPromptProc.kill).toHaveBeenCalled();
      expect(statuses[statuses.length - 1]).toBe('error');
    }

    // Malformed `initialize` (`{}` missing `protocolVersion`) also fails closed and retires child:
    const badInitProc = createMockAcpProcess((msg, p) => {
      if (msg.method === 'initialize') {
        p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });
    const badInitBackend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      transientStreamRetryDelaysMs: [],
      spawnFn: (() => badInitProc) as unknown as SpawnFn,
    });
    await expect(badInitBackend.sendPrompt('/work', 'Init check')).rejects.toThrow(
      /Invalid Antigravity ACP initialize result/,
    );
    expect(badInitProc.kill).toHaveBeenCalled();
  });

  it('exercises augmenting-path credit reassignment and preemption displacement when unknown rows borrow settled supply first (R6-P2-1)', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'lmc-agy-augment-displace-'));
    try {
      // Part A: True augmenting-path reassignment (`augmentCreditFromTurn`):
      // 1. Turn A (`gemini-3.1-pro-high`) finishes with 100/20 fallback supply (Row 1 delayed).
      // 2. Turn B (`claude-opus-4-6-thinking`) creates unfinished `known(B)` Row 3 (`stepIndices: [1]`, no usage yet)
      //    plus finalized `unknown([A, B])` Row 2 (100/20), and returns prompt usage 200/40.
      //    Because Turn B has `unfinishedKnownRows = {3}`, `preferSettledOnly` skips B and matches Row 2
      //    against A's settled 100/20 supply (`A.fallbackCredit` becomes 0/0, `B.fallbackCredit` is 200/40)!
      // 3. Before Turn C: Row 3 (`known(B)`) finishes with 100/20 (consuming 100/20 of B and leaving 100/20 free on B),
      //    AND delayed Row 1 (`known(A)`, `stepIndices: [0]`) finishes with 100/20!
      //    When Row 1 matches, A has 0/0 direct credit, so `augmentCreditFromTurn` reassigns Row 2 from A -> B,
      //    freeing A's 100/20 credit for Row 1 with ZERO overcharge!
      const convAug = 'r7-augment-path-conv';
      const dbAug = openTestConversationDb(tmpHome, convAug);
      const unfinishedKnownBRow3 = Uint8Array.from([
        ...encodeLenField(2, encodeVarint(1)),
        ...encodeLenField(1, encodeLenField(9, encodeLenField(10, encodeVarintField(4, 256_000)))),
      ]);

      const procAug = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convAug) });
        } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          const text = msg.params?.prompt?.[0]?.text;
          if (text === 'Turn A') {
            dbAug.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 14)').run();
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
            });
          } else if (text === 'Turn B') {
            dbAug.prepare('INSERT INTO steps (idx, step_type) VALUES (1, 14)').run();
            const row2Unknown = buildGenMetadataBlob(100, 20, 0);
            dbAug.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (2, ?, ?)').run(
              row2Unknown,
              row2Unknown.byteLength,
            );
            dbAug.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (3, ?, ?)').run(
              unfinishedKnownBRow3,
              unfinishedKnownBRow3.byteLength,
            );
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240 } },
            });
          } else {
            p.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          }
        }
      });

      const emittedAug: AgentMessage[] = [];
      const backendAug = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'gemini-3.1-pro-high',
        agyHomeDir: tmpHome,
        spawnFn: (() => procAug) as unknown as SpawnFn,
      });
      backendAug.onMessage((m) => emittedAug.push(m));
      backendAug.setTurnStartedAt(1_700_100_000_000);
      await backendAug.sendPrompt('/work', 'Turn A');

      backendAug.setModel('claude-opus-4-6-thinking');
      backendAug.setTurnStartedAt(1_700_200_000_000);
      await backendAug.sendPrompt('/work', 'Turn B');

      // Finalize Row 3 (`known(B)` = 100/20) AND insert delayed Row 1 (`known(A)` = 100/20);
      // Note `syncSqlStepUsage` iterates ascending `idx` (1, then 3), so when Row 1 (`idx=1`) runs,
      // Row 3 is STILL unfinished (`preferSettledOnly=true` skips B, then `preferSettledOnly=false`
      // augments Row 2 from A onto B's 200/40 credit, leaving 100/20 on B for Row 3)!
      const row1KnownA = buildGenMetadataBlob(100, 20, 0, { stepIndices: [0] });
      const row3KnownB = buildGenMetadataBlob(100, 20, 0, { stepIndices: [1] });
      dbAug.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)').run(
        row1KnownA,
        row1KnownA.byteLength,
      );
      dbAug.prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 3').run(
        row3KnownB,
        row3KnownB.byteLength,
      );

      await backendAug.closeForHandoff();
      dbAug.close();

      const augSteps = emittedAug.filter(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
      );
      const augTotalIn = augSteps.reduce((s, m) => s + ((m.usage as any).input_tokens ?? 0), 0);
      const augTotalOut = augSteps.reduce((s, m) => s + ((m.usage as any).output_tokens ?? 0), 0);
      expect(augTotalIn).toBe(300);
      expect(augTotalOut).toBe(60);
      expect(augSteps.some((m) => String(m.usageKey).includes(':reconcile-'))).toBe(false);

      // Part B: Preemption displacement (`displacedByRow`):
      // Same setup except Turn B's prompt usage is only 100/20 (not 200/40).
      // Row 2 (`unknown([A, B])`, 100/20) borrows A's 100/20; Row 3 (`known(B)`, 100/20) consumes ALL of B's 100/20;
      // then delayed Row 1 (`known(A)`, 100/20) arrives when BOTH A and B have 0 free credit ->
      // Row 1 preempts its 100/20 from `unknown` Row 2 and emits `${convDisp}:sql:2:reconcile-1` (100/20, model=null)!
      const convDisp = 'r7-preempt-displace-conv';
      const dbDisp = openTestConversationDb(tmpHome, convDisp);

      const procDisp = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convDisp) });
        } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          const text = msg.params?.prompt?.[0]?.text;
          if (text === 'Turn A') {
            dbDisp.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 14)').run();
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
            });
          } else if (text === 'Turn B') {
            dbDisp.prepare('INSERT INTO steps (idx, step_type) VALUES (1, 14)').run();
            const row2Unknown = buildGenMetadataBlob(100, 20, 0);
            dbDisp.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (2, ?, ?)').run(
              row2Unknown,
              row2Unknown.byteLength,
            );
            dbDisp.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (3, ?, ?)').run(
              unfinishedKnownBRow3,
              unfinishedKnownBRow3.byteLength,
            );
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
            });
          } else {
            p.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          }
        }
      });

      const emittedDisp: AgentMessage[] = [];
      const backendDisp = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'gemini-3.1-pro-high',
        agyHomeDir: tmpHome,
        spawnFn: (() => procDisp) as unknown as SpawnFn,
      });
      backendDisp.onMessage((m) => emittedDisp.push(m));
      backendDisp.setTurnStartedAt(1_700_300_000_000);
      await backendDisp.sendPrompt('/work', 'Turn A');

      backendDisp.setModel('claude-opus-4-6-thinking');
      backendDisp.setTurnStartedAt(1_700_400_000_000);
      await backendDisp.sendPrompt('/work', 'Turn B');

      // First let Row 3 (`known(B)` = 100/20) consume B's 100/20 credit on Turn C:
      dbDisp.prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 3').run(
        row3KnownB,
        row3KnownB.byteLength,
      );
      await backendDisp.sendPrompt('/work', 'Turn C settle B');

      // Now BOTH A and B have 0 free credit (Row 2 holds A's 100/20, Row 3 holds B's 100/20);
      // insert delayed Row 1 (`known(A)` = 100/20) and close -> triggers preemption displacement onto Row 2!
      dbDisp.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)').run(
        row1KnownA,
        row1KnownA.byteLength,
      );
      await backendDisp.closeForHandoff();
      dbDisp.close();

      const dispSteps = emittedDisp.filter(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
      );
      const displacedMsg = dispSteps.find((m) => m.usageKey === `${convDisp}:sql:2:reconcile-1`)!;
      expect(displacedMsg).toBeDefined();
      expect(displacedMsg.usage).toEqual({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 0,
        total_tokens: 120,
      });
      expect(displacedMsg.usageModel).toBeNull();

      const dispTotalIn = dispSteps.reduce((s, m) => s + ((m.usage as any).input_tokens ?? 0), 0);
      const dispTotalOut = dispSteps.reduce((s, m) => s + ((m.usage as any).output_tokens ?? 0), 0);
      // Exact 3-row conservation: Row 1 (100/20) + Row 2 (100/20) + Row 3 (100/20) = 300/60!
      expect(dispTotalIn).toBe(300);
      expect(dispTotalOut).toBe(60);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('blocks ownership release on handoff persistence write/rename failures, writes 0o600 sidecars, and refuses to baseline over unreadable or malformed sidecars (R8-P2-4)', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'agy-acp-r8-p2-4-'));
    const realFs: AgyUsageHandoffFs = {
      statSync: (p) => statSync(p),
      readFileSync: (p, enc) => readFileSync(p, enc),
      mkdirSync: (p, opts) => mkdirSync(p, opts),
      openSync: (p, flags, mode) => openSync(p, flags, mode),
      writeFileSync: (fd, data, enc) => writeFileSync(fd, data, enc),
      chmodSync: (p, mode) => chmodSync(p, mode),
      fsyncSync: (fd) => fsyncSync(fd),
      closeSync: (fd) => closeSync(fd),
      renameSync: (oldP, newP) => renameSync(oldP, newP),
      unlinkSync: (p) => unlinkSync(p),
    };

    try {
      const unfinishedRow1 = Uint8Array.from([
        ...encodeLenField(2, encodeVarint(0)),
        ...encodeLenField(
          1,
          encodeLenField(21, Array.from(Buffer.from('Gemini 3.1 Pro (High)', 'utf8'))),
        ),
      ]);
      const settledRow1 = buildGenMetadataBlob(140, 30, 0, {
        modelDisplayName: 'Gemini 3.1 Pro (High)',
        stepIndices: [0],
      });

      // Case A: Inject `writeFileSync` ENOSPC during `closeForHandoff()` -> rejects without losing ledger ownership;
      // when retried after ENOSPC clears (and Row 1 settles to 140/30), emits +40/+10 once!
      const convWriteFail = 'r8-handoff-write-fail';
      const dbWriteFail = openTestConversationDb(tmpHome, convWriteFail);
      let failWriteOnce = true;
      const fsWriteInject: AgyUsageHandoffFs = {
        ...realFs,
        writeFileSync: (fd, data, enc) => {
          if (failWriteOnce) {
            throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
          }
          realFs.writeFileSync(fd, data, enc);
        },
      };

      const procWrite1 = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convWriteFail) });
        } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          dbWriteFail.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 14)').run();
          dbWriteFail
            .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)')
            .run(unfinishedRow1, unfinishedRow1.byteLength);
          p.send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
          });
        }
      });

      const emittedWrite: AgentMessage[] = [];
      const backendWrite1 = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'gemini-3.1-pro-high',
        agyHomeDir: tmpHome,
        usageHandoffFs: fsWriteInject,
        spawnFn: (() => procWrite1) as unknown as SpawnFn,
      });
      backendWrite1.onMessage((m) => emittedWrite.push(m));
      await backendWrite1.sendPrompt('/work', 'Turn A write-fail');

      // First `closeForHandoff()` MUST reject on ENOSPC while retaining ownership!
      await expect(backendWrite1.closeForHandoff()).rejects.toThrow(/ENOSPC/);

      // Clear ENOSPC -> retry `closeForHandoff()` persists 0o600 sidecar cleanly!
      failWriteOnce = false;
      await backendWrite1.closeForHandoff();
      const handoffPathWrite = join(
        tmpHome,
        'conversations',
        `${convWriteFail}.lmc-usage-handoff.json`,
      );
      expect(existsSync(handoffPathWrite)).toBe(true);
      expect(statSync(handoffPathWrite).mode & 0o777).toBe(0o600);

      // Now Row 1 finishes at 140/30 -> replacement backend emits +40/+10 correction once!
      dbWriteFail
        .prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 1')
        .run(settledRow1, settledRow1.byteLength);
      dbWriteFail.close();

      const procWrite2 = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/resume') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convWriteFail) });
        } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
      });
      const backendWrite2 = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'gemini-3.1-pro-high',
        conversationId: convWriteFail,
        agyHomeDir: tmpHome,
        spawnFn: (() => procWrite2) as unknown as SpawnFn,
      });
      backendWrite2.onMessage((m) => emittedWrite.push(m));
      await backendWrite2.sendPrompt('/work', 'Turn B after write recovery');
      await backendWrite2.dispose();

      const writeSteps = emittedWrite.filter(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
      );
      expect(writeSteps.reduce((s, m) => s + ((m.usage as any).input_tokens ?? 0), 0)).toBe(140);
      expect(writeSteps.reduce((s, m) => s + ((m.usage as any).output_tokens ?? 0), 0)).toBe(30);

      // Case B: Inject `renameSync` EACCES during `dispose()` -> rejects while retaining handlers & ledger;
      // retrying `dispose()` after EACCES clears writes sidecar; then test unreadable (EACCES) AND malformed
      // sidecars on replacement backend refusing to silently baseline over Row 1 until restored!
      const convRename = 'r8-handoff-rename-and-corrupt';
      const dbRename = openTestConversationDb(tmpHome, convRename);
      let failRenameOnce = true;
      const fsRenameInject: AgyUsageHandoffFs = {
        ...realFs,
        renameSync: (oldP, newP) => {
          if (failRenameOnce) {
            throw Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' });
          }
          realFs.renameSync(oldP, newP);
        },
      };

      const procRename1 = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convRename) });
        } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          dbRename.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 14)').run();
          dbRename
            .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)')
            .run(unfinishedRow1, unfinishedRow1.byteLength);
          p.send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
          });
        }
      });

      const emittedRename: AgentMessage[] = [];
      const backendRename1 = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'gemini-3.1-pro-high',
        agyHomeDir: tmpHome,
        usageHandoffFs: fsRenameInject,
        spawnFn: (() => procRename1) as unknown as SpawnFn,
      });
      backendRename1.onMessage((m) => emittedRename.push(m));
      await backendRename1.sendPrompt('/work', 'Turn A rename-fail');

      await expect(backendRename1.dispose()).rejects.toThrow(/EACCES/);
      failRenameOnce = false;
      await backendRename1.dispose();

      const handoffPathRename = join(
        tmpHome,
        'conversations',
        `${convRename}.lmc-usage-handoff.json`,
      );
      const validSidecarContent = readFileSync(handoffPathRename, 'utf8');
      expect(statSync(handoffPathRename).mode & 0o777).toBe(0o600);

      // Settle Row 1 in SQLite to 140/30:
      dbRename
        .prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 1')
        .run(settledRow1, settledRow1.byteLength);
      dbRename.close();

      let replacementPrompts = 0;
      const makeReplacementProc = () =>
        createMockAcpProcess((msg, p) => {
          if (msg.method === 'initialize') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
          } else if (msg.method === 'session/resume') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convRename) });
          } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
          } else if (msg.method === 'session/prompt') {
            replacementPrompts += 1;
            p.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          }
        });

      // 1) Unreadable sidecar (`EACCES`) MUST NOT fail open into historical seeding!
      let injectReadEacces = true;
      const fsReadInject: AgyUsageHandoffFs = {
        ...realFs,
        readFileSync: (p, enc) => {
          if (injectReadEacces) {
            throw Object.assign(new Error('EACCES: sidecar unreadable'), { code: 'EACCES' });
          }
          return realFs.readFileSync(p, enc);
        },
      };
      const backendCorruptSidecar = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'gemini-3.1-pro-high',
        conversationId: convRename,
        agyHomeDir: tmpHome,
        transientStreamRetryDelaysMs: [],
        usageHandoffFs: fsReadInject,
        spawnFn: (() => makeReplacementProc()) as unknown as SpawnFn,
      });
      backendCorruptSidecar.onMessage((m) => emittedRename.push(m));
      await expect(backendCorruptSidecar.sendPrompt('/work', 'Blocked by EACCES sidecar')).rejects.toThrow(
        /Refusing to seed or release Antigravity usage ledger:.*handoff sidecar/,
      );
      expect(replacementPrompts).toBe(0);

      // 2) Malformed JSON sidecar MUST ALSO refuse to silently baseline over Row 1!
      injectReadEacces = false;
      writeFileSync(handoffPathRename, '{malformed-handoff-json', { mode: 0o600 });
      await expect(backendCorruptSidecar.sendPrompt('/work', 'Blocked by malformed sidecar')).rejects.toThrow(
        /Refusing to seed or release Antigravity usage ledger:.*handoff sidecar/,
      );
      expect(replacementPrompts).toBe(0);

      // 3) Restore valid sidecar -> same replacement backend recovers, loads credit 100/20, and emits +40/+10 ONCE!
      writeFileSync(handoffPathRename, validSidecarContent, { mode: 0o600 });
      await backendCorruptSidecar.sendPrompt('/work', 'Recovers after sidecar restored');
      expect(replacementPrompts).toBe(1);
      await backendCorruptSidecar.dispose();
      expect(existsSync(handoffPathRename)).toBe(false);

      const renameSteps = emittedRename.filter(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
      );
      expect(renameSteps.reduce((s, m) => s + ((m.usage as any).input_tokens ?? 0), 0)).toBe(140);
      expect(renameSteps.reduce((s, m) => s + ((m.usage as any).output_tokens ?? 0), 0)).toBe(30);
      const correctionSteps = renameSteps.filter((m) => m.usageKey === `${convRename}:sql:1`);
      expect(correctionSteps).toHaveLength(1);
      expect(correctionSteps[0].usage).toEqual({
        input_tokens: 40,
        output_tokens: 10,
        cache_read_tokens: 0,
        total_tokens: 50,
      });
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('never classifies current-turn work as historical when initial pre-prompt SQLite seed reads fail and later recover (R8-P2-5)', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'agy-acp-r8-p2-5-'));
    try {
      // Scenario A (transient recovery before prompt write + optional prompt usage omitted):
      // Resume conversation with historical rows 0..4 (999/111 each); initial seed in `ensureSessionReady`
      // AND Attempt 1's `reconcilePrePromptUsage` both fail (`chmod 0o000`); Attempt 1 is blocked BEFORE
      // sending `session/prompt`; DB recovers during retry backoff -> Attempt 2 seeds `baselineMaxGenIdx = 4`,
      // dispatches `session/prompt`, writes owned Row 5 (`140/30`), and counts `140/30` once while excluding `0..4`!
      const convA = 'r8-seed-recover-no-prompt-usage';
      const dbInitA = openTestConversationDb(tmpHome, convA);
      for (let i = 0; i < 5; i++) {
        dbInitA
          .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, 10)')
          .run(i, buildGenMetadataBlob(999, 111, 0));
      }
      dbInitA.close();
      const dbPathA = join(tmpHome, 'conversations', `${convA}.db`);
      chmodSync(dbPathA, 0o000);
      // Unlock DB asynchronously during the 20ms transient pre-prompt retry window:
      setTimeout(() => {
        try {
          chmodSync(dbPathA, 0o600);
        } catch {
          // ignore if test already cleaned up
        }
      }, 8);

      let promptsDispatchedA = 0;
      const makeProcA = () =>
        createMockAcpProcess((msg, p) => {
          if (msg.method === 'initialize') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
          } else if (msg.method === 'session/resume') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convA) });
          } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
          } else if (msg.method === 'session/prompt') {
            promptsDispatchedA += 1;
            const db = openTestConversationDb(tmpHome, convA);
            const row5 = buildGenMetadataBlob(140, 30, 0, {
              modelDisplayName: 'Gemini 3.1 Pro (High)',
              stepIndices: [0],
            });
            db.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 14)').run();
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (5, ?, ?)').run(
              row5,
              row5.byteLength,
            );
            db.close();
            // Omit optional prompt usage completely so ONLY SQLite row 5 can bill the turn!
            p.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          }
        });

      const emittedA: AgentMessage[] = [];
      const backendA = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'gemini-3.1-pro-high',
        conversationId: convA,
        agyHomeDir: tmpHome,
        transientStreamRetryDelaysMs: [25],
        spawnFn: (() => makeProcA()) as unknown as SpawnFn,
      });
      backendA.onMessage((m) => emittedA.push(m));
      await backendA.sendPrompt('/work', 'Turn with initial failed seed then recovery');
      expect(promptsDispatchedA).toBe(1);

      const stepsA = emittedA.filter(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
      );
      expect(stepsA.reduce((s, m) => s + ((m.usage as any).input_tokens ?? 0), 0)).toBe(140);
      expect(stepsA.reduce((s, m) => s + ((m.usage as any).output_tokens ?? 0), 0)).toBe(30);
      await backendA.dispose();

      // Scenario B (persistent pre-prompt seed failure fails closed without dispatching `session/prompt`;
      // subsequent recovery + fallback `100/20` + SQLite `140/30` counts `100/20 + 40/10 = 140/30` once):
      const convB = 'r8-seed-recover-fallback-reconcile';
      const dbInitB = openTestConversationDb(tmpHome, convB);
      for (let i = 0; i < 5; i++) {
        dbInitB
          .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, 10)')
          .run(i, buildGenMetadataBlob(999, 111, 0));
      }
      dbInitB.close();
      const dbPathB = join(tmpHome, 'conversations', `${convB}.db`);
      chmodSync(dbPathB, 0o000);

      let promptsDispatchedB = 0;
      const makeProcB = () =>
        createMockAcpProcess((msg, p) => {
          if (msg.method === 'initialize') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
          } else if (msg.method === 'session/resume') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convB) });
          } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
          } else if (msg.method === 'session/prompt') {
            promptsDispatchedB += 1;
            const db = openTestConversationDb(tmpHome, convB);
            const unfinishedRow5 = Uint8Array.from([
              ...encodeLenField(2, [0]),
              ...encodeLenField(
                1,
                encodeLenField(21, Array.from(Buffer.from('Gemini 3.1 Pro (High)', 'utf8'))),
              ),
            ]);
            db.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 14)').run();
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (5, ?, ?)').run(
              unfinishedRow5,
              unfinishedRow5.byteLength,
            );
            db.close();
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
            });
          }
        });

      const emittedB: AgentMessage[] = [];
      const backendB = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'gemini-3.1-pro-high',
        conversationId: convB,
        agyHomeDir: tmpHome,
        transientStreamRetryDelaysMs: [5],
        spawnFn: (() => makeProcB()) as unknown as SpawnFn,
      });
      backendB.onMessage((m) => emittedB.push(m));

      await expect(backendB.sendPrompt('/work', 'Blocked while unseeded')).rejects.toThrow(
        /unseeded usage baseline/,
      );
      expect(promptsDispatchedB).toBe(0);

      chmodSync(dbPathB, 0o600);
      await backendB.sendPrompt('/work', 'Replay after DB readable');
      expect(promptsDispatchedB).toBe(1);

      const stepsAfterPromptB = emittedB.filter(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
      );
      expect(stepsAfterPromptB).toHaveLength(1);
      expect((stepsAfterPromptB[0].usage as any).input_tokens).toBe(100);
      expect((stepsAfterPromptB[0].usage as any).output_tokens).toBe(20);

      // Now Row 5 finishes at 140/30 before terminal disposal -> emits exact +40/+10 correction!
      const dbSettleB = openTestConversationDb(tmpHome, convB);
      const settledRow5 = buildGenMetadataBlob(140, 30, 0, {
        modelDisplayName: 'Gemini 3.1 Pro (High)',
        stepIndices: [0],
      });
      dbSettleB
        .prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 5')
        .run(settledRow5, settledRow5.byteLength);
      dbSettleB.close();

      await backendB.dispose();

      const stepsB = emittedB.filter(
        (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
      );
      expect(stepsB).toHaveLength(2);
      expect((stepsB[1].usage as any).input_tokens).toBe(40);
      expect((stepsB[1].usage as any).output_tokens).toBe(10);
      expect(stepsB.reduce((s, m) => s + ((m.usage as any).input_tokens ?? 0), 0)).toBe(140);
      expect(stepsB.reduce((s, m) => s + ((m.usage as any).output_tokens ?? 0), 0)).toBe(30);
    } finally {
      try {
        for (const c of ['r8-seed-recover-no-prompt-usage', 'r8-seed-recover-fallback-reconcile']) {
          const p = join(tmpHome, 'conversations', `${c}.db`);
          if (existsSync(p)) chmodSync(p, 0o600);
        }
      } catch {
        // ignore
      }
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('does not overwrite hydrated turn accounting when a transient sidecar read error clears before or during replacement setup (R9-P2-4)', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'agy-r9-p2-4-'));
    try {
      const realFs: AgyUsageHandoffFs = {
        statSync: (p) => statSync(p),
        mkdirSync: (p, o) => {
          mkdirSync(p, o);
        },
        readFileSync: (p, enc) => readFileSync(p, enc),
        openSync: (p, flags, mode) => openSync(p, flags, mode),
        writeFileSync: (fd, data, o) => writeFileSync(fd, data, o),
        fsyncSync: (fd) => fsyncSync(fd),
        closeSync: (fd) => closeSync(fd),
        chmodSync: (p, mode) => chmodSync(p, mode),
        renameSync: (o, n) => renameSync(o, n),
        unlinkSync: (p) => unlinkSync(p),
      };

      for (const clearDuringInitialize of [false, true]) {
        const convId = clearDuringInitialize ? 'r9-p2-4-mid-setup' : 'r9-p2-4-pre-prompt';
        const db = openTestConversationDb(tmpHome, convId);
        db.close();

        const unfinishedRow1 = Uint8Array.from([
          ...encodeLenField(2, [0]),
          ...encodeLenField(
            1,
            encodeLenField(21, Array.from(Buffer.from('Gemini 3.1 Pro (High)', 'utf8'))),
          ),
        ]);
        const settledRow1 = buildGenMetadataBlob(140, 30, 0, {
          modelDisplayName: 'Gemini 3.1 Pro (High)',
          stepIndices: [0],
        });
        const settledRow2 = buildGenMetadataBlob(200, 40, 0, {
          modelDisplayName: 'Gemini 3.1 Pro (High)',
          stepIndices: [1],
        });

        const allEmitted: AgentMessage[] = [];

        // 1. Backend A runs Turn 1: emits 100/20 fallback with unfinished Row 1 and persists sidecar on dispose:
        const procA = createMockAcpProcess((msg, p) => {
          if (msg.method === 'initialize') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
          } else if (msg.method === 'session/new') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convId) });
          } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
          } else if (msg.method === 'session/prompt') {
            const dbA = openTestConversationDb(tmpHome, convId);
            dbA.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 14)').run();
            dbA
              .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)')
              .run(unfinishedRow1, unfinishedRow1.byteLength);
            dbA.close();
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
            });
          }
        });
        const backendA = new AgyBackend({
          cwd: '/work',
          permissionMode: 'default',
          model: 'gemini-3.1-pro-high',
          agyHomeDir: tmpHome,
          spawnFn: (() => procA) as unknown as SpawnFn,
        });
        backendA.onMessage((m) => allEmitted.push(m));
        await backendA.sendPrompt('/work', 'Turn 1');
        await backendA.dispose();

        // 2. Backend B's constructor hits a transient sidecar read error (`nextTurnSeq = 0`, `nextProcessGen = 0`):
        let failSidecarRead = true;
        const fsB: AgyUsageHandoffFs = {
          ...realFs,
          readFileSync: (p, enc) => {
            if (failSidecarRead) {
              throw Object.assign(new Error('EIO: transient sidecar read failure'), { code: 'EIO' });
            }
            return realFs.readFileSync(p, enc);
          },
        };
        const procB = createMockAcpProcess((msg, p) => {
          if (msg.method === 'initialize') {
            if (clearDuringInitialize) {
              // Clear mid-setup AFTER Backend B already allocated `turn.turnSeq` and `proc.gen`!
              failSidecarRead = false;
            }
            p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
          } else if (msg.method === 'session/resume') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convId) });
          } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
          } else if (msg.method === 'session/prompt') {
            // During B's first prompt, A's Row 1 finishes at 140/30 AND B writes Row 2 at 200/40:
            const dbB = openTestConversationDb(tmpHome, convId);
            dbB
              .prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 1')
              .run(settledRow1, settledRow1.byteLength);
            dbB.prepare('INSERT INTO steps (idx, step_type) VALUES (1, 14)').run();
            dbB
              .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (2, ?, ?)')
              .run(settledRow2, settledRow2.byteLength);
            dbB.close();
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240 } },
            });
          }
        });

        const backendB = new AgyBackend({
          cwd: '/work',
          permissionMode: 'default',
          model: 'gemini-3.1-pro-high',
          conversationId: convId,
          agyHomeDir: tmpHome,
          usageHandoffFs: fsB,
          spawnFn: (() => procB) as unknown as SpawnFn,
        });
        backendB.onMessage((m) => allEmitted.push(m));

        if (!clearDuringInitialize) {
          // Exact R9-P2-4 counterexample: sidecar read error clears immediately before B's first `sendPrompt`!
          failSidecarRead = false;
        }

        await backendB.sendPrompt('/work', 'Turn 2');
        await backendB.dispose();

        const stepMsgs = allEmitted.filter(
          (m): m is Extract<AgentMessage, { type: 'token-count' }> => m.type === 'token-count' && m.scope === 'step',
        );
        // Must emit 100/20 (A fallback) + 40/10 (Row 1 correction) + 200/40 (Row 2) = 340 / 70, NOT 440 / 90!
        expect(stepMsgs.reduce((s, m) => s + ((m.usage as any).input_tokens ?? 0), 0)).toBe(340);
        expect(stepMsgs.reduce((s, m) => s + ((m.usage as any).output_tokens ?? 0), 0)).toBe(70);
      }
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('preserves runner ownership or transfers handoff to encrypted metadata when local sidecar persistence fails during runner cleanup (R9-P2-5)', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'agy-r9-p2-5-'));
    try {
      const realFs: AgyUsageHandoffFs = {
        statSync: (p) => statSync(p),
        mkdirSync: (p, o) => {
          mkdirSync(p, o);
        },
        readFileSync: (p, enc) => readFileSync(p, enc),
        openSync: (p, flags, mode) => openSync(p, flags, mode),
        writeFileSync: (fd, data, o) => writeFileSync(fd, data, o),
        fsyncSync: (fd) => fsyncSync(fd),
        closeSync: (fd) => closeSync(fd),
        chmodSync: (p, mode) => chmodSync(p, mode),
        renameSync: (o, n) => renameSync(o, n),
        unlinkSync: (p) => unlinkSync(p),
      };
      const unfinishedRow1 = Uint8Array.from([
        ...encodeLenField(2, [0]),
        ...encodeLenField(
          1,
          encodeLenField(21, Array.from(Buffer.from('Gemini 3.1 Pro (High)', 'utf8'))),
        ),
      ]);
      const settledRow1 = buildGenMetadataBlob(140, 30, 0, {
        modelDisplayName: 'Gemini 3.1 Pro (High)',
        stepIndices: [0],
      });

      // Subcase A: Local sidecar write/rename permanently fails, but encrypted session metadata
      // (`persistFallbackHandoff`) succeeds -> runner cleanup completes alternative durable transfer,
      // and replacement runner recovers +40/+10 correction from metadata!
      {
        const convMeta = 'r9-p2-5-metadata-transfer';
        const outboxPath = join(tmpHome, 'outbox-meta.json');
        const delivered: any[] = [];
        const outbox = new UsageOutbox(
          outboxPath,
          async (r) => {
            delivered.push(r);
            return true;
          },
          () => {},
        );
        const origin = { sessionId: 'sess-meta', machineId: 'mach-meta' };
        let metadataState = { path: '/work', host: 'h' } as unknown as Metadata;
        let sessionClosed = false;
        let sessionDied = false;
        const mockSession = {
          updateMetadata: async (updater: (m: Metadata) => Metadata) => {
            metadataState = updater(metadataState);
          },
          sendSessionDeath: () => {
            sessionDied = true;
          },
          flush: async () => {
            await outbox.flush();
          },
          close: async () => {
            await outbox.flush();
            sessionClosed = true;
          },
        };
        const persistFallbackHandoff = async (id: string, payload: string | null) => {
          await mockSession.updateMetadata((m) => {
            const next = { ...(m.agyUsageHandoffs ?? {}) };
            if (payload === null) delete next[id];
            else next[id] = payload;
            return { ...m, agyUsageHandoffs: Object.keys(next).length > 0 ? next : undefined };
          });
        };

        const fsAlwaysFailWrite: AgyUsageHandoffFs = {
          ...realFs,
          writeFileSync: () => {
            throw Object.assign(new Error('EROFS: local sidecar read-only'), { code: 'EROFS' });
          },
        };

        const proc1 = createMockAcpProcess((msg, p) => {
          if (msg.method === 'initialize') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
          } else if (msg.method === 'session/new') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convMeta) });
          } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
          } else if (msg.method === 'session/prompt') {
            const db = openTestConversationDb(tmpHome, convMeta);
            db.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 14)').run();
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)').run(
              unfinishedRow1,
              unfinishedRow1.byteLength,
            );
            db.close();
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
            });
          }
        });

        const backend1 = new AgyBackend({
          cwd: '/work',
          permissionMode: 'default',
          model: 'gemini-3.1-pro-high',
          agyHomeDir: tmpHome,
          usageHandoffFs: fsAlwaysFailWrite,
          confirmUsageDurable: () => outbox.ensureDurable(),
          loadFallbackHandoff: (id) => metadataState.agyUsageHandoffs?.[id] ?? null,
          persistFallbackHandoff,
          spawnFn: (() => proc1) as unknown as SpawnFn,
        });
        const onMsg1 = (msg: AgentMessage) => {
          if (msg.type === 'token-count' && msg.scope === 'step' && typeof msg.usageKey === 'string') {
            const key = msg.usageKey;
            const model = typeof msg.usageModel === 'string' ? msg.usageModel : null;
            const startedAt = typeof msg.usageStartedAt === 'number' ? msg.usageStartedAt : undefined;
            outbox.enqueue(() => agyUsageRecord(msg.usage as any, origin, key, model, startedAt));
          }
        };
        backend1.onMessage(onMsg1);
        await backend1.startSession();
        await backend1.sendPrompt('/work', 'Turn 1');

        await finalizeAgyRunnerShutdown({
          backend: backend1,
          onBackendMessage: onMsg1,
          getSession: () => mockSession,
          persistFallbackHandoff,
          archiveRequested: false,
          refreshHandoff: false,
        });
        expect(sessionDied).toBe(true);
        expect(sessionClosed).toBe(true);
        expect(typeof metadataState.agyUsageHandoffs?.[convMeta]).toBe('string');

        // Row 1 settles in SQLite -> replacement runner recovers from metadata on `startSession()`!
        const dbSettle = openTestConversationDb(tmpHome, convMeta);
        dbSettle
          .prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 1')
          .run(settledRow1, settledRow1.byteLength);
        dbSettle.close();

        const backend2 = new AgyBackend({
          cwd: '/work',
          permissionMode: 'default',
          model: 'gemini-3.1-pro-high',
          conversationId: convMeta,
          agyHomeDir: tmpHome,
          confirmUsageDurable: () => outbox.ensureDurable(),
          loadFallbackHandoff: (id) => metadataState.agyUsageHandoffs?.[id] ?? null,
          persistFallbackHandoff,
          spawnFn: (() => createMockAcpProcess()) as unknown as SpawnFn,
        });
        const onMsg2 = (msg: AgentMessage) => {
          if (msg.type === 'token-count' && msg.scope === 'step' && typeof msg.usageKey === 'string') {
            const key = msg.usageKey;
            const model = typeof msg.usageModel === 'string' ? msg.usageModel : null;
            const startedAt = typeof msg.usageStartedAt === 'number' ? msg.usageStartedAt : undefined;
            outbox.enqueue(() => agyUsageRecord(msg.usage as any, origin, key, model, startedAt));
          }
        };
        backend2.onMessage(onMsg2);
        await backend2.startSession();
        await outbox.flush();

        expect(delivered.reduce((s, r) => s + r.tokens.input, 0)).toBe(140);
        expect(delivered.reduce((s, r) => s + r.tokens.output, 0)).toBe(30);
        expect(metadataState.agyUsageHandoffs).toBeUndefined();
        await backend2.dispose();
      }

      // Subcase B: BOTH local sidecar write AND metadata transfer fail (offline socket) ->
      // `finalizeAgyRunnerShutdown` throws `AgyRunnerShutdownPersistenceError` while keeping
      // `onBackendMessage` attached and `session` open; `err.retryShutdown()` completes accounting & cleanup!
      {
        const convRetry = 'r9-p2-5-retryable-owner';
        const outboxPath = join(tmpHome, 'outbox-retry.json');
        const delivered: any[] = [];
        const outbox = new UsageOutbox(
          outboxPath,
          async (r) => {
            delivered.push(r);
            return true;
          },
          () => {},
        );
        const origin = { sessionId: 'sess-retry', machineId: 'mach-retry' };
        let failSidecarWrite = true;
        let failMetadataOffline = true;
        let sessionClosed = false;
        let sessionDied = false;
        const mockSession = {
          updateMetadata: async () => {
            if (failMetadataOffline) {
              throw new Error('Socket disconnected');
            }
          },
          sendSessionDeath: () => {
            sessionDied = true;
          },
          flush: async () => {
            await outbox.flush();
          },
          close: async () => {
            await outbox.flush();
            sessionClosed = true;
          },
        };
        const fsRetry: AgyUsageHandoffFs = {
          ...realFs,
          renameSync: (o, n) => {
            if (failSidecarWrite) {
              throw Object.assign(new Error('EACCES: sidecar rename blocked'), { code: 'EACCES' });
            }
            realFs.renameSync(o, n);
          },
        };

        const proc = createMockAcpProcess((msg, p) => {
          if (msg.method === 'initialize') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
          } else if (msg.method === 'session/new') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convRetry) });
          } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
            p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
          } else if (msg.method === 'session/prompt') {
            const db = openTestConversationDb(tmpHome, convRetry);
            db.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 14)').run();
            db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)').run(
              unfinishedRow1,
              unfinishedRow1.byteLength,
            );
            db.close();
            p.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
            });
          }
        });

        const backend = new AgyBackend({
          cwd: '/work',
          permissionMode: 'default',
          model: 'gemini-3.1-pro-high',
          agyHomeDir: tmpHome,
          usageHandoffFs: fsRetry,
          confirmUsageDurable: () => outbox.ensureDurable(),
          persistFallbackHandoff: async () => {
            await mockSession.updateMetadata();
          },
          spawnFn: (() => proc) as unknown as SpawnFn,
        });
        const onMsg = (msg: AgentMessage) => {
          if (msg.type === 'token-count' && msg.scope === 'step' && typeof msg.usageKey === 'string') {
            const key = msg.usageKey;
            const model = typeof msg.usageModel === 'string' ? msg.usageModel : null;
            const startedAt = typeof msg.usageStartedAt === 'number' ? msg.usageStartedAt : undefined;
            outbox.enqueue(() => agyUsageRecord(msg.usage as any, origin, key, model, startedAt));
          }
        };
        backend.onMessage(onMsg);
        await backend.startSession();
        await backend.sendPrompt('/work', 'Turn 1');

        let caughtErr: unknown = null;
        try {
          await finalizeAgyRunnerShutdown({
            backend,
            onBackendMessage: onMsg,
            getSession: () => mockSession,
            persistFallbackHandoff: async () => {
              await mockSession.updateMetadata();
            },
            archiveRequested: false,
            refreshHandoff: false,
          });
        } catch (err) {
          caughtErr = err;
        }
        expect(caughtErr).toBeInstanceOf(AgyRunnerShutdownPersistenceError);
        // Session MUST NOT be closed and `onBackendMessage` MUST still be attached!
        expect(sessionClosed).toBe(false);
        expect(sessionDied).toBe(false);

        // Now Row 1 settles in SQLite while `backend` + `onMsg` + `mockSession` are STILL LIVE,
        // and local sidecar rename recovers -> `retryShutdown()` emits +40/+10 through the still-attached
        // `onMsg` listener, confirms durability, and cleanly closes the session!
        const dbSettle = openTestConversationDb(tmpHome, convRetry);
        dbSettle
          .prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 1')
          .run(settledRow1, settledRow1.byteLength);
        dbSettle.close();
        failSidecarWrite = false;
        failMetadataOffline = false;

        await (caughtErr as AgyRunnerShutdownPersistenceError).retryShutdown();
        expect(sessionDied).toBe(true);
        expect(sessionClosed).toBe(true);
        expect(delivered.reduce((s, r) => s + r.tokens.input, 0)).toBe(140);
        expect(delivered.reduce((s, r) => s + r.tokens.output, 0)).toBe(30);
      }
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('retains recovery state when final close reconciliation hits offline socket + UsageOutbox write failure, then records exact single correction on recreation (R9-P2-6)', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'agy-r9-p2-6-'));
    try {
      const convId = 'r9-p2-6-durable-outbox';
      const outboxPath = join(tmpHome, 'usage-outbox.json');
      const origin = { sessionId: 'sess-r9-6', machineId: 'mach-r9-6' };

      const unfinishedRow1 = Uint8Array.from([
        ...encodeLenField(2, [0]),
        ...encodeLenField(
          1,
          encodeLenField(21, Array.from(Buffer.from('Gemini 3.1 Pro (High)', 'utf8'))),
        ),
      ]);
      const settledRow1 = buildGenMetadataBlob(140, 30, 0, {
        modelDisplayName: 'Gemini 3.1 Pro (High)',
        stepIndices: [0],
      });

      let socketOnline = false;
      let failOutboxWrite = false;
      const serverDelivered: any[] = [];

      const outbox1 = new UsageOutbox(
        outboxPath,
        async (record) => {
          if (!socketOnline) return false;
          serverDelivered.push(record);
          return true;
        },
        () => {},
        {
          writeAtomicFile: async (tmpPath, content) => {
            if (failOutboxWrite) {
              throw Object.assign(new Error('ENOSPC: UsageOutbox disk full'), { code: 'ENOSPC' });
            }
            const { writeFile } = await import('node:fs/promises');
            await writeFile(tmpPath, content, { mode: 0o600 });
          },
        },
      );

      const proc1 = createMockAcpProcess((msg, p) => {
        if (msg.method === 'initialize') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/new') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: sessionCatalogPayload(convId) });
        } else if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
          p.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          const db = openTestConversationDb(tmpHome, convId);
          db.prepare('INSERT INTO steps (idx, step_type) VALUES (0, 14)').run();
          db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)').run(
            unfinishedRow1,
            unfinishedRow1.byteLength,
          );
          db.close();
          p.send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
          });
        }
      });

      const backend1 = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'gemini-3.1-pro-high',
        agyHomeDir: tmpHome,
        confirmUsageDurable: () => outbox1.ensureDurable(),
        spawnFn: (() => proc1) as unknown as SpawnFn,
      });
      const onMsg1 = (msg: AgentMessage) => {
        if (msg.type === 'token-count' && msg.scope === 'step' && typeof msg.usageKey === 'string') {
          const key = msg.usageKey;
          const model = typeof msg.usageModel === 'string' ? msg.usageModel : null;
          const startedAt = typeof msg.usageStartedAt === 'number' ? msg.usageStartedAt : undefined;
          outbox1.enqueue(() => agyUsageRecord(msg.usage as any, origin, key, model, startedAt));
        }
      };
      backend1.onMessage(onMsg1);
      await backend1.startSession();
      // 1. Original 100/20 fallback is durably persisted to local UsageOutbox while socket is offline:
      await backend1.sendPrompt('/work', 'Turn 1');
      expect(JSON.parse(readFileSync(outboxPath, 'utf8')).pending).toHaveLength(1);

      // 2. Row 1 finishes at 140/30 right before shutdown, while socket is STILL offline
      //    AND UsageOutbox write/rename fails!
      const dbSettle = openTestConversationDb(tmpHome, convId);
      dbSettle
        .prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 1')
        .run(settledRow1, settledRow1.byteLength);
      dbSettle.close();
      failOutboxWrite = true;

      await finalizeAgyRunnerShutdown({
        backend: backend1,
        onBackendMessage: onMsg1,
        getSession: () => ({
          updateMetadata: async () => {},
          sendSessionDeath: () => {},
          flush: () => outbox1.flush(),
          close: () => outbox1.flush(),
        }),
        archiveRequested: false,
        refreshHandoff: false,
      });

      // UsageOutbox on disk STILL only has the 100/20 fallback (outbox write failed for 40/10!),
      // AND therefore the backend MUST NOT have discarded its handoff sidecar!
      expect(JSON.parse(readFileSync(outboxPath, 'utf8')).pending).toHaveLength(1);
      const handoffPath = join(tmpHome, 'conversations', `${convId}.lmc-usage-handoff.json`);
      expect(existsSync(handoffPath)).toBe(true);
      const savedHandoff = JSON.parse(readFileSync(handoffPath, 'utf8'));
      expect(savedHandoff.pendingDurableEmissions).toHaveLength(1);
      expect(savedHandoff.pendingDurableEmissions[0].usageKey).toBe(`${convId}:sql:1`);

      // 3. Recreate runner + UsageOutbox once outbox disk recovers, then bring socket online:
      //    Must reconstruct and deliver EXACTLY ONE 40/10 correction (`100/20 + 40/10 = 140/30`)!
      failOutboxWrite = false;
      const outbox2 = new UsageOutbox(
        outboxPath,
        async (record) => {
          if (!socketOnline) return false;
          serverDelivered.push(record);
          return true;
        },
        () => {},
      );
      const backend2 = new AgyBackend({
        cwd: '/work',
        permissionMode: 'default',
        model: 'gemini-3.1-pro-high',
        conversationId: convId,
        agyHomeDir: tmpHome,
        confirmUsageDurable: () => outbox2.ensureDurable(),
        spawnFn: (() => createMockAcpProcess()) as unknown as SpawnFn,
      });
      backend2.onMessage((msg) => {
        if (msg.type === 'token-count' && msg.scope === 'step' && typeof msg.usageKey === 'string') {
          const key = msg.usageKey;
          const model = typeof msg.usageModel === 'string' ? msg.usageModel : null;
          const startedAt = typeof msg.usageStartedAt === 'number' ? msg.usageStartedAt : undefined;
          outbox2.enqueue(() => agyUsageRecord(msg.usage as any, origin, key, model, startedAt));
        }
      });

      await backend2.startSession();
      // Handoff sidecar is now cleaned up ONLY AFTER `outbox2.ensureDurable()` confirmed persistence!
      expect(existsSync(handoffPath)).toBe(false);
      const persistedPending = JSON.parse(readFileSync(outboxPath, 'utf8')).pending;
      expect(persistedPending).toHaveLength(2);

      socketOnline = true;
      await outbox2.flush();
      const expectedCorrectionKey = agyUsageRecord(
        { input_tokens: 40, output_tokens: 10, cache_read_tokens: 0, total_tokens: 50 },
        origin,
        `${convId}:sql:1`,
        'gemini-3.1-pro-high',
      )!.key;
      expect(serverDelivered).toHaveLength(2);
      expect(serverDelivered.filter((r) => r.key === expectedCorrectionKey)).toHaveLength(1);
      expect(serverDelivered.reduce((s, r) => s + r.tokens.input, 0)).toBe(140);
      expect(serverDelivered.reduce((s, r) => s + r.tokens.output, 0)).toBe(30);
      await backend2.dispose();
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

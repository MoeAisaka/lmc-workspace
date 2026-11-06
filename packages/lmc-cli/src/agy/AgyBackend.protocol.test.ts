import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AgyBackend, type SpawnFn } from './AgyBackend';
import type { AgentMessage } from '@/agent/core/AgentBackend';

function fixture() {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn(() => true) });
  const calls: string[][] = [];
  const spawnFn = ((_bin: string, args: string[]) => { calls.push(args); return child; }) as unknown as SpawnFn;
  const backend = new AgyBackend({ cwd: '/work', permissionMode: 'default', spawnFn });
  const messages: AgentMessage[] = [];
  backend.onMessage(m => messages.push(m));
  const line = (value: unknown) => stdout.emit('data', JSON.stringify(value) + '\n');
  const init = (id: string) => line({ event: 'init', conversation_id: id, init: { cwd: '/work', tools: [], permission_mode: 'request-review' } });
  const result = (id: string, response = 'Hello world', status = 'SUCCESS', error?: string) => line({ event: 'result', result: { conversation_id: id, status, response, ...(error ? { error } : {}), duration_seconds: 1, num_turns: 1, usage: { input_tokens: 100, output_tokens: 2, cache_read_tokens: 80, thinking_tokens: 0, total_tokens: 102 } } });
  return { backend, child, stdout, stderr, messages, calls, line, init, result };
}

describe('Antigravity structured protocol', () => {
  it('records each completed generation once, never treats cumulative result as a new generation', async () => {
    const f=fixture(); const turn=f.backend.sendPrompt('/work','two'); f.init('mine');
    const step={event:'step_update',step_update:{conversation_id:'mine',step_index:4,step_type:'agent_response',state:'DONE',usage:{input_tokens:278,output_tokens:4,cache_read_tokens:30214,total_tokens:282}}};
    f.line(step);f.line(step);f.result('mine');f.child.emit('close',0);await turn;
    expect(f.messages.filter(m=>m.type==='token-count'&&m.scope==='step')).toEqual([expect.objectContaining({usageKey:'mine:4',usage:step.step_update.usage})]);
  });
  it('renders split NDJSON as text and does not duplicate the final response', async () => {
    const f = fixture();
    const turn = f.backend.sendPrompt('/work', 'hello');
    f.init('mine');
    const record = JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'mine', step_index: 1, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Hello ' } });
    f.stdout.emit('data', record.slice(0, 23)); f.stdout.emit('data', record.slice(23) + '\n');
    expect(f.messages.filter(m => m.type === 'event' && m.name === 'output-complete')).toHaveLength(0);
    f.line({ event: 'step_update', step_update: { conversation_id: 'mine', step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'world' } });
    // Flushes completed step text immediately before process exit (so background schedule waits never hide completed text).
    expect(f.messages.filter(m => m.type === 'event' && m.name === 'output-complete')).toHaveLength(1);
    f.result('mine'); f.child.emit('close', 0); await turn;
    expect(f.messages.filter(m => m.type === 'model-output').map(m => m.textDelta).join('')).toBe('Hello world');
    expect(f.calls[0]).toContain('stream-json');
  });

  it('resumes only the conversation id emitted by this process', async () => {
    const f = fixture();
    const first = f.backend.sendPrompt('/work', 'one'); f.init('mine'); f.result('mine', 'one'); f.child.emit('close', 0); await first;
    const second = f.backend.sendPrompt('/work', 'two'); f.init('mine'); f.result('mine', 'two'); f.child.emit('close', 0); await second;
    const i = f.calls[1].indexOf('--conversation');
    expect(f.calls[1][i + 1]).toBe('mine');
  });

  it('rejects a structured error even if the process exits zero', async () => {
    const f = fixture();
    const turn = f.backend.sendPrompt('/work', 'hello'); const observed = expect(turn).rejects.toThrow(/Antigravity|agy/i);
    f.init('mine'); f.result('mine', '', 'ERROR'); f.child.emit('close', 0); await observed;
    expect(f.messages.at(-1)).toMatchObject({ type: 'status', status: 'error' });
  });

  it('does not report a truncated stream as a completed turn', async () => {
    const f = fixture();
    const turn = f.backend.sendPrompt('/work', 'hello'); const observed = expect(turn).rejects.toThrow();
    f.init('mine'); f.child.emit('close', 0); await observed;
  });

  it('renders a tool step once when DONE arrives without ACTIVE', async () => {
    const f = fixture(); const turn = f.backend.sendPrompt('/work', 'hello'); f.init('mine');
    const tool = { event: 'step_update', step_update: { conversation_id: 'mine', step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hello' }, output: 'hello' } } };
    f.line(tool); f.line(tool); f.result('mine'); f.child.emit('close', 0); await turn;
    expect(f.messages.filter(m => m.type === 'tool-call')).toHaveLength(1);
    expect(f.messages.filter(m => m.type === 'tool-result')).toHaveLength(1);
  });

  it('ignores stale historical result.status=ERROR when the turn completed with a response, clean stderr, and exit 0', async () => {
    const f = fixture();
    const turn = f.backend.sendPrompt('/work', 'check status');
    f.init('mine');
    f.line({ event: 'step_update', step_update: { conversation_id: 'mine', step_index: 10, step_type: 'agent_response', state: 'DONE', text_delta: 'All four cards aligned.' } });
    f.stderr.emit('data', 'root agent idle; waiting up to 30s for 1 background task(s)\n');
    f.result('mine', 'All four cards aligned.', 'ERROR', 'earlier turn failed hours ago');
    f.child.emit('close', 0);
    await turn;
    expect(f.messages.filter(m => m.type === 'model-output').map(m => m.textDelta).join('')).toBe('All four cards aligned.');
    expect(f.messages.filter(m => m.type === 'status' && m.status === 'error')).toHaveLength(0);
    expect(f.messages.at(-1)).toMatchObject({ type: 'status', status: 'idle' });
  });

  it('still fails when partial output is followed by a real current-turn failure', async () => {
    const f = fixture();
    const turn = f.backend.sendPrompt('/work', 'hello');
    const observed = expect(turn).rejects.toThrow(/stream disconnected mid-turn/);
    f.init('mine');
    f.line({ event: 'step_update', step_update: { conversation_id: 'mine', step_index: 3, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Partial ' } });
    f.stderr.emit('data', 'AGY_ERROR: stream disconnected mid-turn\n');
    f.result('mine', 'Partial ', 'ERROR', 'stale historical error');
    f.child.emit('close', 1);
    await observed;
    expect(f.messages.at(-1)).toMatchObject({ type: 'status', status: 'error', detail: expect.stringContaining('stream disconnected mid-turn') });
  });

  it('redacts URLs and credentials from native error details', async () => {
    const f = fixture();
    const turn = f.backend.sendPrompt('/work', 'hello');
    const observed = expect(turn).rejects.toThrow(/Antigravity/);
    f.init('mine');
    f.stderr.emit('data', 'AGY_ERROR: sign in at https://accounts.google.com/o/oauth2/v2/auth?code=secret123&state=xyz token ya29.a0AfH6SMBxSecretToken\n');
    f.result('mine', '', 'ERROR');
    f.child.emit('close', 1);
    await observed;
    const errStatus = f.messages.find(m => m.type === 'status' && m.status === 'error');
    expect(errStatus).toBeDefined();
    const detail = errStatus && errStatus.type === 'status' ? errStatus.detail ?? '' : '';
    expect(detail).toContain('[url]');
    expect(detail).toContain('[redacted]');
    expect(detail).not.toContain('accounts.google.com');
    expect(detail).not.toContain('secret123');
    expect(detail).not.toContain('ya29.');
  });
});

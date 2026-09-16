import { expect, it, vi } from 'vitest';
import { SessionRefreshQueue } from './sessionRefresh';
it('defers while busy, coalesces edits and only drains when no messages are queued', async () => {
    const q = new SessionRefreshQueue(); const apply = vi.fn(async () => {});
    q.request({ contextWindow: 1000 }, 'fast'); q.request({ contextWindow: 2000 }, 'default');
    expect(await q.drain(true, 0, apply)).toBe(false);
    expect(await q.drain(false, 1, apply)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(await q.drain(false, 0, apply)).toBe(true);
    expect(apply).toHaveBeenCalledWith({ contextLimits: { contextWindow: 2000 }, serviceTier: 'default' });
});
it('invalid edits leave the pending request intact and failed refresh remains retryable', async () => {
    const q = new SessionRefreshQueue();q.request({}, 'fast');
    expect(()=>q.request({contextWindow:10,autoCompactTokenLimit:20},'fast')).toThrow();
    await expect(q.drain(false,0,async()=>{throw new Error('daemon unavailable')})).rejects.toThrow();
    const apply=vi.fn(async()=>{});await q.drain(false,0,apply);expect(apply).toHaveBeenCalledWith({contextLimits:{},serviceTier:'fast'});
});

it('retains an edit submitted while the previous config is applying', async () => {
 const q = new SessionRefreshQueue();q.request({},'fast');
 await q.drain(false,0,async()=>{q.request({contextWindow:2000},'default');});
 expect(q.hasPending).toBe(true);
 const apply=vi.fn(async()=>{});await q.drain(false,0,apply);
 expect(apply).toHaveBeenCalledWith({contextLimits:{contextWindow:2000},serviceTier:'default'});
 expect(q.hasPending).toBe(false);
});

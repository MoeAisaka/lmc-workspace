import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiEphemeralActivityUpdate } from '../apiTypes';
import { ActivityUpdateAccumulator } from './activityUpdateAccumulator';

describe('ActivityUpdateAccumulator Smart Debounce', () => {
    let mockFlushHandler: ReturnType<typeof vi.fn>;
    let accumulator: ActivityUpdateAccumulator;

    beforeEach(() => {
        vi.useFakeTimers();
        mockFlushHandler = vi.fn();
        accumulator = new ActivityUpdateAccumulator(mockFlushHandler, 500);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('immediate emission for significant state changes', () => {
        it('should emit immediately when thinking state changes from false to true', () => {
            const update1: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1000,
                thinking: false
            };

            const update2: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1100,
                thinking: true
            };

            accumulator.addUpdate(update1);
            expect(mockFlushHandler).toHaveBeenCalledTimes(1);
            expect(mockFlushHandler).toHaveBeenNthCalledWith(1, 
                new Map([['session1', update1]])
            );

            accumulator.addUpdate(update2);
            expect(mockFlushHandler).toHaveBeenCalledTimes(2);
            expect(mockFlushHandler).toHaveBeenNthCalledWith(2, 
                new Map([['session1', update2]])
            );
        });

        it('should settle before emitting when thinking state changes from true to false', () => {
            const update1: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1000,
                thinking: true
            };

            const update2: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1100,
                thinking: false
            };

            accumulator.addUpdate(update1);
            accumulator.addUpdate(update2);

            // The stop is held back — nothing has contradicted it yet, but a
            // second writer still mid-turn would within the settle window.
            expect(mockFlushHandler).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(2500);

            expect(mockFlushHandler).toHaveBeenCalledTimes(2);
            expect(mockFlushHandler).toHaveBeenNthCalledWith(2, 
                new Map([['session1', update2]])
            );
        });

        it('should emit immediately when active state changes', () => {
            const update1: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1000,
                thinking: false
            };

            const update2: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: false,
                activeAt: 1100,
                thinking: false
            };

            accumulator.addUpdate(update1);
            accumulator.addUpdate(update2);

            expect(mockFlushHandler).toHaveBeenCalledTimes(2);
            expect(mockFlushHandler).toHaveBeenNthCalledWith(2, 
                new Map([['session1', update2]])
            );
        });

        it('should emit immediately for first update to new session', () => {
            const update: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1000,
                thinking: false
            };

            accumulator.addUpdate(update);

            expect(mockFlushHandler).toHaveBeenCalledTimes(1);
            expect(mockFlushHandler).toHaveBeenCalledWith(
                new Map([['session1', update]])
            );
        });
    });

    describe('debounced emission for timestamp-only changes', () => {
        it('should debounce when only activeAt timestamp changes', () => {
            const update1: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1000,
                thinking: false
            };

            const update2: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1100,
                thinking: false
            };

            const update3: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1200,
                thinking: false
            };

            // First update is immediate (new session)
            accumulator.addUpdate(update1);
            expect(mockFlushHandler).toHaveBeenCalledTimes(1);

            // Subsequent updates should be debounced
            accumulator.addUpdate(update2);
            accumulator.addUpdate(update3);
            expect(mockFlushHandler).toHaveBeenCalledTimes(1);

            // Fast forward time to trigger debounce
            vi.advanceTimersByTime(500);
            expect(mockFlushHandler).toHaveBeenCalledTimes(2);
            expect(mockFlushHandler).toHaveBeenNthCalledWith(2, 
                new Map([['session1', update3]]) // Should have the latest update
            );
        });

        it('should accumulate multiple sessions with timestamp changes', () => {
            const session1Update1: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1000,
                thinking: false
            };

            const session2Update1: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session2',
                active: true,
                activeAt: 1000,
                thinking: false
            };

            const session1Update2: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1100,
                thinking: false
            };

            const session2Update2: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session2',
                active: true,
                activeAt: 1100,
                thinking: false
            };

            // First updates are immediate (new sessions)
            accumulator.addUpdate(session1Update1);
            accumulator.addUpdate(session2Update1);
            expect(mockFlushHandler).toHaveBeenCalledTimes(2);

            // Subsequent updates should be debounced
            accumulator.addUpdate(session1Update2);
            accumulator.addUpdate(session2Update2);
            expect(mockFlushHandler).toHaveBeenCalledTimes(2);

            // Fast forward time to trigger debounce
            vi.advanceTimersByTime(500);
            expect(mockFlushHandler).toHaveBeenCalledTimes(3);
            
            // Should batch both sessions in one call
            const lastCall = mockFlushHandler.mock.calls[2][0] as Map<string, ApiEphemeralActivityUpdate>;
            expect(lastCall.size).toBe(2);
            expect(lastCall.get('session1')).toEqual(session1Update2);
            expect(lastCall.get('session2')).toEqual(session2Update2);
        });

        it('should flush regularly arriving updates without indefinite delay', () => {
            // This test verifies the fix for the timer reset bug
            const update1: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1000,
                thinking: false
            };

            const update2: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 2000, // +1 second
                thinking: false
            };

            const update3: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 3000, // +1 second
                thinking: false
            };

            // First update is immediate (new session)
            accumulator.addUpdate(update1);
            expect(mockFlushHandler).toHaveBeenCalledTimes(1);

            // Second update should start the debounce timer
            accumulator.addUpdate(update2);
            expect(mockFlushHandler).toHaveBeenCalledTimes(1); // Still 1, pending

            // Third update should NOT reset the timer (this was the bug)
            accumulator.addUpdate(update3);
            expect(mockFlushHandler).toHaveBeenCalledTimes(1); // Still 1, pending

            // Fast forward 500ms - should flush the latest update
            vi.advanceTimersByTime(500);
            expect(mockFlushHandler).toHaveBeenCalledTimes(2);
            expect(mockFlushHandler).toHaveBeenNthCalledWith(2, 
                new Map([['session1', update3]]) // Should have the latest update
            );
        });
    });

    describe('mixed scenarios', () => {
        it('should flush pending updates when significant change occurs', () => {
            const update1: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1000,
                thinking: false
            };

            const update2: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1100,
                thinking: false
            };

            const update3: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1200,
                thinking: true // Significant change
            };

            // First update is immediate
            accumulator.addUpdate(update1);
            expect(mockFlushHandler).toHaveBeenCalledTimes(1);

            // Second update is debounced
            accumulator.addUpdate(update2);
            expect(mockFlushHandler).toHaveBeenCalledTimes(1);

            // Third update should flush pending updates together with the immediate update
            accumulator.addUpdate(update3);
            expect(mockFlushHandler).toHaveBeenCalledTimes(2);

            // Should have batched update2 and update3 together in the second call
            expect(mockFlushHandler).toHaveBeenNthCalledWith(2, 
                new Map([['session1', update3]]) // update3 overwrites update2 since same session
            );
        });

        it('should batch pending updates from multiple sessions when significant change occurs', () => {
            // Set up initial states for two sessions
            const session1Initial: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1000,
                thinking: false
            };

            const session2Initial: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session2',
                active: true,
                activeAt: 1000,
                thinking: false
            };

            // First updates are immediate (new sessions)
            accumulator.addUpdate(session1Initial);
            accumulator.addUpdate(session2Initial);
            expect(mockFlushHandler).toHaveBeenCalledTimes(2);

            // Add debounced updates for both sessions
            const session1Debounced: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1100,
                thinking: false
            };

            const session2Debounced: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session2',
                active: true,
                activeAt: 1100,
                thinking: false
            };

            accumulator.addUpdate(session1Debounced);
            accumulator.addUpdate(session2Debounced);
            expect(mockFlushHandler).toHaveBeenCalledTimes(2); // Still 2, these are pending

            // Add a significant change for session1
            const session1Significant: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1200,
                thinking: true // Significant change
            };

            accumulator.addUpdate(session1Significant);
            expect(mockFlushHandler).toHaveBeenCalledTimes(3);

            // Should have batched all pending updates with the significant change
            const lastCall = mockFlushHandler.mock.calls[2][0] as Map<string, ApiEphemeralActivityUpdate>;
            expect(lastCall.size).toBe(2); // Both sessions
            expect(lastCall.get('session1')).toEqual(session1Significant);
            expect(lastCall.get('session2')).toEqual(session2Debounced);
        });

        it('should not flip the session on rapid state toggles', () => {
            const updates: ApiEphemeralActivityUpdate[] = [
                { type: 'activity', id: 'session1', active: true, activeAt: 1000, thinking: false },
                { type: 'activity', id: 'session1', active: true, activeAt: 1100, thinking: true },
                { type: 'activity', id: 'session1', active: true, activeAt: 1200, thinking: false },
                { type: 'activity', id: 'session1', active: true, activeAt: 1300, thinking: true },
                { type: 'activity', id: 'session1', active: true, activeAt: 1400, thinking: false },
            ];

            updates.forEach(update => accumulator.addUpdate(update));

            // Only the first update and the start of work reach the app: each
            // stop is cancelled by the next start, so the session never flips
            // back to idle mid-toggle.
            expect(mockFlushHandler).toHaveBeenCalledTimes(2);
            expect(mockFlushHandler).toHaveBeenNthCalledWith(1,
                new Map([['session1', updates[0]]])
            );
            expect(mockFlushHandler).toHaveBeenNthCalledWith(2,
                new Map([['session1', updates[1]]])
            );

            // Once the toggling stops, the last stop settles through.
            vi.advanceTimersByTime(2500);
            expect(mockFlushHandler).toHaveBeenCalledTimes(3);
            expect(mockFlushHandler).toHaveBeenNthCalledWith(3,
                new Map([['session1', updates[4]]])
            );
        });
    });

    describe('competing writers', () => {
        // Two CLI processes bound to one session, each pushing its own thinking
        // flag on a 2s keepAlive. This is what the daemon's duplicate resume
        // produced, and what made the chat flicker at heartbeat rate.
        const heartbeat = (activeAt: number, thinking: boolean): ApiEphemeralActivityUpdate => ({
            type: 'activity', id: 'session1', active: true, activeAt, thinking
        });

        it('keeps the session working while any writer is still working', () => {
            accumulator.addUpdate(heartbeat(1000, true));
            expect(mockFlushHandler).toHaveBeenCalledTimes(1);

            // Writer A finishes; writer B keeps working for another 10s. Their
            // heartbeats interleave 1s apart.
            for (let t = 0; t < 10_000; t += 1000) {
                accumulator.addUpdate(heartbeat(2000 + t, false));   // A: idle
                vi.advanceTimersByTime(1000);
                accumulator.addUpdate(heartbeat(2500 + t, true));    // B: working
                vi.advanceTimersByTime(1000);
            }

            // Not one flip to idle in ten seconds of contention.
            const idleFlushes = mockFlushHandler.mock.calls.filter((call) => {
                const updates = call[0] as Map<string, ApiEphemeralActivityUpdate>;
                return updates.get('session1')?.thinking === false;
            });
            expect(idleFlushes).toHaveLength(0);

            // B finishes too — now the stop settles through.
            accumulator.addUpdate(heartbeat(13_000, false));
            vi.advanceTimersByTime(2500);
            const last = mockFlushHandler.mock.calls.at(-1)![0] as Map<string, ApiEphemeralActivityUpdate>;
            expect(last.get('session1')?.thinking).toBe(false);
        });

        it('drops an out-of-order heartbeat', () => {
            accumulator.addUpdate(heartbeat(5000, true));
            expect(mockFlushHandler).toHaveBeenCalledTimes(1);

            // A heartbeat from before the one already applied says nothing new.
            accumulator.addUpdate(heartbeat(4000, false));
            vi.advanceTimersByTime(5000);
            expect(mockFlushHandler).toHaveBeenCalledTimes(1);
        });

        it('still applies a disconnect stamped with an older timestamp', () => {
            accumulator.addUpdate(heartbeat(5000, true));
            expect(mockFlushHandler).toHaveBeenCalledTimes(1);

            // The server announces a disconnect with the session's LAST active
            // time (presence/timeout.ts), which is older than what we hold.
            const disconnect: ApiEphemeralActivityUpdate = {
                type: 'activity', id: 'session1', active: false, activeAt: 4000, thinking: false
            };
            accumulator.addUpdate(disconnect);

            expect(mockFlushHandler).toHaveBeenCalledTimes(2);
            expect(mockFlushHandler).toHaveBeenNthCalledWith(2,
                new Map([['session1', disconnect]])
            );
        });
    });

    describe('control methods', () => {
        it('should cancel pending updates', () => {
            const update1: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1000,
                thinking: false
            };

            const update2: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1100,
                thinking: false
            };

            accumulator.addUpdate(update1);
            accumulator.addUpdate(update2); // This should be pending
            
            expect(mockFlushHandler).toHaveBeenCalledTimes(1);

            accumulator.cancel();

            // Advance time - should not trigger flush
            vi.advanceTimersByTime(500);
            expect(mockFlushHandler).toHaveBeenCalledTimes(1);
        });

        it('should flush pending updates immediately', () => {
            const update1: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1000,
                thinking: false
            };

            const update2: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1100,
                thinking: false
            };

            accumulator.addUpdate(update1);
            accumulator.addUpdate(update2); // This should be pending
            
            expect(mockFlushHandler).toHaveBeenCalledTimes(1);

            accumulator.flush();

            // Should have flushed immediately
            expect(mockFlushHandler).toHaveBeenCalledTimes(2);
            expect(mockFlushHandler).toHaveBeenNthCalledWith(2, 
                new Map([['session1', update2]])
            );
        });

        it('should reset all state', () => {
            const update1: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1000,
                thinking: false
            };

            const update2: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1100,
                thinking: false
            };

            accumulator.addUpdate(update1);
            accumulator.addUpdate(update2);
            
            accumulator.reset();

            // After reset, next update should be treated as new session (immediate)
            const update3: ApiEphemeralActivityUpdate = {
                type: 'activity',
                id: 'session1',
                active: true,
                activeAt: 1200,
                thinking: false
            };

            accumulator.addUpdate(update3);
            expect(mockFlushHandler).toHaveBeenNthCalledWith(2, 
                new Map([['session1', update3]])
            );
        });
    });
});

describe('independent session stop deadlines', () => {
    it('does not flush a pending stop when another session starts', () => {
        vi.useFakeTimers();
        try {
            const flush = vi.fn();
            const accumulator = new ActivityUpdateAccumulator(flush, 500);
            const activity = (id: string, thinking: boolean, activeAt: number): ApiEphemeralActivityUpdate => ({ type: 'activity', id, active: true, thinking, activeAt });
            accumulator.addUpdate(activity('a', true, 1000));
            accumulator.addUpdate(activity('a', false, 1100));
            flush.mockClear();
            accumulator.addUpdate(activity('b', true, 1200));
            expect(flush.mock.calls.flatMap(([batch]) => [...batch.keys()])).toEqual(['b']);
            accumulator.addUpdate(activity('a', true, 1300));
            vi.advanceTimersByTime(3000);
            expect(flush.mock.calls.flatMap(([batch]) => [...batch.values()]).some(update => !update.thinking)).toBe(false);
        } finally { vi.useRealTimers(); }
    });
});

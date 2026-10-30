import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockAuthAndSetupMachineIfNeeded: vi.fn(),
  mockEnsureDaemonRunning: vi.fn(),
  mockInspectAgyCli: vi.fn(),
  mockRunAgy: vi.fn(),
}));

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: mocks.mockAuthAndSetupMachineIfNeeded,
}));

vi.mock('@/daemon/ensureDaemonRunning', () => ({
  ensureDaemonRunning: mocks.mockEnsureDaemonRunning,
}));

vi.mock('@/agy/preflight', () => ({
  inspectAgyCli: mocks.mockInspectAgyCli,
}));

vi.mock('@/agy/runAgy', () => ({
  runAgy: mocks.mockRunAgy,
}));

import { handleAgyCommand } from './agyCommand';

describe('handleAgyCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockAuthAndSetupMachineIfNeeded.mockResolvedValue({
      credentials: { token: 'token' },
    });
    mocks.mockEnsureDaemonRunning.mockResolvedValue(undefined);
    mocks.mockRunAgy.mockResolvedValue('stopped');
  });

  it('forwards parsed CLI flags to runAgy after ensuring daemon is running', async () => {
    await handleAgyCommand([
      '--started-by', 'daemon',
      '--model', 'gemini-4-argon-high',
      '--effort', 'high',
      '--permission-mode', 'bypassPermissions',
      '--resume', 'conv-123',
      '--verbose',
    ]);

    expect(mocks.mockEnsureDaemonRunning).toHaveBeenCalledTimes(1);
    expect(mocks.mockRunAgy).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: 'daemon',
      verbose: true,
      model: 'gemini-4-argon-high',
      effort: 'high',
      permissionMode: 'bypassPermissions',
      resume: 'conv-123',
    });
  });

  it.each(['refresh-handoff', 'killed'] as const)('forces process exit(0) after %s so old PID never blocks respawn', async (outcome) => {
    mocks.mockRunAgy.mockResolvedValue(outcome);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process exited');
    }) as never);
    try {
      await expect(handleAgyCommand([])).rejects.toThrow('process exited');
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
    }
  });
});

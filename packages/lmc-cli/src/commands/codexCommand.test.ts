import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockAuthAndSetupMachineIfNeeded: vi.fn(),
  mockRunCodex: vi.fn(),
  mockExtractCodexResumeFlag: vi.fn(),
  mockExtractNoSandboxFlag: vi.fn(),
  mockEnsureDaemonRunning: vi.fn(),
}))

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: mocks.mockAuthAndSetupMachineIfNeeded,
}))

vi.mock('@/codex/runCodex', () => ({
  runCodex: mocks.mockRunCodex,
}))

vi.mock('@/codex/cliArgs', () => ({
  extractCodexResumeFlag: mocks.mockExtractCodexResumeFlag,
}))

vi.mock('@/utils/sandboxFlags', () => ({
  extractNoSandboxFlag: mocks.mockExtractNoSandboxFlag,
}))

vi.mock('@/daemon/ensureDaemonRunning', () => ({
  ensureDaemonRunning: mocks.mockEnsureDaemonRunning,
}))

import { handleCodexCommand } from './codexCommand'

describe('handleCodexCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockAuthAndSetupMachineIfNeeded.mockResolvedValue({
      credentials: { token: 'token' },
    })
    mocks.mockExtractNoSandboxFlag.mockImplementation((args: string[]) => ({
      noSandbox: false,
      args,
    }))
    mocks.mockExtractCodexResumeFlag.mockImplementation((args: string[]) => ({
      resumeThreadId: null,
      args,
    }))
    mocks.mockEnsureDaemonRunning.mockResolvedValue(undefined)
    mocks.mockRunCodex.mockResolvedValue(undefined)
  })

  it.each(['fast', 'default'])('passes the selected service tier %s', async (tier) => {
    await handleCodexCommand(['--service-tier', tier])
    expect(mocks.mockRunCodex).toHaveBeenCalledWith(expect.objectContaining({ codexServiceTier: tier }))
  })
  it.each([['--service-tier'], ['--service-tier', '2x'], ['--service-tier', 'fast', '--service-tier', 'default']])('rejects invalid service tier before auth: %s', async (...args) => {
    await expect(handleCodexCommand(args)).rejects.toThrow()
    expect(mocks.mockAuthAndSetupMachineIfNeeded).not.toHaveBeenCalled()
  })

  it('passes exact context settings to runCodex', async () => {
    await handleCodexCommand(['--context-window', '1000000', '--auto-compact-token-limit', '800000'])
    expect(mocks.mockRunCodex).toHaveBeenCalledWith(expect.objectContaining({ codexContextLimits: { contextWindow: 1000000, autoCompactTokenLimit: 800000 } }))
  })

  it.each([
    ['--context-window'], ['--context-window', '0'], ['--context-window', '-5'],
    ['--context-window', '1.5'], ['--context-window', 'NaN'],
    ['--context-window', '100', '--context-window', '200'],
    ['--context-window', '100', '--auto-compact-token-limit', '100'],
  ])('rejects invalid context flags before auth or daemon work: %s', async (...args) => {
    await expect(handleCodexCommand(args)).rejects.toThrow()
    expect(mocks.mockAuthAndSetupMachineIfNeeded).not.toHaveBeenCalled()
    expect(mocks.mockRunCodex).not.toHaveBeenCalled()
  })

  it('ensures the daemon is running before starting a codex session', async () => {
    await handleCodexCommand(['--started-by', 'terminal'])

    expect(mocks.mockEnsureDaemonRunning).toHaveBeenCalledTimes(1)
    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: 'terminal',
      noSandbox: false,
      resumeThreadId: undefined,
      permissionMode: undefined,
      model: undefined,
      effort: undefined,
    })
    expect(
      mocks.mockEnsureDaemonRunning.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.mockRunCodex.mock.invocationCallOrder[0])
  })

  it('forces the CLI process to exit after a refresh handoff', async () => {
    mocks.mockRunCodex.mockResolvedValue('refresh-handoff')
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process exited')
    }) as never)
    try {
      await expect(handleCodexCommand([])).rejects.toThrow('process exited')
      expect(exit).toHaveBeenCalledWith(0)
    } finally {
      exit.mockRestore()
    }
  })

  it('passes parsed no-sandbox and resume flags through to runCodex', async () => {
    mocks.mockExtractNoSandboxFlag.mockReturnValue({
      noSandbox: true,
      args: ['--resume', 'thread-123', '--started-by', 'daemon'],
    })
    mocks.mockExtractCodexResumeFlag.mockReturnValue({
      resumeThreadId: 'thread-123',
      args: ['--started-by', 'daemon'],
    })

    await handleCodexCommand(['--no-sandbox', '--resume', 'thread-123', '--started-by', 'daemon'])

    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: 'daemon',
      noSandbox: true,
      resumeThreadId: 'thread-123',
      permissionMode: undefined,
      model: undefined,
      effort: undefined,
    })
  })

  it('passes permission-mode through to runCodex', async () => {
    await handleCodexCommand(['--permission-mode', 'yolo'])

    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: undefined,
      noSandbox: false,
      resumeThreadId: undefined,
      permissionMode: 'yolo',
      model: undefined,
      effort: undefined,
    })
  })

  it('maps --yolo to codex yolo permission mode', async () => {
    await handleCodexCommand(['--yolo'])

    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: undefined,
      noSandbox: false,
      resumeThreadId: undefined,
      permissionMode: 'yolo',
      model: undefined,
      effort: undefined,
    })
  })

  it('passes model and effort through to runCodex', async () => {
    await handleCodexCommand(['--model', 'gpt-5.4', '--effort', 'xhigh'])

    expect(mocks.mockRunCodex).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: undefined,
      noSandbox: false,
      resumeThreadId: undefined,
      permissionMode: undefined,
      model: 'gpt-5.4',
      effort: 'xhigh',
    })
  })
})

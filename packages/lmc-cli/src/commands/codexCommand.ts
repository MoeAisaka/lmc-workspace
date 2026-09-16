import { validateCodexServiceTier, type CodexServiceTier } from '@/codex/serviceTier'
import { validateCodexContextLimits, type CodexContextLimits } from '@/codex/contextLimits'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { runCodex } from '@/codex/runCodex'
import { extractCodexResumeFlag } from '@/codex/cliArgs'
import { extractNoSandboxFlag } from '@/utils/sandboxFlags'
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning'
import type { PermissionMode } from '@/api/types'
import type { ReasoningEffort } from '@/codex/codexAppServerTypes'

export async function handleCodexCommand(args: string[]): Promise<void> {
  let startedBy: 'daemon' | 'terminal' | undefined = undefined
  let permissionMode: PermissionMode | undefined = undefined
  let model: string | undefined = undefined
  let effort: ReasoningEffort | undefined = undefined
  let codexServiceTier: CodexServiceTier | undefined
  const codexContextLimits: CodexContextLimits = {}
  const sandboxArgs = extractNoSandboxFlag(args)
  const codexArgs = extractCodexResumeFlag(sandboxArgs.args)

  for (let i = 0; i < codexArgs.args.length; i++) {
    if (codexArgs.args[i] === '--started-by') {
      startedBy = codexArgs.args[++i] as 'daemon' | 'terminal'
    } else if (codexArgs.args[i] === '--permission-mode') {
      permissionMode = codexArgs.args[++i] as PermissionMode
    } else if (codexArgs.args[i] === '--model') {
      model = codexArgs.args[++i]
    } else if (codexArgs.args[i] === '--effort') {
      effort = codexArgs.args[++i] as ReasoningEffort
    } else if (codexArgs.args[i] === '--service-tier') {
      const raw = codexArgs.args[++i]
      if (raw === undefined || codexServiceTier !== undefined) throw new Error('Missing or duplicate service tier')
      codexServiceTier = validateCodexServiceTier(raw)
    } else if (codexArgs.args[i] === '--context-window' || codexArgs.args[i] === '--auto-compact-token-limit') {
      const key = codexArgs.args[i] === '--context-window' ? 'contextWindow' : 'autoCompactTokenLimit'
      const raw = codexArgs.args[++i]
      if (!raw || !/^[0-9]+$/.test(raw) || codexContextLimits[key] !== undefined) throw new Error(`Invalid or duplicate ${key}`)
      codexContextLimits[key] = Number(raw)
    } else if (codexArgs.args[i] === '--yolo') {
      permissionMode = 'yolo'
    }
  }

  validateCodexContextLimits(codexContextLimits)
  const { credentials } = await authAndSetupMachineIfNeeded()
  await ensureDaemonRunning()

  const result = await runCodex({
    credentials,
    startedBy,
    noSandbox: sandboxArgs.noSandbox,
    resumeThreadId: codexArgs.resumeThreadId ?? undefined,
    permissionMode,
    model,
    effort,
    ...(codexServiceTier === undefined ? {} : { codexServiceTier }),
    ...(Object.keys(codexContextLimits).length ? { codexContextLimits } : {}),
  })
  // A refresh replacement cannot start until this exact PID is gone. Normal
  // Node handle draining is insufficient because provider grandchildren can
  // briefly retain inherited stdio handles after cleanup has completed.
  if (result === 'refresh-handoff') process.exit(0)
}

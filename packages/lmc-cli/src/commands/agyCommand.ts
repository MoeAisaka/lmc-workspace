import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning';
import { inspectAgyCli } from '@/agy/preflight';
import { runAgy } from '@/agy/runAgy';

export async function handleAgyCommand(args: string[]): Promise<void> {
  if (args[0] === '--check') {
    const result = inspectAgyCli();
    console.log(JSON.stringify(result, null, 2));
    if (!result.readyForSignIn) process.exitCode = 1;
    return;
  }

  let startedBy: 'daemon' | 'terminal' | undefined = undefined;
  let verbose = false;
  let model: string | undefined;
  let effort: string | undefined;
  let permissionMode: string | undefined;
  let resume: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--started-by') {
      startedBy = args[++i] as 'daemon' | 'terminal';
    } else if (args[i] === '--model') {
      model = args[++i];
    } else if (args[i] === '--effort') {
      effort = args[++i];
    } else if (args[i] === '--permission-mode') {
      permissionMode = args[++i];
    } else if (args[i] === '--resume') {
      resume = args[++i];
    } else if (args[i] === '--verbose') {
      verbose = true;
    }
  }

  const { credentials } = await authAndSetupMachineIfNeeded();
  await ensureDaemonRunning();

  const result = await runAgy({
    credentials,
    startedBy,
    verbose,
    model,
    effort,
    permissionMode,
    resume,
  });

  // A refresh replacement cannot start until this exact PID is gone. Normal
  // Node handle draining is insufficient when HTTPS keep-alive pools or
  // sidecar sockets briefly retain handles after cleanup has completed.
  if (result === 'refresh-handoff' || result === 'killed') process.exit(0);
}

import { codexServiceTierArgs } from '@/codex/serviceTier';
import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';
import { codexContextLimitArgs } from '@/codex/contextLimits';
import { assertCodexModelEffort } from '@/codex/modelEffort';

export function shouldForwardDaemonPermissionMode(
  agent: string,
  permissionMode: string | undefined,
): permissionMode is string {
  if (!permissionMode) return false;

  // Claude's "default" means no harness override. Codex's "default" is a
  // concrete ask-first execution policy and differs from its ambient "auto".
  return permissionMode !== 'default' || agent === 'codex';
}

export function appendDaemonSpawnModeArgs(
  args: string[],
  options: SpawnSessionOptions,
  agent: string,
): void {
  if (agent !== 'claude' && agent !== 'codex') return;
  if (agent === 'codex') assertCodexModelEffort(options.modelMode, options.effortLevel);

  const tierArgs = agent === 'codex' ? codexServiceTierArgs(options.codexServiceTier) : [];
  const contextArgs = agent === 'codex' ? codexContextLimitArgs(options.codexContextLimits) : [];

  if (shouldForwardDaemonPermissionMode(agent, options.permissionMode)) {
    args.push('--permission-mode', options.permissionMode);
  }
  if (options.modelMode && options.modelMode !== 'default') {
    args.push('--model', options.modelMode);
  }
  if (options.effortLevel) {
    args.push('--effort', options.effortLevel);
  }
  args.push(...contextArgs, ...tierArgs);
}

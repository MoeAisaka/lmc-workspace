import { ModelCatalogsSchema, type ModelCatalogs } from 'lmc-wire';
import type { CodexServiceTier } from '@/codex/serviceTier';
import type { CodexContextLimits } from '@/codex/contextLimits';
import { z } from 'zod'
import type { Update, UpdateMachineBody } from 'lmc-wire';
import { UsageSchema } from '@/claude/types'
import type { SandboxConfig } from '@/persistence'

export {
  SessionMessageContentSchema,
  SessionMessageSchema,
  UpdateBodySchema,
  UpdateMachineBodySchema,
  UpdateSchema,
  UpdateSessionBodySchema,
} from 'lmc-wire';
export type {
  SessionMessage,
  SessionMessageContent,
  Update,
  UpdateBody,
  UpdateMachineBody,
  UpdateSessionBody,
} from 'lmc-wire';

/**
 * Permission mode type - includes both Claude and Codex modes
 * The wire schema (MessageMetaSchema.permissionMode) deliberately accepts any
 * string; each harness narrows to this union itself and ignores the rest.
 *
 * Shared: auto — the harness reviews each call itself
 * Claude modes: default, acceptEdits, bypassPermissions, plan
 * Codex modes: read-only, safe-yolo, yolo
 *
 * `auto` is the one mode both harnesses implement natively: Claude ships it
 * in the Agent SDK's own PermissionMode union, and Codex spells it as the
 * `on-request` approval policy inside the workspace sandbox.
 *
 * When calling Claude SDK, Codex modes are mapped at the SDK boundary:
 * - yolo → bypassPermissions
 * - safe-yolo → default
 * - read-only → default
 */
export type PermissionMode = 'auto' | 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo'

/**
 * Usage data type from Claude
 */
export type Usage = z.infer<typeof UsageSchema>

/**
 * Socket events from server to client
 */
export interface ServerToClientEvents {
  update: (data: Update) => void
  'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void
  'rpc-registered': (data: { method: string }) => void
  'rpc-unregistered': (data: { method: string }) => void
  'rpc-error': (data: { type: string, error: string }) => void
  ephemeral: (data: { type: 'activity', id: string, active: boolean, activeAt: number, thinking: boolean }) => void
  auth: (data: { success: boolean, user: string }) => void
  error: (data: { message: string }) => void
}


/**
 * Socket events from client to server
 */
export interface ClientToServerEvents {
  message: (data: { sid: string, message: any }) => void
  'session-alive': (data: {
    sid: string;
    time: number;
    thinking: boolean;
    mode?: 'local' | 'remote';
  }) => void
  'session-end': (data: { sid: string, time: number }) => void,
  'update-metadata': (data: { sid: string, expectedVersion: number, metadata: string }, cb: (answer: {
    result: 'error'
  } | {
    result: 'version-mismatch'
    version: number,
    metadata: string
  } | {
    result: 'success',
    version: number,
    metadata: string
  }) => void) => void,
  'update-state': (data: { sid: string, expectedVersion: number, agentState: string | null }, cb: (answer: {
    result: 'error'
  } | {
    result: 'version-mismatch'
    version: number,
    agentState: string | null
  } | {
    result: 'success',
    version: number,
    agentState: string | null
  }) => void) => void,
  'ping': (callback: () => void) => void
  'rpc-register': (data: { method: string }) => void
  'rpc-unregister': (data: { method: string }) => void
  'rpc-call': (data: { method: string, params: string }, callback: (response: {
    ok: boolean
    result?: string
    error?: string
  }) => void) => void
  'usage-report': (data: {
    key: string
    sessionId: string
    tokens: {
      total: number
      [key: string]: number
    }
    cost: {
      total: number
      [key: string]: number
    }
  }) => void
}

/**
 * Session information
 */
export type Session = {
  id: string,
  seq: number,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: Metadata,
  metadataVersion: number,
  agentState: AgentState | null,
  agentStateVersion: number,
}

/**
 * Machine metadata - static information (rarely changes)
 */
export const MachineMetadataSchema = z.object({
    modelDiscovery: z.boolean().optional(),
    modelCatalogs: ModelCatalogsSchema.optional().catch(undefined),
    managedUpgrades: z.boolean().optional(),
  codexServiceTier: z.boolean().optional(),
  codexContextLimits: z.boolean().optional(),
  host: z.string(),
  platform: z.string(),
  // Renaming happy -> lmc on the wire is staged: readers accept both first,
  // writers send both second, the old names go last. Both are declared because
  // this schema has no passthrough — an undeclared key is stripped silently,
  // so the new spelling would never reach the app.
  happyCliVersion: z.string(),
  lmcCliVersion: z.string().optional(),
  homeDir: z.string(),
  happyHomeDir: z.string(),
  lmcHomeDir: z.string().optional(),
  happyLibDir: z.string(),
  cliAvailability: z.object({
    claude: z.boolean(),
    codex: z.boolean(),
    gemini: z.boolean(),
    openclaw: z.boolean(),
    // Optional so metadata written by a CLI predating agy detection still
    // matches this shape. detectCLIAvailability always reports it.
    agy: z.boolean().optional(),
    detectedAt: z.number(),
  }).optional(),
  resumeSupport: z.object({
    rpcAvailable: z.boolean(),
    requiresSameMachine: z.boolean(),
    requiresHappyAgentAuth: z.boolean(),
    happyAgentAuthenticated: z.boolean(),
    detectedAt: z.number(),
  }).optional(),
})

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>

/**
 * Daemon state - dynamic runtime information (frequently updated)
 */
export const DaemonStateSchema = z.object({
  status: z.union([
    z.enum(['running', 'shutting-down']),
    z.string() // Forward compatibility
  ]),
  pid: z.number().optional(),
  httpPort: z.number().optional(),
  startedAt: z.number().optional(),
  shutdownRequestedAt: z.number().optional(),
  shutdownSource:
    z.union([
      z.enum(['mobile-app', 'cli', 'os-signal', 'unknown']),
      z.string() // Forward compatibility
    ]).optional()
})

export type DaemonState = z.infer<typeof DaemonStateSchema>

export type Machine = {
  id: string,
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: MachineMetadata,
  metadataVersion: number,
  daemonState: DaemonState | null,
  daemonStateVersion: number,
}

/**
 * Message metadata schema
 */
export const MessageMetaSchema = z.object({
  sentFrom: z.string().optional(), // Source identifier
  // Any string is accepted so a newer app can name a mode this CLI does not
  // know yet without the whole message failing safeParse and being dropped.
  // Each harness validates the value itself and falls back with a warning.
  permissionMode: z.string().optional(), // Permission mode for this message
  model: z.string().nullable().optional(), // Model name for this message (null = reset)
  fallbackModel: z.string().nullable().optional(), // Fallback model for this message (null = reset)
  customSystemPrompt: z.string().nullable().optional(), // Custom system prompt for this message (null = reset)
  appendSystemPrompt: z.string().nullable().optional(), // Append to system prompt for this message (null = reset)
  allowedTools: z.array(z.string()).nullable().optional(), // Allowed tools for this message (null = reset)
  disallowedTools: z.array(z.string()).nullable().optional(), // Disallowed tools for this message (null = reset)
  effort: z.string().nullable().optional(), // Effort level for this message (null = reset). happy-app sends this key; without it Zod strips the value before runClaude reads it.
  // What to do with a message that arrives while the engine is busy. Absent
  // from older apps, which keep the pre-intent behaviour.
  intent: z.enum(['queue', 'steer', 'interrupt']).optional(),
})

export type MessageMeta = z.infer<typeof MessageMetaSchema>

/**
 * API response types
 */
export const CreateSessionResponseSchema = z.object({
  session: z.object({
    id: z.string(),
    tag: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    metadata: z.string(),
    metadataVersion: z.number(),
    agentState: z.string().nullable(),
    agentStateVersion: z.number()
  })
})

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.object({
    type: z.literal('text'),
    text: z.string()
  }),
  localKey: z.string().optional(), // Mobile messages include this
  meta: MessageMetaSchema.optional()
})

export type UserMessage = z.infer<typeof UserMessageSchema>

/**
 * File event message — sent by the app as a session envelope before the text message.
 * Contains a ref pointing to the encrypted blob on the server.
 */
export const FileEventMessageSchema = z.object({
  role: z.literal('session'),
  content: z.object({
    type: z.literal('session'),
    data: z.object({
      id: z.string(),
      time: z.number(),
      role: z.literal('user'),
      ev: z.object({
        t: z.literal('file'),
        ref: z.string(),
        name: z.string(),
        size: z.number(),
        mimeType: z.string().optional(),
        image: z.object({
          width: z.number(),
          height: z.number(),
          // Optional — native iOS picker has no Canvas to compute thumbhash.
          // App-side schema relaxed this in the same commit; keeping CLI in
          // sync so the file event isn't silently rejected by Zod and the
          // attachment never reaches Claude.
          thumbhash: z.string().optional(),
        }).optional(),
      }),
    }),
  }),
})

export type FileEventMessage = z.infer<typeof FileEventMessageSchema>

export const AgentMessageSchema = z.object({
  role: z.literal('agent'),
  content: z.object({
    type: z.literal('output'),
    data: z.any()
  }),
  meta: MessageMetaSchema.optional()
})

export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const MessageContentSchema = z.union([UserMessageSchema, AgentMessageSchema])

export type MessageContent = z.infer<typeof MessageContentSchema>

/**
 * One side of a hub-and-workers binding. `by` records whether the hub spawned
 * the worker or a person bound it. A worker's duty is not a field here: the
 * hub decides it and writes it into the worker's title (「【编码】…」), where
 * both the list and the hub itself read it. One place, no second truth.
 */
export type OrchestrationBinding = { sessionId: string, boundAt: number, by: 'auto' | 'manual', autonomy?: boolean };
/**
 * One task as the board records it. Maintained by the runner from the
 * envelopes it sends and receives, so every device reads the same board
 * without loading anyone's messages. `counterpart` is the worker from a hub's
 * board and the hub from a worker's.
 */
export type BoardEntry = {
  dispatchId?: string,
  id: string,
  title: string,
  stage?: string,
  /** The task's scope field as dispatched, for review_report to check the diff against. */
  scope?: string,
  /** Why a blocked task is blocked, when the runner can tell: the engine ran out of quota. */
  reason?: 'quota',
  /** What the last report said the task cost, as the worker's runner metered it. */
  cost?: string,
  /** The reporting worker's model and effort, when known. */
  model?: string,
  /** The branch review_report checked and the commit it stood at when the task was accepted; the next task on that branch is diffed from here. */
  branch?: string,
  sha?: string,
  state: 'dispatched' | 'done' | 'blocked' | 'failed' | 'accepted' | 'rejected',
  attempt: number,
  counterpart: string | null,
  firstAt: number,
  updatedAt: number,
};
/**
 * A hub's request for a worker on a machine it cannot reach itself. A runner
 * holds no account key, so it can neither call another machine's daemon nor
 * bind the result; it writes the request here and an app on the account
 * carries it out, then records the outcome on the same row. Same-machine
 * spawns go straight to the local daemon and never appear here.
 */
export type SpawnRequest = {
  id: string,
  /** Machine id, or the machine name as shown in list_sessions. */
  machine: string,
  directory: string,
  agent: 'claude' | 'codex',
  model?: string,
  effort?: string,
  permissionMode?: string,
  /** Full title for the worker, duty prefix included: 【编码】… */
  title: string,
  requestedAt: number,
  state: 'pending' | 'claimed' | 'done' | 'failed',
  claimedAt?: number,
  sessionId?: string,
  error?: string,
};
export type Orchestration =
  | { role: 'hub', workers: OrchestrationBinding[], board?: BoardEntry[], spawnRequests?: SpawnRequest[] }
  | { role: 'worker', hub: OrchestrationBinding, board?: BoardEntry[] };

export type Metadata = {
  /** Agent-to-agent mail; on unless this is explicitly false. */
  agentMail?: boolean;
  /** Permission / model / effort picks, mirrored for every device's model panel (#1492); the runner records what it was started with. */
  permissionMode?: string | null;
  /** Launch inheritance versus an explicit picker/hub choice; never inferred from its spelling. */
  permissionModeSource?: 'ambient' | 'explicit';
  modelMode?: string | null;
  effortLevel?: string | null;
  agentBuild?: string;
  engineRuntime?: {engine:string;version:string;packageVersion?:string;source:string;path:string};
  sessionCapabilities?: { modelDiscovery?: boolean; refresh: boolean; authentication: boolean; runtimeConfiguration: boolean; resourceFiles?: boolean; resourceSearch?: boolean; fileInbox?: boolean; resume?:boolean;model?:boolean;effort?:boolean;context?:boolean;serviceTier?:boolean;
    /** The runner answers `cancel-session-refresh` while a refresh or switch is still queued. */
    cancelRefresh?: boolean;
    /** The runner publishes agentState.queue and answers dequeue / promote; messages may carry meta.intent. */
    turnQueue?: boolean };
  engineAuth?: { status: 'ready' | 'required' | 'unknown'; checkedAt: number };
  sessionConfiguration?: boolean;
  sessionConfigState?: 'queued' | 'applied' | 'error' | 'refreshing' | 'verifying';
  // How queued prompts are consumed: joined into one turn (default) or one per turn.
  queueMode?: 'batch' | 'sequential';
  sessionConfigUpdatedAt?: number;
  sessionConfigError?: string;
  /** Set while a queued refresh is checking the engine it will relaunch as; cleared after. */
  sessionConfigStage?: 'preflight';
  /**
   * Which step of a refresh `sessionConfigError` belongs to. `auth` is the
   * login check failing in the one way the person can fix themselves; the rest
   * name the step so a client can draw the failure where it happened.
   */
  sessionConfigErrorKind?: 'auth' | 'preflight' | 'relaunch' | 'verify';
  /** When the refresh was asked for — set as it enters `queued`, kept until it ends, so its duration can be measured on any device. */
  sessionConfigRequestedAt?: number;

  codexServiceTier?: CodexServiceTier; codexContextLimits?: CodexContextLimits,
  /**
   * ACP session config option value (normalized for UI metadata consumers).
   */
  // `code` = protocol value ID, `value` = human label
  modelCatalogs?: ModelCatalogs,
  models?: Array<{ code: string; value: string; description?: string | null }>,
  currentModelCode?: string,
  operatingModes?: Array<{ code: string; value: string; description?: string | null }>,
  currentOperatingModeCode?: string,
  thoughtLevels?: Array<{ code: string; value: string; description?: string | null }>,
  currentThoughtLevelCode?: string,
  path: string,
  host: string,
  version?: string,
  name?: string,
  os?: string,
  summary?: {
    text: string,
    updatedAt: number
  },
  machineId?: string,
  gitBranch?: string,
  claudeSessionId?: string, // Claude Code session ID
  codexThreadId?: string, // Codex app-server thread ID
  /**
   * A briefing waiting to be handed to the engine taking this session over.
   *
   * It travels in metadata because it has to survive the process boundary: the
   * engine that wrote it exits, and the one that reads it has not started yet.
   * The runner that consumes it clears it, so it is present only across a
   * switch.
   */
  pendingHandoff?: {
    /** The engine that left it, for the briefing's own byline. */
    from: string,
    /** Its engine key, for deciding how to render what came before the switch. */
    fromFlavor?: 'claude' | 'codex',
    /** Whether the engine wrote it or it was assembled from the transcript. */
    source: 'engine' | 'compiled',
    briefing: string,
    /**
     * The engine-native conversation this session is leaving.
     *
     * Recorded here rather than left in claudeSessionId/codexThreadId, which
     * are cleared on a switch: those are what a relaunch resumes, and keeping
     * one would invite a later change to resume it and bring back the forked
     * memory the design rules out. Here it is a reference, not a pointer the
     * machinery can follow — the next engine can read the file with its own
     * tools when the briefing is not enough.
     */
    priorThread?: { engine: string, id: string, transcriptPath?: string },
  },
  /**
   * Every engine-native conversation this session has had, oldest first — one
   * per stretch between switches. References, never pointers a relaunch
   * follows: the LMC transcript is the one record of this session, and an
   * engine's own earlier thread is a stale copy of part of it. The briefing
   * lists them so the next engine can read its own earlier work as history
   * rather than inherit it as memory.
   */
  engineThreadHistory?: Array<{ engine: string, flavor: 'claude' | 'codex', id: string, transcriptPath?: string, endedAt: number }>,
  /**
   * This session's place in a hub-and-workers arrangement, if any. A hub plans
   * and reviews; its workers execute. Written on both sides so either can be
   * rebuilt from the other, and keyed by LMC session id, which survives every
   * refresh and engine switch — the relationship belongs to the session, not
   * to the process running it.
   */
  orchestration?: Orchestration,
  /** Dispatch limits, independent of the bounded display board. Never evict silently. */
  delegationLedger?: Record<string, { worker: string; attempt: number; deadline: number; budgetMinutes: number; dispatch: string; state: BoardEntry['state'] }>,
  tools?: string[],
  slashCommands?: string[],
  mcpServers?: Array<{ name: string; status: string }>,
  skills?: string[],
  homeDir: string,
  happyHomeDir: string,
  /** Same value as happyHomeDir, under the name readers will settle on. */
  lmcHomeDir?: string,
  happyLibDir: string,
  happyToolsDir: string,
  startedFromDaemon?: boolean,
  hostPid?: number,
  sessionStateRevision?: string,
  startedBy?: 'daemon' | 'terminal',
  // Lifecycle state management
  lifecycleState?: 'running' | 'archiveRequested' | 'archived' | string,
  lifecycleStateSince?: number,
  archivedBy?: string,
  archiveReason?: string,
  flavor?: string
  sandbox?: SandboxConfig | null
  dangerouslySkipPermissions?: boolean | null
  /** Lineage for sessions created via the fork / duplicate flow. */
  parentSessionId?: string
  forkedFromMessageId?: string
  /**
   * Marks a session as a hidden "side chat" forked from `parentSessionId`.
   * Side chats never appear in the top-level session list; they render only
   * inside the parent session's sidebar panel.
   */
  isSideChat?: boolean
};

export type UsageLimitWindowStatus = 'allowed' | 'allowed_warning' | 'rejected'

export type UsageLimitWindow = {
  /** Stable machine key, e.g. 'five_hour' / 'seven_day'. */
  id: string,
  label?: string,
  status?: UsageLimitWindowStatus,
  /** Percent of the window used, 0-100. */
  utilization?: number | null,
  /** Epoch milliseconds when the window resets. */
  resetsAt?: number | null,
}

export type UsageLimits = {
  capturedAt: number,
  windows: UsageLimitWindow[],
}

export type AgentGoalStatus = {
  source: 'claude' | 'codex',
  observedAt: number,
  sourceSessionId?: string,
  sourceRevision?: string | number,
} & (
  | {
      status: 'unavailable',
      reason?: 'unsupported' | 'not_loaded' | 'stale' | 'malformed' | 'error' | 'unknown',
    }
  | {
      status: 'inactive',
      reason?: 'none' | 'cleared' | 'completed' | 'unknown',
    }
  | {
      status: 'active',
      sourceSessionId: string,
      text: string,
      capabilities?: {
        clear?: boolean,
        stop?: boolean,
        edit?: boolean,
      },
      progress?: {
        currentStep?: number,
        totalSteps?: number,
        steps?: Array<{
          text: string,
          status: 'pending' | 'in_progress' | 'completed',
        }>,
      },
    }
);

export type AgentState = {
  runtime?: {phase:'working'|'idle';pid:number;updatedAt:number};
  controlledByUser?: boolean | null | undefined
  /**
   * Ephemeral plan rate-limit windows reported by the agent backend.
   * Apps must tolerate window ids they don't recognize.
   */
  usageLimits?: UsageLimits
  requests?: {
    [id: string]: {
      tool: string,
      arguments: any,
      createdAt: number,
      // Raw provider tool-use id when the request id is scoped (e.g. claude
      // subagent ids are `agentID:toolUseID`); the app joins the permission
      // card to its tool call through this.
      toolUseId?: string
    }
  }
  completedRequests?: {
    [id: string]: {
      tool: string,
      arguments: any,
      createdAt: number,
      completedAt: number,
      status: 'canceled' | 'denied' | 'approved',
      reason?: string,
      mode?: PermissionMode,
      decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
      // Historical field name from the RPC payload; the app reads
      // `allowedTools`. Both are written until every app build folds the
      // old key.
      allowTools?: string[],
      allowedTools?: string[],
      toolUseId?: string
    }
  }
  agentGoalStatus?: AgentGoalStatus
  // Prompts waiting for the engine, in order. Keys echo the app's localKey
  // when it sent one. Absent on CLIs that predate the queue strip.
  queue?: Array<{ key: string; preview: string; createdAt: number }>
}

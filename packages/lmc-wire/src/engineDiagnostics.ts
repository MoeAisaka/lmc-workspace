import { z } from 'zod';

/** Sanitized observations only: no window titles, arguments or private paths. */
export const SystemPromptDiagnosticSchema = z.object({
    status: z.enum(['detected', 'none', 'unknown', 'unsupported']),
    checkedAt: z.number(),
    owners: z.array(z.enum(['UserNotificationCenter', 'SecurityAgent', 'CoreServicesUIAgent'])).optional(),
    windowCount: z.number().int().nonnegative().optional(),
    reason: z.enum(['timeout', 'failed', 'malformed']).optional(),
});
export type SystemPromptDiagnostic = z.infer<typeof SystemPromptDiagnosticSchema>;

export const ToolProcessObservationSchema = z.object({
    status: z.enum(['alive', 'none', 'unknown']),
    /** Descendants can include tool helpers/MCP servers; excludes zombies. */
    liveCount: z.number().int().nonnegative().optional(),
    checkedAt: z.number(),
});
export type ToolProcessObservation = z.infer<typeof ToolProcessObservationSchema>;

export const NoProgressSchema = z.object({
    since: z.number(),
    observedAt: z.number(),
    thresholdMs: z.number().positive(),
    toolProcesses: ToolProcessObservationSchema,
    systemPrompt: SystemPromptDiagnosticSchema,
});
export type NoProgress = z.infer<typeof NoProgressSchema>;

export const NativeDeliveryDiagnosticSchema = z.object({
    kind: z.enum(['guidance', 'message']),
    keys: z.array(z.string()),
    reason: z.enum(['unresponsive', 'unconfirmed']),
    since: z.number(),
    systemPrompt: SystemPromptDiagnosticSchema,
});
export type NativeDeliveryDiagnostic = z.infer<typeof NativeDeliveryDiagnosticSchema>;

export const EngineDiagnosticsSchema = z.object({
    noProgress: NoProgressSchema.optional().catch(undefined),
    delivery: NativeDeliveryDiagnosticSchema.optional().catch(undefined),
    nativeExit: z.object({ since: z.number() }).optional().catch(undefined),
});
export type EngineDiagnostics = z.infer<typeof EngineDiagnosticsSchema>;

export const FullDiskAccessDiagnosticSchema = z.object({
    status: z.enum(['readable', 'denied', 'unknown', 'unsupported']),
    checkedAt: z.number(),
    method: z.literal('tcc-file-open'),
    reason: z.enum(['EPERM', 'timeout', 'failed', 'malformed', 'unavailable']).optional(),
});
export type FullDiskAccessDiagnostic = z.infer<typeof FullDiskAccessDiagnosticSchema>;

export const MachineSystemDiagnosticsSchema = z.object({
    fullDiskAccess: FullDiskAccessDiagnosticSchema,
});

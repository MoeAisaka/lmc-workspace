import * as z from 'zod';

export const MessageMetaSchema = z.object({
  sentFrom: z.string().optional(),
  // Native clients may publish their own mode codes (for example Rig's
  // auto/workspace_write/read_only/full_access), so this stays open-ended.
  permissionMode: z.string().optional(),
  model: z.string().nullable().optional(),
  modelProviderId: z.string().optional(),
  fallbackModel: z.string().nullable().optional(),
  customSystemPrompt: z.string().nullable().optional(),
  appendSystemPrompt: z.string().nullable().optional(),
  allowedTools: z.array(z.string()).nullable().optional(),
  disallowedTools: z.array(z.string()).nullable().optional(),
  effort: z.string().nullable().optional(),
  displayText: z.string().optional(),
  // What to do with a message that arrives while the engine is busy;
  // absent from older apps. See docs/plans/turn-queue-and-interrupt.md.
  intent: z.enum(['queue', 'steer', 'interrupt']).optional(),
});
export type MessageMeta = z.infer<typeof MessageMetaSchema>;

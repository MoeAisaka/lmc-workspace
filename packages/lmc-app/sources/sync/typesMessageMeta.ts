import { z } from 'zod';

// Shared message metadata schema
export const MessageMetaSchema = z.object({
    sentFrom: z.string().optional(), // Source identifier
    permissionMode: z.string().optional(), // Permission mode key for this message
    model: z.string().nullable().optional(), // Model name for this message (null = reset)
    modelProviderId: z.string().optional(), // Provider qualifier for metadata-driven clients such as Rig
    fallbackModel: z.string().nullable().optional(), // Fallback model for this message (null = reset)
    customSystemPrompt: z.string().nullable().optional(), // Custom system prompt for this message (null = reset)
    appendSystemPrompt: z.string().nullable().optional(), // Append to system prompt for this message (null = reset)
    allowedTools: z.array(z.string()).nullable().optional(), // Allowed tools for this message (null = reset)
    disallowedTools: z.array(z.string()).nullable().optional(), // Disallowed tools for this message (null = reset)
    effort: z.string().nullable().optional(), // Reasoning / thinking effort for this message (null = reset)
    displayText: z.string().optional(), // Optional text to display in UI instead of actual message text
    intent: z.enum(['queue', 'steer', 'interrupt']).optional(), // What to do when the engine is busy; see docs/plans/turn-queue-and-interrupt.md
    queueKey: z.string().optional(), // Hide this prompt/attachment until a durable queue receipt arrives.
});

export type MessageMeta = z.infer<typeof MessageMetaSchema>;

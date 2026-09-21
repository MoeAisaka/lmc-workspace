import { cachedModel } from '@/runtime/modelCatalogCache';
// Codex registry compatibility fallback, checked against the existing WebApp
// catalog (Codex 0.153 family for Astra, 0.144 family for GPT-5.6).
// This is a Codex harness catalog, not the public Responses API effort enum.
const CODEX_MODEL_EFFORTS: Record<string, readonly string[]> = {
    'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
};

// Claude names its models with this prefix and Codex never does, so a model
// arriving here under it did not come from a Codex picker — it is what a
// session that switched engines still had on file. Recognising the one
// foreign vocabulary we can name keeps unknown/custom models untouched.
const FOREIGN_MODEL_PREFIX = 'claude-';

export class UnsupportedCodexEffortError extends Error {
    constructor(model: string, effort: string, levels: readonly string[]) {
        super(`${model} does not support reasoning effort '${effort}'. Choose ${levels.join(', ')} and resend. The message was not sent.`);
        this.name = 'UnsupportedCodexEffortError';
    }
}

export class ForeignEngineModelError extends Error {
    constructor(model: string) {
        super(`'${model}' is a Claude model and this session runs on Codex. Pick a Codex model and resend. The message was not sent.`);
        this.name = 'ForeignEngineModelError';
    }
}

export function assertCodexModelEffort(model: string | null | undefined, effort: string | null | undefined): void {
    // A model belonging to the other engine would otherwise travel all the way
    // to the app-server and come back as an opaque 400. Refuse it here, where
    // the reason can still be named.
    if (model && model.startsWith(FOREIGN_MODEL_PREFIX)) {
        throw new ForeignEngineModelError(model);
    }
    // Unset delegates to Codex's thread/default semantics. Unknown/custom
    // models are owned by their provider, so do not guess their capabilities.
    const levels = cachedModel('codex', model)?.efforts ?? (model && Object.hasOwn(CODEX_MODEL_EFFORTS, model) ? CODEX_MODEL_EFFORTS[model] : undefined);
    if (levels && effort != null && !levels.includes(effort)) {
        throw new UnsupportedCodexEffortError(model!, effort, levels);
    }
}

/** The model registry belongs to the active account/provider, not to LMC's model-name guesses. */
export class AccountModelSelectionError extends Error {
    constructor(message: string) { super(message); this.name = 'AccountModelSelectionError'; }
}

export async function assertAccountModel(model: string | null | undefined, effort: string | null | undefined, port: {
    standardChatGptRoute: boolean;
    readAccount: () => Promise<unknown>;
    listModels: () => Promise<unknown[]>;
}): Promise<void> {
    if (!model || !port.standardChatGptRoute) return;
    const account = await port.readAccount() as { account?: { type?: string } | null };
    // API-key accounts and custom endpoints have their own model namespace.
    if (account?.account?.type !== 'chatgpt') return;
    const rows = (await port.listModels()).filter((row): row is { model: string; supportedReasoningEfforts?: { reasoningEffort: string }[] } =>
        !!row && typeof row === 'object' && typeof (row as any).model === 'string');
    if (!rows.length) throw new AccountModelSelectionError('暂时无法取得当前 Codex 账号的模型目录，请稍后重新检查；配置未应用。');
    const selected = rows.find(row => row.model === model);
    if (!selected) throw new AccountModelSelectionError(`当前 ChatGPT 账号不支持 Codex 模型 ${model}。可用模型：${rows.map(row => row.model).join(', ')}。请使用目录中的完整名称；未自动替换模型。`);
    const efforts = selected.supportedReasoningEfforts?.map(row => row.reasoningEffort);
    if (effort && efforts?.length && !efforts.includes(effort)) {
        throw new AccountModelSelectionError(`Codex 模型 ${model} 不支持 ${effort}；当前账号支持：${efforts.join(', ')}。`);
    }
}

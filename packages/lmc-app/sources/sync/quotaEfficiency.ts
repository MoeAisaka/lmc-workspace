import { usageTotal, type UsageRecord, type QuotaObservation } from 'lmc-wire';
export function quotaPool(engine: string, model: string | null) {
    if (engine !== 'agy') return 'account';
    if (!model) return null;
    if (/^gemini-/i.test(model)) return 'gemini';
    if (/^(claude-|gpt-)/i.test(model)) return 'claude_gpt';
    return null;
}
/** Observed correlation, NOT provider billing attribution. Sources are never
 * merged; a shared pool's five-hour and weekly percentages are never summed. */
export function quotaEfficiency(observations: QuotaObservation[], records: UsageRecord[], options: {
    machineId: string; engine: string; pool: string; window: string; allMachines?: boolean;
}) {
    const samples = observations.filter(s=>s.machineId===options.machineId && s.engine===options.engine)
        .map(s=>({at:s.capturedAt,w:s.pools.find(p=>p.id===options.pool)?.windows.find(w=>w.id===options.window)}))
        .filter(s=>s.w && !s.w.pending && s.w.remaining!==null && s.w.resetsAt!==null).sort((a,b)=>a.at-b.at);
    const scoped = records.filter(r=>r.engine===options.engine && (options.allMachines || r.machineId===options.machineId) && quotaPool(r.engine,r.model)===options.pool);
    const models=new Map<string,{model:string;tokens:number;matchedTokens:number;points:number;samples:number}>();
    for(const r of scoped){const model=r.model??'型号未上报';const row=models.get(model)??{model,tokens:0,matchedTokens:0,points:0,samples:0};row.tokens+=usageTotal(r.tokens);models.set(model,row);}
    let points=0, ambiguousPoints=0, excluded=0, intervals=0;
    const trend: {at:number;remaining:number}[]=samples.map(s=>({at:s.at,remaining:s.w!.remaining!}));
    for(let i=1;i<samples.length;i++){
        const a=samples[i-1],b=samples[i],delta=a.w!.remaining!-b.w!.remaining!;
        // Reset/replenishment, large gaps, and missing reset identities cannot
        // be used to derive consumption. No extrapolation through missing data.
        if(b.at-a.at<60_000||b.at-a.at>15*60_000||a.w!.resetsAt!==b.w!.resetsAt||a.w!.resetsAt!<=b.at||delta<0){excluded++;continue;}
        intervals++;points+=delta;
        const used=scoped.filter(r=>r.occurredAt>a.at&&r.occurredAt<=b.at);
        const names=new Set(used.map(r=>r.model));
        const otherDeviceActive=!options.allMachines&&records.some(r=>r.machineId!==options.machineId&&r.engine===options.engine&&quotaPool(r.engine,r.model)===options.pool&&r.occurredAt>a.at&&r.occurredAt<=b.at);
        const crossesBoundary=used.some(r=>r.startedAt!==undefined&&r.startedAt<a.at);
        if(delta<=0)continue; // Rounding/delayed updates do not imply free tokens.
        if(!used.length||names.size!==1||names.has(null)||crossesBoundary||otherDeviceActive){ambiguousPoints+=delta;continue;}
        const row=models.get(used[0].model!)!;
        row.matchedTokens+=used.reduce((sum,r)=>sum+usageTotal(r.tokens),0);row.points+=delta;row.samples++;
    }
    return {models:[...models.values()].sort((a,b)=>b.tokens-a.tokens),points,ambiguousPoints,excluded,intervals,trend,
        sampleCount:samples.length,last:samples.at(-1)?.at??null};
}

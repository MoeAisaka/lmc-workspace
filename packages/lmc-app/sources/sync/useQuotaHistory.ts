import * as React from 'react';
import { QuotaObservationSchema, type QuotaObservation, QUOTA_SAMPLE_MS } from 'lmc-wire';
import { apiSocket } from './apiSocket';
import { t } from '@/text';
export function useQuotaHistory(start:number,end:number){
    const [state,setState]=React.useState<{observations:QuotaObservation[];error:string|null;loading:boolean}>({observations:[],error:null,loading:true});
    const cache=React.useRef({start:0,end:0,rows:new Map<string,QuotaObservation>()});
    React.useEffect(()=>{
        if(start<cache.current.start||end<cache.current.end)cache.current.rows.clear();
        const queryStart=cache.current.rows.size?Math.max(start,cache.current.end-86400_000):start;
        let disposed=false;
        const abort=new AbortController();
        const timeout=setTimeout(()=>abort.abort(),20_000);
        (async()=>{
            try{
                const observations:QuotaObservation[]=[];let cursor:string|undefined;
                do{
                    const response=await apiSocket.request('/v2/usage/quota/query',{method:'POST',headers:{'Content-Type':'application/json'},signal:abort.signal,body:JSON.stringify({start:queryStart,end,cursor})});
                    if(!response.ok)throw new Error(t('lmc.usage.errQuotaUnavailable'));
                    const page=await response.json();
                    if(!Array.isArray(page.observations))throw new Error(t('lmc.usage.errQuotaInvalid'));
                    observations.push(...page.observations.map((s:unknown)=>QuotaObservationSchema.parse(s)));
                    if(page.nextCursor&&page.nextCursor===cursor)throw new Error(t('lmc.usage.errQuotaPagination'));
                    cursor=page.nextCursor??undefined;
                }while(cursor&&!disposed);
                if(!disposed){
                    for(const s of observations)cache.current.rows.set(`${s.machineId}:${s.engine}:${Math.floor(s.capturedAt/QUOTA_SAMPLE_MS)}`,s);
                    for(const [k,s] of cache.current.rows)if(s.capturedAt<start||s.capturedAt>=end)cache.current.rows.delete(k);
                    cache.current.start=start;cache.current.end=end;
                    setState({observations:[...cache.current.rows.values()],error:null,loading:false});
                }
            }catch{if(!disposed)setState(s=>({...s,error:t('lmc.usage.errQuotaKeepingPrevious'),loading:false}));}
            finally{clearTimeout(timeout);}
        })();
        return()=>{disposed=true;abort.abort();clearTimeout(timeout);};
    // Poll on the shared dashboard clock, once per minute; avoid refetch on every render.
    },[Math.floor(start/60_000),Math.floor(end/60_000)]);
    return state;
}

import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionRefreshOptions } from './sessionRefresh';
export type RefreshJob = {sessionId:string;pid:number;options:SessionRefreshOptions;state:'waiting'|'error';updatedAt:number;error?:string};
/** Contains only control-plane handoff data, never keys or provider transcripts. */
export class RefreshJournal {
    constructor(private directory: string) {}
    private path(id:string) {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid refresh identity');
        return join(this.directory, id+'.json');
    }
    async put(job:RefreshJob) {
        const destination=this.path(job.sessionId);
        if (!Number.isSafeInteger(job.pid)||job.pid<=0) throw new Error('Invalid refresh process');
        await mkdir(this.directory,{recursive:true,mode:0o700});
        const temp=destination+'.'+randomUUID()+'.tmp';
        await writeFile(temp,JSON.stringify(job),{mode:0o600});
        await rename(temp,destination);
    }
    async list():Promise<RefreshJob[]> {
        let names:string[];
        try {names=await readdir(this.directory);} catch(e:any) {if(e.code==='ENOENT')return [];throw e;}
        const jobs:RefreshJob[]=[];
        for(const name of names.filter(n=>n.endsWith('.json'))) {
            const job=JSON.parse(await readFile(join(this.directory,name),'utf8')) as RefreshJob;
            if(this.path(job.sessionId)!==join(this.directory,name)||!Number.isSafeInteger(job.pid)||job.pid<=0||!['waiting','error'].includes(job.state))throw new Error('Invalid refresh journal');
            jobs.push(job);
        }
        return jobs;
    }
    async remove(id:string) {await unlink(this.path(id)).catch((e:any)=>{if(e.code!=='ENOENT')throw e;});}
}

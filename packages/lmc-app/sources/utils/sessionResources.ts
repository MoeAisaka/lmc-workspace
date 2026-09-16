/** Only explicit write/edit paths and assistant file links, never all project files. */
export function collectSessionResources(messages: readonly any[]): string[] {
    const paths=new Set<string>();
    const add=(value:unknown)=>{if(typeof value==='string'&&value.length<4096&&!/^(https?:|data:|javascript:)/i.test(value)&&!value.includes('\0'))paths.add(value.replace(/^sandbox:/,''));};
    for(const m of messages){
        if(m.kind==='tool-call' && /write|edit|patch|create.*file/i.test(m.tool?.name||'') && m.tool?.state!=='error') {
            const input=m.tool.input;
            if(input&&typeof input==='object'){add(input.file_path);add(input.path);add(input.filename);}
            const patch=typeof input==='string'?input:input?.patch||input?.patchText||input?.input;
            if(typeof patch==='string')for(const match of patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm))add(match[1]);
        }
        if(m.kind==='agent-text'&&typeof m.text==='string')for(const match of m.text.matchAll(/\[[^\]]+\]\((?:<([^>]+)>|([^\s)]+))\)/g)){const target=match[1]||match[2];if(/\.[a-z0-9]{1,10}(?::\d+)?$/i.test(target))add(target.replace(/:\d+$/,''));}
    }
    return [...paths].reverse();
}

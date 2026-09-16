import { realpath, stat, open } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
const execFileAsync = promisify(execFile);
export const RESOURCE_LIMIT = 32 * 1024 * 1024;
/**
 * Relative paths resolve against the session's project directory; absolute ones
 * are taken as given. The project boundary is not a security boundary here: the
 * same authenticated client can spawn a session that runs arbitrary shell on
 * this machine, so refusing to read a file it can already `cat` only blocked
 * the operator. Regular-file and size checks remain — those prevent accidents,
 * not attacks.
 */
export async function resolveResourceFile(root: string, target: string): Promise<string> {
    if (typeof target !== 'string' || !target || target.length > 4096 || target.includes('\0') || /^[a-z]+:/i.test(target)) throw new Error('无效的文件路径');
    const path = await realpath(resolve(await realpath(root), target));
    if (!(await stat(path)).isFile()) throw new Error('仅支持普通文件');
    return path;
}
export async function readResourceFile(root: string, target: string, limit = RESOURCE_LIMIT) {
    const path = await resolveResourceFile(root, target);
    const handle = await open(path, 'r');
    try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('仅支持普通文件');
        if (info.size > limit) throw new Error('文件过大，请在会话设备上打开（下载上限 32 MB）');
        // Bounded read also covers files that grow after stat.
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
            size += chunk.length;
            if (size > limit) throw new Error('文件过大，请在会话设备上打开（下载上限 32 MB）');
            chunks.push(Buffer.from(chunk));
        }
        return { name: basename(path), content: Buffer.concat(chunks).toString('base64'), size };
    } finally { await handle.close(); }
}
export async function readResourceChunk(root:string,target:string,offset=0,expectedRevision?:string,chunkSize=192*1024) {
    if(!Number.isSafeInteger(offset)||offset<0||offset>RESOURCE_LIMIT)throw new Error('无效的下载位置');
    const path=await resolveResourceFile(root,target);const handle=await open(path,'r');
    try{
        const info=await handle.stat();const revision=`${info.ino}:${info.mtimeMs}:${info.size}`;
        if(!info.isFile()||info.size>RESOURCE_LIMIT)throw new Error('文件过大，请在会话设备上打开（下载上限 32 MB）');
        if(expectedRevision!==undefined&&expectedRevision!==revision)throw new Error('文件已变化，请重新下载');
        if(offset>info.size)throw new Error('无效的下载位置');
        const buffer=Buffer.alloc(Math.min(chunkSize,info.size-offset));
        let bytesRead=0;
        while(bytesRead<buffer.length){const part=await handle.read(buffer,bytesRead,buffer.length-bytesRead,offset+bytesRead);if(part.bytesRead===0)throw new Error('文件读取中断');bytesRead+=part.bytesRead;}
        const after=await handle.stat();
        if(after.mtimeMs!==info.mtimeMs||after.size!==info.size)throw new Error('文件已变化，请重新下载');
        if(bytesRead===0&&offset<info.size)throw new Error('文件读取中断');
        return {name:basename(path),content:buffer.subarray(0,bytesRead).toString('base64'),size:info.size,revision,nextOffset:offset+bytesRead<info.size?offset+bytesRead:null};
    }finally{await handle.close();}
}
export function registerResourceHandlers(manager: RpcHandlerManager, root: string) {
    manager.registerHandler('resource-file', async (data: { path: string; action: 'download' | 'open-host';offset?:number;revision?:string }) => {
        try {
            if (data?.action === 'download') return { success: true, ...await readResourceChunk(root, data.path,data.offset,data.revision) };
            if (data?.action !== 'open-host') throw new Error('不支持的文件操作');
            if (process.platform !== 'darwin') throw new Error('当前设备尚不支持默认应用打开，请下载文件');
            const path = await resolveResourceFile(root, data.path);
            await execFileAsync('/usr/bin/open', [path], { timeout: 10000, maxBuffer: 8192 });
            return { success: true };
        } catch (error) { return { success: false, error: error instanceof Error ? error.message : '文件操作失败' }; }
    });
}

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
const run = promisify(execFile);
const require = createRequire(import.meta.url);
export type Engine = 'claude' | 'codex';
export type Component = Engine | 'agent';
export type Release = {engine:Component; version:string; directory:string};
export type RuntimeSelection = Partial<Record<Component, Release>>;
// Resolve on demand: importing this module must not require an initialized configuration.
export function selectionFile() {return join(configuration.lmcHomeDir,'runtime-selection.json');}
export function validateRelease(value:Release) {
    if (!value || !['claude','codex','agent'].includes(value.engine) || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version) || !isAbsolute(value.directory)) throw new Error('无效的运行版本');
}
export function readRuntimeSelection():RuntimeSelection {
    const file=selectionFile();
    if (!existsSync(file)) return {};
    const value=JSON.parse(readFileSync(file,'utf8')) as RuntimeSelection;
    for(const [engine, release] of Object.entries(value)) {validateRelease(release);if(release.engine!==engine)throw new Error('运行版本配置不匹配');}
    return value;
}
// Snapshot on first use: an active conversation never silently switches binaries.
let startupSelection:RuntimeSelection|undefined;
export function runtimeRelease(engine: Component, fresh=false) {return (fresh ? readRuntimeSelection() : (startupSelection??=readRuntimeSelection()))[engine];}
export function sdkRequire(release:Release|null=runtimeRelease('claude')??null) {
    return release ? createRequire(join(release.directory,'package.json')) : require;
}
export function claudeExecutable(release:Release|null=runtimeRelease('claude')??null) {
    const relative=createRequire(sdkRequire(release).resolve('@anthropic-ai/claude-agent-sdk'));
    return relative.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
}
export function codexExecutable(release:Release|null=runtimeRelease('codex')??null) {
    return release ? join(release.directory,'node_modules','.bin','codex') : 'codex';
}
export function agentRoot() {return runtimeRelease('agent',true)?.directory ?? projectPath();}
export function engineCapabilities(engine:Engine) {
    return {refresh:true,cancelRefresh:true,authentication:true,resume:true,resourceFiles:true,fileInbox:true,model:true,effort:true,context:engine==='codex',serviceTier:engine==='codex',runtimeConfiguration:engine==='codex'};
}
export async function runtimeVersion(engine:Engine, fresh=false) {
    const release=runtimeRelease(engine,fresh)??null;
    const command=engine==='claude'?claudeExecutable(release):codexExecutable(release);
    const {stdout}=await run(command,['--version'],{timeout:10000,maxBuffer:8192});
    const version=stdout.match(/\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?/)?.[0];
    if(!version)throw new Error('无法识别引擎版本');
    return {engine,version,packageVersion:release?.version,source:release?'lmc-managed':engine==='claude'?'sdk-bundled':'system-path',path:command==='codex'?command:realpathSync(command)};
}

export function refreshSupported(metadata:{flavor?:string;sessionConfiguration?:boolean;sessionCapabilities?:{refresh:boolean}}){
    return metadata.sessionCapabilities ? metadata.sessionCapabilities.refresh : metadata.flavor==='codex'&&metadata.sessionConfiguration===true;
}

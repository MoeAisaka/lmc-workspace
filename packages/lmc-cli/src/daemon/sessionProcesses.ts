import psList from 'ps-list';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { win32 } from 'node:path';
import type { RunningProcess } from './sessionSpawnGuard';

const execFileAsync = promisify(execFile);
// ps-list's Windows fastlist backend returns names/PIDs only. Session adoption
// also needs the actual command; a missing command must remain unknown, not be
// mistaken for an exited session. Query only Node, never unrelated app argv.
const windowsScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$items = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop | Select-Object ProcessId, Name, CommandLine)
[Console]::Out.Write((ConvertTo-Json -InputObject $items -Compress))
`;

export async function listSessionProcesses(): Promise<RunningProcess[]> {
    if (process.platform !== 'win32') return psList();
    const executable = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await execFileAsync(executable, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsScript, 'utf16le').toString('base64'),
    ], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' });
    const rows: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (!Array.isArray(rows)) throw new Error('Invalid Windows session process inventory');
    return rows.map(row => {
        if (!row || !Number.isSafeInteger(row.ProcessId) || row.ProcessId <= 0
            || typeof row.Name !== 'string' || !row.Name
            || (row.CommandLine != null && typeof row.CommandLine !== 'string')) {
            throw new Error('Invalid Windows session process record');
        }
        return { pid: row.ProcessId, name: row.Name, cmd: row.CommandLine ?? undefined };
    });
}

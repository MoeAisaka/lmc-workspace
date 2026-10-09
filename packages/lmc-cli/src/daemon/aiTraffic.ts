import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { request } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { promisify } from 'node:util';
import type { AiTraffic, AiTrafficDay } from '@/api/types';

const execFileAsync = promisify(execFile);

/**
 * How much network data the two AI providers cost, per day.
 *
 * Measured where the traffic leaves this machine, because that is what a
 * metered uplink is billed for. Only traffic to the providers themselves
 * counts, on every platform. Claude re-sends the whole context on every
 * request, cache hit or not, so its traffic is almost all upload: one session
 * measured 18.7 MB up against 0.5 MB down in 70 seconds (2026-10-08).
 */
export type AiProvider = 'claude' | 'openai';
export type TrafficDelta = { provider: AiProvider; up: number; down: number };

const emptyDay = (): AiTrafficDay => ({ claude: { up: 0, down: 0 }, openai: { up: 0, down: 0 } });

/** Local calendar day, so "today" on the dashboard is the owner's day. */
export function localDay(now: number): string {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---- macOS: per-flow deltas from nettop --------------------------------------

/** The engine binaries, as nettop names them; only their flows are looked at. */
export const ENGINE_PROCESS_NAMES = ['claude', 'codex'];

/**
 * Where the two providers are reached. An engine process also talks to its MCP
 * servers: an idle Claude session was measured exchanging about 6 KB/s with one
 * of them (2026-10-08), none of it Anthropic's. So a flow counts by its remote
 * address, not by the process that owns it.
 */
export const PROVIDER_HOSTS: Record<AiProvider, string[]> = {
    claude: ['api.anthropic.com', 'claude.ai', 'mcp-proxy.anthropic.com', 'statsig.anthropic.com', 'console.anthropic.com', 'platform.claude.com', 'api.claude.com'],
    openai: ['chatgpt.com', 'api.openai.com', 'auth.openai.com', 'ab.chatgpt.com', 'chat.openai.com', 'cdn.oaistatic.com'],
};
/** Anthropic announces its own address space; OpenAI sits behind shared CDN addresses and is only known by name. */
const PROVIDER_SUBNETS: Record<AiProvider, Array<[string, number, 'ipv4' | 'ipv6']>> = {
    claude: [['160.79.104.0', 23, 'ipv4'], ['2607:6bc0::', 48, 'ipv6']],
    openai: [],
};

export type AddressClassifier = (address: string) => AiProvider | null;

/** Remembers every address the providers' names resolved to in the last day; answers change between lookups. */
export function createProviderAddresses(now: () => number = Date.now, keepMs = 24 * 3600_000) {
    const seen: Record<AiProvider, Map<string, number>> = { claude: new Map(), openai: new Map() };
    let lists: Record<AiProvider, BlockList> | null = null;
    const build = () => {
        const next = { claude: new BlockList(), openai: new BlockList() };
        for (const provider of ['claude', 'openai'] as const) {
            for (const [network, prefix, family] of PROVIDER_SUBNETS[provider]) next[provider].addSubnet(network, prefix, family);
            for (const address of seen[provider].keys()) { try { next[provider].addAddress(address, isIP(address) === 6 ? 'ipv6' : 'ipv4'); } catch { /* not an address: skip */ } }
        }
        return next;
    };
    return {
        learn(provider: AiProvider, addresses: string[]) {
            const at = now();
            for (const address of addresses) if (isIP(address)) seen[provider].set(address, at);
            for (const [address, last] of seen[provider]) if (at - last > keepMs) seen[provider].delete(address);
            lists = null;
        },
        classify: ((address: string) => {
            const family = isIP(address);
            if (!family) return null;
            lists ??= build();
            const kind = family === 6 ? 'ipv6' : 'ipv4';
            return lists.claude.check(address, kind) ? 'claude' : lists.openai.check(address, kind) ? 'openai' : null;
        }) as AddressClassifier,
    };
}

/** `tcp4 192.168.1.2:55606<->160.79.104.10:443` or `tcp6 fe80::1%en0.52000<->2606:4700::6812:202f.443` → the remote address. */
export function remoteAddressOfFlow(flow: string): string | null {
    const match = /^(tcp|udp)([46]) \S*<->(\S+)$/.exec(flow);
    if (!match) return null;
    const address = match[3].replace(match[2] === '4' ? /:[^:]*$/ : /\.[^.]*$/, '').replace(/%.*$/, '');
    return isIP(address) ? address : null;
}

/**
 * `nettop -d -x -n -J bytes_in,bytes_out` prints, for every sample, a header
 * line, then each process followed by its open flows. The first sample is the
 * totals of flows already open, not a delta, and is dropped.
 */
export function createNettopParser(classify: AddressClassifier, onDelta: (delta: TrafficDelta) => void) {
    let blocks = 0, pending = '';
    return (chunk: string) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
            if (line.startsWith(',bytes_in')) { blocks++; continue; }
            if (blocks < 2) continue;
            const parts = line.split(',');
            if (parts.length < 3) continue;
            const address = remoteAddressOfFlow(parts[0]);
            const provider = address && classify(address);
            const down = Number(parts[1]), up = Number(parts[2]);
            if (!provider || !Number.isFinite(up) || !Number.isFinite(down) || (up <= 0 && down <= 0)) continue;
            onDelta({ provider, up: Math.max(0, up), down: Math.max(0, down) });
        }
    };
}

// ---- a local proxy core's connection list (Windows; macOS when one is running) ----

/** Only these two are ever counted or kept; any other host is ignored on the spot. */
export function providerOfHost(host: string): AiProvider | null {
    const h = host.toLowerCase();
    if (/(^|\.)(anthropic\.com|claude\.ai|claude\.com|claudeusercontent\.com)$/.test(h)) return 'claude';
    if (/(^|\.)(openai\.com|chatgpt\.com|oaistatic\.com|oaiusercontent\.com)$/.test(h)) return 'openai';
    return null;
}

export type ProxyConnection = { id: string; upload: number; download: number; metadata?: { host?: string; sniffHost?: string; process?: string; processPath?: string } };

/**
 * Whether a connection the proxy core lists may be an engine's. The core names
 * the owning process for desktop apps and browsers, but leaves it empty for the
 * engines' own binaries (seen on macOS for both, 2026-10-09). So a named process
 * that is not an engine is left out, and an unnamed one is taken as an engine.
 * Case matters: the desktop app's binary is `Claude`, the engine's is `claude`.
 */
export function isEngineConnection(connection: ProxyConnection): boolean {
    const name = connection.metadata?.process ?? '', path = connection.metadata?.processPath ?? '';
    if (!name && !path) return true;
    return ENGINE_PROCESS_NAMES.includes(name) || ENGINE_PROCESS_NAMES.some(engine => path.endsWith(`/${engine}`) || path.includes(`/${engine}/versions/`));
}

/**
 * Turns successive snapshots of the connection list into deltas. A connection
 * already open at the first snapshot only counts from then on; one that appears
 * later counts in full, since it began after the previous look.
 */
export function createConnectionTracker(accept: (connection: ProxyConnection) => boolean = () => true) {
    const seen = new Map<string, { up: number; down: number }>();
    let primed = false;
    return (connections: ProxyConnection[]): TrafficDelta[] => {
        const deltas: TrafficDelta[] = [], live = new Set<string>();
        for (const connection of connections) {
            const provider = providerOfHost(connection.metadata?.host || connection.metadata?.sniffHost || '');
            if (!provider || typeof connection.id !== 'string' || !accept(connection)) continue;
            live.add(connection.id);
            const up = Number(connection.upload) || 0, down = Number(connection.download) || 0;
            const before = seen.get(connection.id) ?? (primed ? { up: 0, down: 0 } : { up, down });
            seen.set(connection.id, { up, down });
            const delta = { provider, up: Math.max(0, up - before.up), down: Math.max(0, down - before.down) };
            if (delta.up > 0 || delta.down > 0) deltas.push(delta);
        }
        for (const id of seen.keys()) if (!live.has(id)) seen.delete(id);
        primed = true;
        return deltas;
    };
}

type ProxyEndpoint = { pipe: string; secret: string };

/** Clash Verge starts its core with `-ext-ctl-pipe <pipe>` (Windows) or `-ext-ctl-unix <socket>` (macOS) and `-f <config>`; the secret is in that config. */
export function parseProxyCoreCommand(commandLine: string, readConfig: (path: string) => string): ProxyEndpoint | null {
    const pipe = /-ext-ctl-(?:pipe|unix)\s+"?([^"\s]+)"?/.exec(commandLine)?.[1];
    const config = /-f\s+"?([^"]+?\.ya?ml)"?(?:\s|$)/.exec(commandLine)?.[1];
    if (!pipe) return null;
    let secret = '';
    try { if (config) secret = /^secret:\s*['"]?([^'"\s#]*)/m.exec(readConfig(config))?.[1] ?? ''; } catch { /* no secret readable: try without */ }
    return { pipe, secret };
}

async function findProxyEndpoint(platform: NodeJS.Platform): Promise<ProxyEndpoint | null> {
    const { stdout } = platform !== 'win32' ? await execFileAsync('/bin/ps', ['-axo', 'command='], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }) : await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"name='verge-mihomo.exe'\" | Select-Object -ExpandProperty CommandLine"],
    { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
    for (const line of stdout.split(/\r?\n/)) {
        if (platform !== 'win32' && !/(^|\/)verge-mihomo\s/.test(line)) continue;
        const endpoint = parseProxyCoreCommand(line, path => readFileSync(path, 'utf8'));
        if (endpoint) return endpoint;
    }
    return null;
}

function readProxyCore(endpoint: ProxyEndpoint, path: string): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
        const req = request({ socketPath: endpoint.pipe, path, timeout: 8000, headers: endpoint.secret ? { Authorization: `Bearer ${endpoint.secret}` } : {} }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; if (body.length > 32 * 1024 * 1024) req.destroy(new Error('Connection list too large')); });
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error(`Proxy core answered ${res.statusCode}`));
                try { resolve(JSON.parse(body) ?? {}); } catch (error) { reject(error as Error); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Proxy core timeout')));
        req.end();
    });
}

const readConnections = async (endpoint: ProxyEndpoint) => ((await readProxyCore(endpoint, '/connections')).connections ?? []) as ProxyConnection[];
/** With the core's virtual interface on, every flow leaves through the core and nettop only sees placeholder addresses. */
const readCapturesAll = async (endpoint: ProxyEndpoint) => (await readProxyCore(endpoint, '/configs')).tun?.enable === true;

// ---- the daily ledger -------------------------------------------------------

export const AI_TRAFFIC_KEEP_DAYS = 120;
export const AI_TRAFFIC_PUBLISH_DAYS = 35;

export function createTrafficLedger(initial: Record<string, AiTrafficDay> = {}) {
    const days: Record<string, AiTrafficDay> = {};
    for (const [day, value] of Object.entries(initial)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        const read = (v: unknown) => (Number.isFinite(v) && (v as number) > 0 ? (v as number) : 0);
        days[day] = { claude: { up: read(value?.claude?.up), down: read(value?.claude?.down) }, openai: { up: read(value?.openai?.up), down: read(value?.openai?.down) } };
    }
    let dirty = false;
    return {
        add(delta: TrafficDelta, now: number) {
            const day = localDay(now);
            const entry = days[day] ??= emptyDay();
            entry[delta.provider].up += delta.up;
            entry[delta.provider].down += delta.down;
            dirty = true;
            const kept = Object.keys(days).sort();
            for (const old of kept.slice(0, Math.max(0, kept.length - AI_TRAFFIC_KEEP_DAYS))) delete days[old];
        },
        days: () => days,
        recent(count: number): Record<string, AiTrafficDay> {
            return Object.fromEntries(Object.keys(days).sort().slice(-count).map(day => [day, days[day]]));
        },
        total(): number {
            let sum = 0;
            for (const day of Object.values(days)) sum += day.claude.up + day.claude.down + day.openai.up + day.openai.down;
            return sum;
        },
        takeDirty() { const was = dirty; dirty = false; return was; },
    };
}

export function readLedgerFile(path: string): Record<string, AiTrafficDay> {
    try { return (JSON.parse(readFileSync(path, 'utf8')) as { days?: Record<string, AiTrafficDay> }).days ?? {}; } catch { return {}; }
}

function writeLedgerFile(path: string, days: Record<string, AiTrafficDay>) {
    const next = `${path}.tmp`;
    writeFileSync(next, JSON.stringify({ version: 1, days }), { mode: 0o600 });
    renameSync(next, path);
}

export interface AiTrafficOptions {
    file: string;
    publish: (traffic: AiTraffic) => Promise<unknown>;
    platform?: NodeJS.Platform;
    now?: () => number;
    /** Tests supply these in place of nettop and the proxy core. */
    startProcessSampler?: (onDelta: (delta: TrafficDelta) => void) => () => void;
    pollConnections?: () => Promise<ProxyConnection[]>;
    /** Whether the proxy core carries all traffic; on macOS the process sampler is then ignored. */
    proxyCapturesAll?: () => Promise<boolean>;
    flushMs?: number;
    pollMs?: number;
}

/**
 * nettop block-buffers when its output is a pipe and only flushes on exit, so
 * a long-running one would lose what it holds when killed. Run it a minute at
 * a time instead. It samples every second because a flow is only listed while
 * it is open: against the per-process totals, one-second samples accounted
 * for 88% of the bytes, and the providers' own connections are long-lived.
 */
export const NETTOP_SAMPLES_PER_RUN = 60;
function startNettop(onDelta: (delta: TrafficDelta) => void): () => void {
    let child: ChildProcess | null = null, stopped = false, retry: ReturnType<typeof setTimeout> | null = null;
    const addresses = createProviderAddresses();
    const resolve = async () => {
        for (const provider of ['claude', 'openai'] as const) {
            const found = await Promise.all(PROVIDER_HOSTS[provider].map(host => lookup(host, { all: true }).then(list => list.map(entry => entry.address), () => [] as string[])));
            if (!stopped) addresses.learn(provider, found.flat());
        }
    };
    void resolve();
    const resolver = setInterval(() => { void resolve(); }, 5 * 60_000);
    resolver.unref?.();
    const launch = () => {
        if (stopped) return;
        const parse = createNettopParser(addresses.classify, onDelta), startedAt = Date.now();
        let settled = false;
        child = spawn('/usr/bin/nettop', ['-d', '-x', '-n', '-t', 'external', '-L', String(NETTOP_SAMPLES_PER_RUN + 1), '-s', '1',
            ...ENGINE_PROCESS_NAMES.flatMap(name => ['-p', name]), '-J', 'bytes_in,bytes_out'],
            // nettop polls its input for keys: on /dev/null that read returns at once and it spins a whole core.
            // An open pipe that is never written to keeps it asleep between samples.
            { stdio: ['pipe', 'pipe', 'ignore'] });
        child.stdin?.on('error', () => {});
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', parse);
        const again = () => {
            if (settled) return;
            settled = true; child = null;
            if (stopped) return;
            // A run that ended early did not measure anything; do not spin on it.
            const wait = Date.now() - startedAt < NETTOP_SAMPLES_PER_RUN * 500 ? 60_000 : 0;
            retry = setTimeout(() => { retry = null; launch(); }, wait); retry.unref?.();
        };
        child.once('error', again);
        child.once('close', again);
    };
    launch();
    return () => { stopped = true; clearInterval(resolver); if (retry !== null) clearTimeout(retry); child?.kill('SIGTERM'); };
}

/**
 * Sample, add up by local day, keep the ledger on disk and publish the last
 * weeks into the daemon state. Nothing here may hold up or bring down the
 * daemon: a sampler that cannot run simply records nothing.
 */
export function startAiTraffic(options: AiTrafficOptions) {
    const { file, publish, platform = process.platform, now = Date.now, flushMs = 60_000, pollMs = 10_000 } = options;
    const ledger = createTrafficLedger(readLedgerFile(file));
    const record = (delta: TrafficDelta) => ledger.add(delta, now());
    let stopped = false, publishedTotal = -1, publishing = false;
    const stops: Array<() => void> = [];

    // macOS behind a proxy core in virtual-interface mode: nettop sees every flow going to a placeholder
    // address (a MacBook recorded next to nothing for a day, 2026-10-09), or, without fake addresses, the
    // same bytes the core reports. Either way the core is the one source then.
    let proxyCapturesAll = false;
    const recordSampled = (delta: TrafficDelta) => { if (!proxyCapturesAll) record(delta); };
    if (options.startProcessSampler) stops.push(options.startProcessSampler(recordSampled));
    else if (platform === 'darwin') { try { stops.push(startNettop(recordSampled)); } catch { /* no sampler, no numbers */ } }

    if (options.pollConnections || platform === 'win32' || platform === 'darwin') {
        // Windows has no process sampler and counts every program's traffic to the two providers;
        // macOS keeps to the engines, as its sampler does.
        const track = createConnectionTracker(platform === 'darwin' ? isEngineConnection : undefined);
        let endpoint: ProxyEndpoint | null = null, lookedAt = 0, busy = false, modeAt = 0;
        const poll = async () => {
            if (stopped || busy) return;
            busy = true;
            try {
                if (options.pollConnections) {
                    if (options.proxyCapturesAll) proxyCapturesAll = await options.proxyCapturesAll();
                    for (const delta of track(await options.pollConnections())) record(delta);
                    return;
                }
                // Looking the core up starts a process; do it once, and again only after a failure, at most every five minutes.
                if (!endpoint && now() - lookedAt >= 5 * 60_000) { lookedAt = now(); endpoint = await findProxyEndpoint(platform); }
                if (!endpoint) { proxyCapturesAll = false; return; }
                if (platform === 'darwin' && now() - modeAt >= 60_000) { modeAt = now(); proxyCapturesAll = await readCapturesAll(endpoint); }
                for (const delta of track(await readConnections(endpoint))) record(delta);
            } catch { endpoint = null; proxyCapturesAll = false; modeAt = 0; }
            finally { busy = false; }
        };
        void poll();
        const timer = setInterval(() => { void poll(); }, pollMs);
        timer.unref?.();
        stops.push(() => clearInterval(timer));
    }

    const flush = async () => {
        if (stopped || publishing) return;
        if (ledger.takeDirty()) { try { writeLedgerFile(file, ledger.days()); } catch { /* disk trouble must not stop the count */ } }
        const total = ledger.total();
        // Shared state: rewrite it for a megabyte of news, not for every packet.
        if (publishedTotal >= 0 && total - publishedTotal < 1024 * 1024) return;
        if (publishedTotal < 0 && total === 0) { publishedTotal = 0; return; }
        publishing = true;
        try { await publish({ updatedAt: now(), days: ledger.recent(AI_TRAFFIC_PUBLISH_DAYS) }); publishedTotal = total; }
        catch { /* offline: the next flush tries again */ }
        finally { publishing = false; }
    };
    const timer = setInterval(() => { void flush(); }, flushMs);
    timer.unref?.();
    void flush();
    return () => {
        stopped = true;
        clearInterval(timer);
        for (const stop of stops) stop();
        if (ledger.takeDirty()) { try { writeLedgerFile(file, ledger.days()); } catch { /* best effort on the way out */ } }
    };
}

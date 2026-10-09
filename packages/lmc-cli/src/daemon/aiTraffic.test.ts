import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiTraffic } from '@/api/types';
import { AI_TRAFFIC_KEEP_DAYS, createConnectionTracker, createNettopParser, createProviderAddresses, createTrafficLedger, localDay, parseProxyCoreCommand, providerOfHost, remoteAddressOfFlow, startAiTraffic, type TrafficDelta, isEngineConnection } from './aiTraffic';

afterEach(() => vi.useRealTimers());
const MB = 1024 * 1024;

describe('AI traffic', () => {
    it('reads the remote address of a nettop flow row', () => {
        expect(remoteAddressOfFlow('tcp4 192.168.1.2:55606<->160.79.104.10:443')).toBe('160.79.104.10');
        expect(remoteAddressOfFlow('udp4 192.168.1.2:55606<->172.64.155.209:443')).toBe('172.64.155.209');
        expect(remoteAddressOfFlow('tcp6 fe80::1%en0.52000<->2606:4700::6812:202f.443')).toBe('2606:4700::6812:202f');
        for (const row of ['claude.81488', 'tcp4 127.0.0.1:54294<->localhost:51557', 'tcp4 *:0<->*:0', '']) expect(remoteAddressOfFlow(row)).toBeNull();
    });
    it('knows the providers by resolved address and by Anthropic\'s own range, and forgets stale answers', () => {
        let at = 0;
        const addresses = createProviderAddresses(() => at, 1000);
        // Anthropic's range needs no lookup; OpenAI is unknown until its names resolve.
        expect(addresses.classify('160.79.104.10')).toBe('claude');
        expect(addresses.classify('160.79.105.200')).toBe('claude');
        expect(addresses.classify('160.79.106.1')).toBeNull();
        expect(addresses.classify('2607:6bc0::10')).toBe('claude');
        expect(addresses.classify('172.64.155.209')).toBeNull();
        addresses.learn('openai', ['172.64.155.209', '104.18.32.47', '2606:4700::6812:202f', 'not-an-address']);
        expect(addresses.classify('172.64.155.209')).toBe('openai');
        expect(addresses.classify('2606:4700:0:0:0:0:6812:202f')).toBe('openai');
        // Another site on the same CDN is not OpenAI.
        expect(addresses.classify('172.67.134.160')).toBeNull();
        expect(addresses.classify('192.168.1.3')).toBeNull();
        expect(addresses.classify('localhost')).toBeNull();
        at = 900; addresses.learn('openai', ['104.18.32.47']);
        at = 1500; addresses.learn('openai', []);
        expect(addresses.classify('172.64.155.209')).toBeNull();
        expect(addresses.classify('104.18.32.47')).toBe('openai');
    });
    it('counts nettop flows by where they go, drops the first block, and survives split chunks', () => {
        const seen: TrafficDelta[] = [];
        const addresses = createProviderAddresses();
        addresses.learn('openai', ['172.64.155.209']);
        const parse = createNettopParser(addresses.classify, delta => seen.push(delta));
        // First block: totals of flows already open, not a delta.
        parse(',bytes_in,bytes_out,\nclaude.81488,100000,9200000,\ntcp4 192.168.1.2:51000<->160.79.104.10:443,100000,9200000,\n');
        expect(seen).toEqual([]);
        parse(',bytes_in,bytes_out,\nclaude.81488,140000,18790000,\ntcp4 192.168.1.2:51000<->160.79.104.10:443,53000,187');
        parse('30000,\ntcp4 192.168.1.2:51001<->172.67.134.160:443,86502,33420,\ntcp4 192.168.1.2:51002<->192.168.1.3:14242,24,0,\n'
            + 'codex.80934,2100,1000,\ntcp4 192.168.1.2:51003<->172.64.155.209:443,2000,1000,\ntcp4 192.168.1.2:51004<->160.79.104.10:443,0,0,\n');
        // The MCP server and the LAN host an engine also talks to are not counted, and neither is the process row.
        expect(seen).toEqual([{ provider: 'claude', up: 18730000, down: 53000 }, { provider: 'openai', up: 1000, down: 2000 }]);
        parse(',bytes_in,bytes_out,\ncodex.80934,10,20,\ntcp4 192.168.1.2:51003<->172.64.155.209:443,10,20,\nbroken line\n');
        expect(seen[2]).toEqual({ provider: 'openai', up: 20, down: 10 });
    });
    it('recognises the two providers by host and nothing else', () => {
        for (const host of ['api.anthropic.com', 'claude.ai', 'statsig.anthropic.com', 'CLAUDE.AI']) expect(providerOfHost(host)).toBe('claude');
        for (const host of ['chatgpt.com', 'api.openai.com', 'ab.chatgpt.com', 'cdn.oaistatic.com']) expect(providerOfHost(host)).toBe('openai');
        for (const host of ['', 'example.com', 'notanthropic.com', 'chatgpt.com.evil.example', 'openai.com.cn', '20.190.1.1']) expect(providerOfHost(host)).toBeNull();
    });
    it('turns connection snapshots into deltas without counting what was sent before it looked', () => {
        const track = createConnectionTracker();
        const conn = (id: string, host: string, upload: number, download: number) => ({ id, upload, download, metadata: { host } });
        // Already open at the first look: only growth from here counts.
        expect(track([conn('a', 'api.anthropic.com', 100 * MB, 3 * MB), conn('x', 'example.com', 5, 5)])).toEqual([]);
        expect(track([conn('a', 'api.anthropic.com', 104 * MB, 3.5 * MB), conn('b', 'chatgpt.com', 2 * MB, MB)]))
            .toEqual([{ provider: 'claude', up: 4 * MB, down: 0.5 * MB }, { provider: 'openai', up: 2 * MB, down: MB }]);
        // Closed connections are forgotten; a reused id starts again from nothing.
        expect(track([conn('b', 'chatgpt.com', 2 * MB, MB)])).toEqual([]);
        expect(track([conn('a', 'api.anthropic.com', MB, 0)])).toEqual([{ provider: 'claude', up: MB, down: 0 }]);
        // The sniffed host stands in when there is no host, and a counter that went backwards adds nothing.
        expect(track([{ id: 'c', upload: 10, download: 0, metadata: { sniffHost: 'claude.ai' } }, conn('a', 'api.anthropic.com', 5, 0)])).toEqual([{ provider: 'claude', up: 10, down: 0 }]);
    });
    it('finds the proxy core pipe and its secret from the command line', () => {
        const command = '"C:\\\\ProgramData\\\\clash-verge-service\\\\cores\\\\verge-mihomo.exe" -d "C:\\\\ProgramData\\\\x" -f "C:\\\\ProgramData\\\\x\\\\runtime\\\\config.yaml" -ext-ctl-pipe \\\\\\\\.\\\\pipe\\\\verge-mihomo-production-abc';
        expect(parseProxyCoreCommand(command, () => 'mixed-port: 7897\nsecret: "s3cret"\n')).toEqual({ pipe: '\\\\\\\\.\\\\pipe\\\\verge-mihomo-production-abc', secret: 's3cret' });
        expect(parseProxyCoreCommand(command, () => { throw new Error('unreadable'); })?.secret).toBe('');
        expect(parseProxyCoreCommand('verge-mihomo.exe -f config.yaml', () => '')).toBeNull();
    });
    it('finds the macOS proxy core socket, and tells engine connections from the rest', () => {
        const command = '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo -d /Users/u/Library/Application Support/x -f /Users/u/Library/Application Support/x/clash-verge.yaml -ext-ctl-unix /tmp/verge/verge-mihomo.sock';
        const read = vi.fn(() => 'mixed-port: 7897\n');
        expect(parseProxyCoreCommand(command, read)).toEqual({ pipe: '/tmp/verge/verge-mihomo.sock', secret: '' });
        expect(read).toHaveBeenCalledWith('/Users/u/Library/Application Support/x/clash-verge.yaml');
        const from = (process: string, processPath: string) => ({ id: 'a', upload: 0, download: 0, metadata: { host: 'chatgpt.com', process, processPath } });
        expect(isEngineConnection(from('codex', '/Users/u/.lmc/agent/runtime-releases/codex-0.162.0/vendor/bin/codex'))).toBe(true);
        expect(isEngineConnection(from('2.1.285', '/Users/u/.local/share/claude/versions/2.1.285'))).toBe(true);
        expect(isEngineConnection(from('Google Chrome Helper', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper'))).toBe(false);
        expect(isEngineConnection(from('ChatGPT for Chrome', '/Users/u/.codex/plugins/cache/chrome/ChatGPT for Chrome'))).toBe(false);
        expect(isEngineConnection(from('Claude', '/Applications/Claude.app/Contents/MacOS/Claude'))).toBe(false);
        // The core leaves the engines' own connections unnamed.
        expect(isEngineConnection(from('', ''))).toBe(true);
        expect(isEngineConnection({ id: 'n', upload: 0, download: 0, metadata: { host: 'chatgpt.com' } })).toBe(true);
        const track = createConnectionTracker(isEngineConnection);
        track([]);
        expect(track([{ ...from('codex', '/x/bin/codex'), id: 'e', upload: 5, download: 7 }, { ...from('Google Chrome Helper', '/x/Google Chrome Helper'), id: 'b', upload: 9, download: 9 }]))
            .toEqual([{ provider: 'openai', up: 5, down: 7 }]);
    });
    it('on macOS trusts the proxy core alone while it carries all traffic, and the process sampler otherwise', async () => {
        vi.useFakeTimers();
        const dir = mkdtempSync(join(tmpdir(), 'lmc-ai-traffic-')), file = join(dir, 'ai-traffic.json');
        try {
            const day = localDay(Date.now());
            let emit!: (delta: TrafficDelta) => void, capturesAll = true;
            const engine = (upload: number) => [{ id: 'e', upload, download: 0, metadata: { host: 'api.anthropic.com', process: 'claude', processPath: '/x/claude' } },
                { id: 'b', upload: upload * 10, download: 0, metadata: { host: 'claude.ai', process: 'Google Chrome Helper', processPath: '/x/Google Chrome Helper' } }];
            let snapshot = engine(0);
            const stop = startAiTraffic({ file, publish: async () => {}, platform: 'darwin', flushMs: 1000, pollMs: 500,
                startProcessSampler: onDelta => { emit = onDelta; return () => {}; }, pollConnections: async () => snapshot, proxyCapturesAll: async () => capturesAll });
            await vi.advanceTimersByTimeAsync(0);
            const claudeUp = () => JSON.parse(readFileSync(file, 'utf8')).days[day].claude.up;
            // The core reports the engine's bytes; the same bytes seen by the sampler are not added again, and the browser's never are.
            snapshot = engine(4 * MB);
            emit({ provider: 'claude', up: 4 * MB, down: 0 });
            await vi.advanceTimersByTimeAsync(1000);
            expect(claudeUp()).toBe(4 * MB);
            // Virtual interface off: direct flows are the sampler's to count again.
            capturesAll = false;
            await vi.advanceTimersByTimeAsync(500);
            emit({ provider: 'claude', up: MB, down: 0 });
            await vi.advanceTimersByTimeAsync(1000);
            expect(claudeUp()).toBe(5 * MB);
            stop();
        } finally { rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); }
    });
    it('adds up by local day, repairs bad stored numbers and keeps a bounded history', () => {
        const ledger = createTrafficLedger({ '2026-10-07': { claude: { up: 10, down: 1 }, openai: { up: -5 as number, down: Number.NaN } }, 'junk': {} as never });
        const noon = new Date(2026, 9, 8, 12).getTime();
        ledger.add({ provider: 'claude', up: 100, down: 5 }, noon);
        ledger.add({ provider: 'openai', up: 7, down: 9 }, noon + 1000);
        ledger.add({ provider: 'claude', up: 1, down: 1 }, new Date(2026, 9, 9, 0, 0, 1).getTime());
        expect(ledger.days()).toEqual({
            '2026-10-07': { claude: { up: 10, down: 1 }, openai: { up: 0, down: 0 } },
            '2026-10-08': { claude: { up: 100, down: 5 }, openai: { up: 7, down: 9 } },
            '2026-10-09': { claude: { up: 1, down: 1 }, openai: { up: 0, down: 0 } },
        });
        expect(localDay(noon)).toBe('2026-10-08');
        expect(Object.keys(ledger.recent(2))).toEqual(['2026-10-08', '2026-10-09']);
        for (let i = 0; i < AI_TRAFFIC_KEEP_DAYS + 20; i++) ledger.add({ provider: 'claude', up: 1, down: 0 }, noon + (i + 2) * 86400000);
        expect(Object.keys(ledger.days())).toHaveLength(AI_TRAFFIC_KEEP_DAYS);
    });
    it('keeps the ledger on disk across restarts and publishes only for a megabyte of news', async () => {
        vi.useFakeTimers();
        const dir = mkdtempSync(join(tmpdir(), 'lmc-ai-traffic-')), file = join(dir, 'ai-traffic.json');
        try {
            const day = localDay(Date.now());
            writeFileSync(file, JSON.stringify({ version: 1, days: { [day]: { claude: { up: 5 * MB, down: 0 }, openai: { up: 0, down: 0 } } } }));
            const publish = vi.fn(async (_traffic: AiTraffic) => {});
            let emit!: (delta: TrafficDelta) => void;
            let snapshot = [{ id: 'a', upload: 0, download: 0, metadata: { host: 'chatgpt.com' } }];
            const stop = startAiTraffic({ file, publish, platform: 'linux', flushMs: 1000, pollMs: 500, startProcessSampler: onDelta => { emit = onDelta; return () => {}; }, pollConnections: async () => snapshot });
            await vi.advanceTimersByTimeAsync(0);
            // What was already on disk is published once at start.
            expect(publish).toHaveBeenCalledTimes(1);
            expect(publish.mock.calls[0][0].days[day].claude.up).toBe(5 * MB);
            emit({ provider: 'claude', up: 200 * 1024, down: 10 });
            await vi.advanceTimersByTimeAsync(1000);
            // Written to disk, but too little to rewrite shared state.
            expect(JSON.parse(readFileSync(file, 'utf8')).days[day].claude.up).toBe(5 * MB + 200 * 1024);
            expect(publish).toHaveBeenCalledTimes(1);
            snapshot = [{ id: 'a', upload: 3 * MB, download: MB, metadata: { host: 'chatgpt.com' } }];
            await vi.advanceTimersByTimeAsync(1000);
            expect(publish).toHaveBeenCalledTimes(2);
            expect(publish.mock.calls[1][0].days[day]).toEqual({ claude: { up: 5 * MB + 200 * 1024, down: 10 }, openai: { up: 3 * MB, down: MB } });
            // A failed publish is tried again; the count is not lost.
            publish.mockRejectedValueOnce(new Error('offline'));
            emit({ provider: 'claude', up: 2 * MB, down: 0 });
            await vi.advanceTimersByTimeAsync(1000); expect(publish).toHaveBeenCalledTimes(3);
            await vi.advanceTimersByTimeAsync(1000); expect(publish).toHaveBeenCalledTimes(4);
            emit({ provider: 'openai', up: 1, down: 1 });
            stop();
            expect(JSON.parse(readFileSync(file, 'utf8')).days[day].openai).toEqual({ up: 3 * MB + 1, down: MB + 1 });
            await vi.advanceTimersByTimeAsync(5000); expect(publish).toHaveBeenCalledTimes(4);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});

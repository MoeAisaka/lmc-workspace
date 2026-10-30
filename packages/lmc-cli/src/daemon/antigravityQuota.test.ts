import { describe, it, expect, vi } from 'vitest';
import { projectAgyQuota, createAgyQuotaReader } from './antigravityQuota';
import { applyQuotaConfiguration, projectAccountQuota } from './accountQuota';
const now = Date.now();
const raw = () => ({ status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { project_id: 'SECRET', groups: [
    { name: 'Gemini Models', buckets: [{ window: 'weekly', remaining_fraction: 0, reset_time: '2027-01-01T00:00:00Z' }] },
    { name: 'Claude and GPT models', buckets: [{ window: '5h', remaining_fraction: 0.75, reset_time: '2027-01-01T00:00:00Z' }] },
] } } });
describe('Antigravity quota', () => {
    it('keeps independent pools and true zero; never copies identities', () => {
        const p = projectAgyQuota(raw(), now);
        expect(p.status).toBe('ready'); expect(p.windows).toEqual([]);
        expect(p.groups?.map(g => [g.id, g.windows[0].remaining])).toEqual([['gemini', 0], ['claude_gpt', 75]]);
        expect(JSON.stringify(p)).not.toContain('SECRET');
    });
    it('fails malformed responses and unknown schema closed', () => {
        expect(projectAgyQuota({status:'SUCCESS',response:'100%'}).status).toBe('unavailable');
        const d=raw();d.command.data.groups[0].buckets[0].remaining_fraction=2;
        expect(projectAgyQuota(d).groups?.[0].windows[0].remaining).toBeNull();
        d.num_turns=1; expect(projectAgyQuota(d).status).toBe('unavailable');
    });
    it('reports regional/auth errors without raw messages or manufactured quota', () => {
        const p=projectAgyQuota({status:'ERROR',error:'Eligibility check failed: not available in your location SECRET'});
        expect(p.status).toBe('region_restricted');expect(p.capturedAt).toBeNull();expect(p.groups).toEqual([]);
        expect(JSON.stringify(p)).not.toContain('SECRET');
        expect(projectAgyQuota({status:'ERROR',error:'Please sign in'}).status).toBe('sign_in_required');
    });
    it('hides only explicitly disabled services, not transient failures, and supports reactivation', () => {
        const p=projectAccountQuota(null);p.providers.push(projectAgyQuota(raw()));
        expect(applyQuotaConfiguration(p,{claude:{enabled:false},agy:{enabled:true,plan:'Ultra 20x'}}).providers.map(p=>p.engine)).toEqual(['codex','agy']);
        expect(applyQuotaConfiguration(p,{claude:{enabled:true}}).providers).toHaveLength(3);
    });
    it('coalesces polling and caches unavailable as well as successful responses', async () => {
        const run=vi.fn().mockResolvedValue({status:'ERROR'}), read=createAgyQuotaReader(run);
        await Promise.all([read(),read()]);await read();expect(run).toHaveBeenCalledTimes(1);
    });
});

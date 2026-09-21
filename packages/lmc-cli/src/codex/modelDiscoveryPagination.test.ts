import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from './codexAppServerClient';
describe('model/list pagination', () => {
    it('reads every page, including hidden models, without starting a thread', async () => {
        const client = new CodexAppServerClient();
        const request = vi.fn().mockResolvedValueOnce({data:[{model:'first'}],nextCursor:'next'}).mockResolvedValueOnce({data:[{model:'hidden'}],nextCursor:null});
        (client as any).request = request;
        expect(await client.listModels()).toEqual([{model:'first'},{model:'hidden'}]);
        expect(request.mock.calls.map(call=>call[0])).toEqual(['model/list','model/list']);
        expect(request.mock.calls[1][1]).toMatchObject({cursor:'next',includeHidden:true});
    });
    it('rejects repeated cursors instead of looping', async () => {
        const client = new CodexAppServerClient();
        (client as any).request = vi.fn().mockResolvedValue({data:[],nextCursor:'same'});
        await expect(client.listModels()).rejects.toThrow('Repeated');
    });
});

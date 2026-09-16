import { expect, it, vi } from 'vitest';
import { sendPushNotifications } from '@/app/push/pushSend';
it('does not contact a native push provider',async()=>{const fetch=vi.fn();vi.stubGlobal('fetch',fetch);try{const result=await sendPushNotifications([{to:'synthetic-token'}]);expect(fetch).not.toHaveBeenCalled();expect(result[0].status).toBe('error');}finally{vi.unstubAllGlobals();}});

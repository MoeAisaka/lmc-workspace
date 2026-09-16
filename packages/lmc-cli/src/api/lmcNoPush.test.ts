import { expect, it, vi } from 'vitest';
import axios from 'axios';
import { PushNotificationClient } from './pushNotifications';
it('never sends native notifications or requests upstream tokens',async()=>{
 const get=vi.spyOn(axios,'get'),post=vi.spyOn(axios,'post');
 const client=new PushNotificationClient('synthetic');
 expect(await client.fetchPushTokens()).toEqual([]);
 await client.sendPushNotifications([{to:'synthetic'}]);
 client.sendToAllDevices('test');client.sendSessionNotification({kind:'done',metadata:null});
 expect(get).not.toHaveBeenCalled();expect(post).not.toHaveBeenCalled();vi.restoreAllMocks();
});

import {describe,it,expect,vi,beforeEach} from 'vitest';
const mocks=vi.hoisted(()=>({machine:{findFirst:vi.fn()},usageReport:{upsert:vi.fn(),deleteMany:vi.fn()}}));
vi.mock('@/storage/db',()=>({db:mocks}));
import {quotaHistoryHandler,quotaObservationId} from './quotaHistory';
const sample={machineId:'m',engine:'agy' as const,capturedAt:Date.now(),pools:[{id:'gemini' as const,windows:[]}]};
beforeEach(()=>{vi.resetAllMocks();mocks.machine.findFirst.mockResolvedValue({id:'m'});});
describe('quota history boundaries',()=>{
 it('deduplicates source/engine/five-minute bucket, isolates accounts',()=>{
  const aligned={...sample,capturedAt:Math.floor(sample.capturedAt/300000)*300000};
  expect(quotaObservationId('a',aligned)).toBe(quotaObservationId('a',{...aligned,capturedAt:aligned.capturedAt+1}));
  expect(quotaObservationId('a',aligned)).not.toBe(quotaObservationId('b',aligned));
 });
 it('rejects session sockets, wrong machines, old timestamps and non-owners',async()=>{
  for(const connection of [{connectionType:'session-scoped',machineId:'m'},{connectionType:'machine-scoped',machineId:'x'}]){
   let handler:any;const cb=vi.fn();quotaHistoryHandler('a',{...connection,socket:{on:(_:string,h:any)=>handler=h}} as any);
   await handler(sample,cb);expect(cb).toHaveBeenCalledWith({success:false});
  }
  let handler:any;const cb=vi.fn();quotaHistoryHandler('a',{connectionType:'machine-scoped',machineId:'m',socket:{on:(_:string,h:any)=>handler=h}} as any);
  await handler({...sample,capturedAt:1},cb);expect(cb).toHaveBeenLastCalledWith({success:false});
  mocks.machine.findFirst.mockResolvedValue(null);await handler(sample,cb);expect(cb).toHaveBeenLastCalledWith({success:false});expect(mocks.usageReport.upsert).not.toHaveBeenCalled();
 });
 it('stores immutable sanitized observations and only expires its own telemetry',async()=>{
  let handler:any;const cb=vi.fn();quotaHistoryHandler('a',{connectionType:'machine-scoped',machineId:'m',socket:{on:(_:string,h:any)=>handler=h}} as any);
  await handler({...sample,secret:'must disappear'},cb);expect(cb).toHaveBeenCalledWith({success:true});
  const request=mocks.usageReport.upsert.mock.calls[0][0];expect(request.update).toEqual({});expect(request.create.data.quota.secret).toBeUndefined();
  expect(mocks.usageReport.deleteMany.mock.calls[0][0].where).toMatchObject({accountId:'a',key:'q1:quota'});
 });
});

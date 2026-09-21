import { it, expect } from 'vitest';
import { codexUsageLimits } from './usageLimits';
it('maps live provider percentages and resets without inventing windows', () => {
 const result=codexUsageLimits({rateLimits:{limitId:'codex',primary:{usedPercent:42,windowDurationMins:300,resetsAt:1800000000},secondary:{usedPercent:91,windowDurationMins:10080}}});
 expect(result?.windows).toEqual([
 {id:'five_hour',utilization:42,status:'allowed',resetsAt:1800000000000},
 {id:'seven_day',utilization:91,status:'allowed_warning',resetsAt:null}]);
 expect(codexUsageLimits({rateLimits:{limitId:'other'}})).toBeNull();
 expect(codexUsageLimits({rateLimits:{primary:{usedPercent:NaN,windowDurationMins:300}}})?.windows).toEqual([]);
});
it('selects the Codex bucket in multi-product responses',()=>{
 expect(codexUsageLimits({rateLimits:{limitId:'other'},rateLimitsByLimitId:{codex:{primary:{usedPercent:10,windowDurationMins:300}}}})?.windows[0].utilization).toBe(10);
});

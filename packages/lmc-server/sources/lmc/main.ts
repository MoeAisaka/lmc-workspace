import 'reflect-metadata';
import { db } from '@/storage/db';
import { lmcAuth } from './auth';
import { startApi } from '@/app/api/api';
import { initEncrypt } from '@/modules/encrypt';
import { loadFiles } from '@/storage/files';
import { startTimeout } from '@/app/presence/timeout';
import { activityCache } from '@/app/presence/sessionCache';
import { startDatabaseMetricsUpdater } from '@/app/monitoring/metrics2';
import { awaitShutdown, onShutdown } from '@/utils/shutdown';

async function main() {
await lmcAuth.init();
process.env.HANDY_MASTER_SECRET=process.env.LMC_MASTER_KEY;
await db.$connect();await initEncrypt();await loadFiles();
onShutdown('lmc-db',()=>db.$disconnect());
onShutdown('lmc-activity',async()=>activityCache.shutdown());
// Loopback by default: bare-metal centers stay behind the operator's reverse
// proxy. In a container there is no loopback to share, so compose sets this to
// 0.0.0.0 and publishes the port on the host's loopback instead.
await startApi({host:process.env.LMC_BIND_HOST||'127.0.0.1',port:Number(process.env.PORT||4193),staticDir:process.env.LMC_WEB_DIR,injectHtmlConfig:{serverUrl:process.env.LMC_PUBLIC_ORIGIN,disableAnalytics:true}});
startTimeout();startDatabaseMetricsUpdater();
await awaitShutdown();
}

// Exit only after all shutdown hooks complete; libraries can retain idle timers.
main().then(() => process.exit(0), error => {
    console.error('LMC center failed:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
});

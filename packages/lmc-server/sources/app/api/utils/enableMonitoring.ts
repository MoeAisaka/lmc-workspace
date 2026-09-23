import { db } from "@/storage/db";
import { Fastify } from "../types";
import { httpRequestsCounter, httpRequestDurationHistogram, getMetricsLabelsFromRequest } from "@/app/monitoring/metrics2";
import { debug } from "@/utils/log";
import { recordProductionRequest, startProductionLogSummary } from "@/app/monitoring/productionLogSummary";
import { performance } from 'node:perf_hooks';

export function enableMonitoring(app: Fastify) {
    const stopProductionLogSummary = startProductionLogSummary();
    app.addHook('onClose', async () => stopProductionLogSummary());
    // Log stalls after recovery; the independent service launcher probes while
    // this event loop is blocked. No request bodies or filesystem paths logged.
    let previousTick = performance.now();
    const loopMonitor = setInterval(() => {
        const now = performance.now();
        const delayMs = Math.round(now - previousTick - 1000);
        previousTick = now;
        if (delayMs > 1000) console.warn(`[event-loop] stalled delayMs=${delayMs}`);
    }, 1000);
    (loopMonitor as unknown as NodeJS.Timeout).unref();
    app.addHook('onClose', async () => clearInterval(loopMonitor));

    // Add metrics hooks
    app.addHook('onRequest', async (request, reply) => {
        request.startTime = Date.now();
    });

    app.addHook('onResponse', async (request, reply) => {
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;
        const method = request.method;
        // Use routeOptions.url for the route template, fallback to parsed URL path
        const route = request.routeOptions?.url || request.url.split('?')[0] || 'unknown';
        const status = reply.statusCode.toString();
        const labels = getMetricsLabelsFromRequest(request);

        // Increment request counter
        httpRequestsCounter.inc({ method, route, status, ...labels });

        // Record request duration
        httpRequestDurationHistogram.observe({ method, route, status, ...labels }, duration);
        recordProductionRequest({
            method,
            route: request.routeOptions?.url || '<unmatched>',
            statusCode: reply.statusCode,
            durationMs: duration * 1_000,
        });
    });

    app.get('/health', async (request, reply) => {
        try {
            // Test database connectivity
            await db.$queryRaw`SELECT 1`;
            reply.send({
                status: 'ok',
                timestamp: new Date().toISOString(),
                service: 'happy-server'
            });
        } catch (error) {
            debug({ module: 'health' }, `health:database-check-failed error=${error}`);
            reply.code(503).send({
                status: 'error',
                timestamp: new Date().toISOString(),
                service: 'happy-server',
                error: 'Database connectivity failed'
            });
        }
    });
}

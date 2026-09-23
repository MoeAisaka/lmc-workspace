// Runs in the service launcher, outside the center's event loop. Observation
// only: never restart a center or terminate active provider sessions.
const http = require('node:http');

function watchServiceHealth({ port = 4193, intervalMs = 15000, timeoutMs = 5000, report = console.warn } = {}) {
    let active = null;
    let stopped = false;
    let unhealthySince = null;
    const check = () => {
        if (active || stopped) return;
        let finished = false;
        let deadline;
        const done = (ok, reason) => {
            if (finished) return;
            finished = true;
            clearTimeout(deadline);
            active = null;
            if (stopped) return;
            if (!ok && unhealthySince === null) {
                unhealthySince = Date.now();
                report(JSON.stringify({ time: new Date().toISOString(), event: 'lmc-health-failed', reason }));
            } else if (ok && unhealthySince !== null) {
                report(JSON.stringify({ time: new Date().toISOString(), event: 'lmc-health-recovered', outageMs: Date.now() - unhealthySince }));
                unhealthySince = null;
            }
        };
        const request = http.get({ host: '127.0.0.1', port, path: '/health', agent: false }, response => {
            response.resume();
            response.on('end', () => done(response.statusCode === 200, `HTTP ${response.statusCode}`));
            response.on('error', () => done(false, 'response interrupted'));
        });
        active = request;
        request.on('error', () => done(false, 'connection failed'));
        deadline = setTimeout(() => { done(false, 'timeout'); request.destroy(); }, timeoutMs);
        deadline.unref();
    };
    const timer = setInterval(check, intervalMs);
    timer.unref();
    return () => { stopped = true; clearInterval(timer); active?.destroy(); };
}
module.exports = { watchServiceHealth };

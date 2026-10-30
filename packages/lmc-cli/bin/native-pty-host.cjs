// One native PTY per helper. ConPTY's worker handles must not accumulate in
// the long-lived Agent runner. No CLI code, configuration or identity is patched.
let terminal;
let paused = true;
let exited = false;
let readyTimer;
function send(message, callback) {
    if (process.connected) process.send(message, () => callback?.());
    else callback?.();
}
process.on('message', message => {
    try {
        if (message?.type === 'start' && !terminal) {
            if (require('node:path').isAbsolute(message.executable)) require('node:fs').accessSync(message.executable);
            const pty = require('@lydell/node-pty');
            terminal = pty.spawn(message.executable, message.args, {
                ...message.options, env: process.env,
                ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
            });
            terminal.pause();
            let ready = false;
            const reportReady = () => {
                // ConPTY connects asynchronously; its PID is initially -1.
                if (!ready && terminal.pid > 0) {
                    ready = true; clearInterval(readyTimer);
                    send({ type: 'ready', pid: terminal.pid });
                }
            };
            readyTimer = setInterval(reportReady, 10);
            reportReady();
            terminal.onData(data => {
                reportReady();
                terminal.pause();
                send({ type: 'data', data }, () => { if (!paused && !exited) terminal.resume(); });
            });
            terminal.onExit(result => {
                reportReady(); clearInterval(readyTimer);
                exited = true;
                // Exit only the helper, after the official CLI's real exit.
                // Closing the process releases ConPTY workers and handles.
                send({ type: 'exit', result }, () => process.exit(0));
            });
        } else if (terminal && !exited) {
            if (message?.type === 'write') terminal.write(message.data);
            else if (message?.type === 'pause') { paused = true; terminal.pause(); }
            else if (message?.type === 'resume') { paused = false; terminal.resume(); }
        }
    } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : 'Native terminal failed' },
            () => { if (!terminal) process.exit(1); });
    }
});
process.on('disconnect', () => {
    // Loss of the UI/controller is not permission to interrupt native work.
    // Drain output and let the CLI reach its own exit.
    paused = false;
    if (terminal && !exited) terminal.resume();
    else if (!terminal) process.exit(0);
});

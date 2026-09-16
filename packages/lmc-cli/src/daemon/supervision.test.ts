import { describe, expect, it } from 'vitest';
import { SUPERVISED_DAEMON_ARGS, SUPERVISED_FLAG, startedBySupervisor } from './supervision';
import { sanitizeSessionEnvironment } from './sessionEnvironment';

describe('daemon supervision signal', () => {
    it('recognises only the service manager\'s own invocation', () => {
        expect(startedBySupervisor(['node', 'index.mjs', 'daemon', 'start-sync', SUPERVISED_FLAG])).toBe(true);
        expect(startedBySupervisor(['node', 'index.mjs', 'daemon', 'start-sync'])).toBe(false);
        expect(startedBySupervisor([])).toBe(false);
    });

    it('keeps the flag in the arguments the launchd job is installed with', () => {
        expect([...SUPERVISED_DAEMON_ARGS]).toEqual(['daemon', 'start-sync', SUPERVISED_FLAG]);
    });

    it('strips the inherited launchd variable so a child cannot claim supervision', () => {
        const child = sanitizeSessionEnvironment({ XPC_SERVICE_NAME: 'com.example.lmc-agent', PATH: '/usr/bin' });
        expect('XPC_SERVICE_NAME' in child).toBe(false);
        expect(child.PATH).toBe('/usr/bin');
    });
});

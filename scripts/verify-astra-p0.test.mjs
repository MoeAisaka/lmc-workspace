import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecks } from './verify-astra-p0.mjs';

test('stops at a failing process before any later check can run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astra-verifier-'));
    try {
        const marker = join(dir, 'must-not-exist');
        const result = runChecks([
            { name: 'fails', cwd: dir, args: ['-e', 'process.exit(7)'] },
            { name: 'later', cwd: dir, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] },
        ]);
        assert.equal(result, 7);
        assert.equal(existsSync(marker), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reports success only when every process finishes successfully', () => {
    assert.equal(runChecks([
        { name: 'one', cwd: process.cwd(), args: ['-e', 'process.exit(0)'] },
        { name: 'two', cwd: process.cwd(), args: ['-e', 'process.exit(0)'] },
    ]), 0);
});

test('treats failure to start a check as failure', () => {
    assert.equal(runChecks([{ name: 'bad cwd', cwd: '/nonexistent-astra-verification-directory', args: ['-e', 'process.exit(0)'] }]), 1);
});

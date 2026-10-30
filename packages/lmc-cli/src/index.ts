#!/usr/bin/env node
// Importing the package must never authenticate, register, or start an engine.
// Keep the heavyweight command graph behind the actual executable boundary.
import { projectPath } from './projectPath';
import { isCliEntrypoint } from './utils/cliEntrypoint';

if (isCliEntrypoint(process.argv[1], projectPath())) {
    void import('./cli').then(({ runCli }) => runCli());
}

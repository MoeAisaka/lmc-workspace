/**
 * npm package names the CLI will accept for the bundled self-host server.
 *
 * Kept apart from server.ts so it can be asserted against the workspace without
 * importing the command module, which pulls in configuration as a side effect.
 */

/** Current name — the one shown in messages and install instructions. */
export const SERVER_PACKAGE_NAME = 'lmc-server-self-host';

/**
 * Resolution order, not just the current name: a machine that installed the
 * server before the rename still has it under the old name, and `lmc server`
 * should keep working there rather than reporting the server as missing.
 */
export const SERVER_PACKAGE_NAMES = [SERVER_PACKAGE_NAME, 'happy-server-self-host'] as const;

// Standalone local entry for first-time setup before the Agent rollout.
// Bundle with esbuild --bundle --platform=node --format=cjs --target=node22.
import { handlePoeCommand } from '../packages/lmc-cli/src/commands/poe';

handlePoeCommand(process.argv.slice(2).length ? process.argv.slice(2) : ['configure']).catch(() => {
    console.error('Poe operation failed. Check the API key, network and private configuration permissions; no key is displayed.');
    process.exitCode = 1;
});

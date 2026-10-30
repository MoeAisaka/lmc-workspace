import inquirer from 'inquirer';
import { readPoeSettings, savePoeSettings, fetchPoeJson } from '@/runtime/poe';
import { parsePoePoints } from '@/daemon/poeBalance';

/** Secrets are accepted only through a masked local TTY, never CLI arguments or RPC. */
export async function handlePoeCommand(args: string[]): Promise<void> {
    const action = args[0];
    if (args.length > 1) throw new Error('Poe does not accept keys in command arguments. Use lmc poe configure.');
    if (action === 'configure') {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run lmc poe configure in a local interactive terminal.');
        const { apiKey } = await inquirer.prompt<{ apiKey: string }>([{
            type: 'password', name: 'apiKey', message: 'Poe API key (https://poe.com/api/keys):', mask: '*',
            validate: value => typeof value === 'string' && /^[^\s\x00-\x1f\x7f]{8,4096}$/.test(value) || 'Enter a valid API key.',
        }]);
        const points = parsePoePoints(await fetchPoeJson('/usage/current_balance', apiKey));
        await savePoeSettings({ version: 1, enabled: true, apiKey });
        console.log(`Poe configured on this device. Balance: ${points.toLocaleString()} points. New LMC Claude sessions use Poe; active sessions are unchanged.`);
        return;
    }
    if (action === 'enable' || action === 'disable') {
        const settings = readPoeSettings();
        if (!settings) throw new Error('Configure Poe first with lmc poe configure.');
        await savePoeSettings({ ...settings, enabled: action === 'enable' });
        console.log(action === 'enable' ? 'New LMC Claude sessions use Poe.' : 'New LMC Claude sessions use their original provider configuration. Official Claude login may be required.');
        return;
    }
    if (action === 'status' || action === 'balance') {
        const settings = readPoeSettings();
        console.log(`Poe: ${settings ? settings.enabled ? 'enabled for new LMC Claude sessions' : 'configured, routing disabled' : 'not configured'}`);
        if (action === 'balance' && settings) console.log(`Balance: ${parsePoePoints(await fetchPoeJson('/usage/current_balance', settings.apiKey)).toLocaleString()} points`);
        return;
    }
    console.log('lmc poe configure | status | balance | enable | disable\nConfigure separately on each device. Keys stay on that device. Codex and official Claude credentials are not modified.');
}

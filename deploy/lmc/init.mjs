import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve(process.argv[2] || 'deploy/lmc');
const origin = new URL(process.argv[3] || 'http://127.0.0.1:4193');
if (origin.protocol !== 'https:' && !(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && origin.protocol === 'http:')) throw new Error('External origin must use HTTPS');
if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Supply an origin without credentials or path');
const password = randomBytes(32).toString('hex');
const values = {
    MYSQL_DATABASE: 'lmc', MYSQL_USER: 'lmc', MYSQL_PASSWORD: password,
    MYSQL_ROOT_PASSWORD: randomBytes(32).toString('hex'),
    LMC_MYSQL_PORT: '43316', DATABASE_URL: `mysql://lmc:${password}@127.0.0.1:43316/lmc`,
    LMC_MASTER_KEY: randomBytes(32).toString('hex'), LMC_PUBLIC_ORIGIN: origin.origin,
    PUBLIC_URL: origin.origin, PORT: '4193', DATA_DIR: resolve(directory, 'data'),
    LMC_WEB_DIR: resolve(directory, 'web'),
};
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(resolve(directory, '.env'), Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')+'\n', { flag:'wx', mode:0o600 });
console.log('Created a new private .env. Existing configuration is never overwritten.');

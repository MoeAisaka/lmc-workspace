# Deploying an LMC centre

The web client and every device agent connect to one centre backed by MySQL 8.4.
No hosted account and no phone app are involved.

## One command

Requirements: Node 22.18+, pnpm 10.11 (or corepack), Docker Compose.
From the repository root:

```sh
deploy/lmc/up.sh https://lmc.example.com
```

The script installs dependencies, builds the wire types and Prisma client, exports the web
bundle, writes `.env`, starts MySQL, builds the centre image, runs migrations, and — on the
first run — prompts you to create a sign-in.

Running the same command again is the update path. `.env` is never overwritten, and the web
bundle is exported beside the live one and swapped only after it is complete, so tabs open
during a deploy keep resolving their assets.

Add another sign-in:

```sh
deploy/lmc/up.sh --add-account
```

Stop, keeping volumes:

```sh
docker compose --env-file deploy/lmc/.env -f deploy/lmc/compose.yaml stop
```

## What the stack looks like

`compose.yaml` defines two services: MySQL and the centre. The centre is built from
`Dockerfile.server` at the repository root and runs `restart: unless-stopped`, so it comes
back after a reboot.

Inside its container the centre listens on `0.0.0.0` (`LMC_BIND_HOST`), but the port is
published to the host's `127.0.0.1` only — it is never exposed directly. Running the centre
on bare metal instead, `LMC_BIND_HOST` still defaults to `127.0.0.1`.

**The script does not put you on the internet.** Bring your own domain, certificate and
reverse proxy, forward to `127.0.0.1:PORT`, and preserve `Host`, `Origin` and the WebSocket
upgrade. `LMC_PUBLIC_ORIGIN` and `PUBLIC_URL` must be the HTTPS origin a browser actually
uses, including a non-default port. Do not expose the database.

On a port clash, change `LMC_MYSQL_PORT`, `DATABASE_URL` and `PORT` in `.env` together,
before starting.

### Two build decisions worth knowing

Both cost real debugging time to arrive at:

- **The web bundle is baked into the image** (`/srv/web`) and runtime data lives in the named
  volume `center-data` (`/srv/data`). Neither uses a host bind mount: on macOS, Docker Desktop
  shares only some paths, and a repository on an external drive silently mounts as an *empty*
  directory — the centre then serves nothing but 404s. The cost is that updating the web
  bundle requires rebuilding the image and restarting the centre; `up.sh` already does both.
- **The image installs the server only** (`--filter lmc-server... --config.node-linker=isolated`).
  The repository's `.npmrc` sets `node-linker=hoisted` for the app, and a hoisted install is
  workspace-wide by nature — it would drag the Anthropic SDK, Skia, Electron and Expo into the
  image. Do not "fix" this with a multi-stage `COPY` of `node_modules` either: pnpm's hard
  links are materialised across stages, turning a few GB into enough to fill the disk.

## Accounts and keys

Passwords are at least 12 characters. There is no public sign-up endpoint. Passwords are
hashed with scrypt; persistent login is an HttpOnly/SameSite cookie; device authorisations are
revocable from the account page.

Account encryption keys are stored by the centre, encrypted with `LMC_MASTER_KEY`. **That puts
the centre operator inside the trust boundary.** When you back up the database, store that
master key separately and safely — losing it makes the accounts unrecoverable, and rotating it
casually has the same effect.

## Manual steps

`up.sh` is equivalent to the sequence below. Run it by hand only to debug an individual step,
or to run the centre outside a container.

```sh
pnpm install --frozen-lockfile
pnpm --filter lmc-wire build
pnpm --filter lmc-server generate
pnpm --filter link-my-cli typecheck
pnpm --filter link-my-cli exec pkgroll
pnpm --filter lmc-app exec tsc --noEmit
APP_ENV=production EXPO_PUBLIC_DISABLE_ANALYTICS=1 pnpm --filter lmc-app exec expo export \
  --platform web --output-dir ../../deploy/lmc/web --max-workers 2
node deploy/lmc/init.mjs deploy/lmc https://lmc.example.com
docker compose --env-file deploy/lmc/.env -f deploy/lmc/compose.yaml up -d --wait mysql
cd packages/lmc-server
node --env-file=../../deploy/lmc/.env ../../node_modules/prisma/build/index.js migrate deploy
node --env-file=../../deploy/lmc/.env --import tsx sources/lmc/setup.ts
# reads {"username":"...","password":"..."} from stdin; send EOF when done.
node --env-file=../../deploy/lmc/.env --import tsx sources/lmc/main.ts
```

`init.mjs` only creates a new `.env`; it refuses to overwrite an existing one.

## Connecting a device agent

```sh
export LMC_HOME_DIR="$HOME/.lmc/agent"
export LMC_SERVER_URL="https://lmc.example.com"
export LMC_WEBAPP_URL="$LMC_SERVER_URL"
lmc auth login
lmc daemon start
# or start an engine directly
lmc codex
lmc claude
```

Sign in through the browser and approve the link the CLI opens, or paste the same centre's
pairing link from account settings.

If you also have upstream Happy installed, keep the two apart: run this checkout as
`node packages/lmc-cli/bin/happy.mjs`, or give that one file its own `lmc` entry point.
Do not put this repository's `bin` directory ahead of an existing `happy` command, and do not
copy Happy's `access.key`, `settings.json`, device identity or private session directories.

## Updating and rolling back

Re-run `deploy/lmc/up.sh <same origin>`. The web bundle is exported to `web-next` and only
replaces `web` once it has produced an `index.html`, so a failed export never leaves half a
bundle behind. The centre then rebuilds, migrates and restarts — connections drop briefly.
Let an agent finish its current turn before updating it.

To roll back, stop this centre, its agents and the `lmc-center` compose project.
`docker compose stop` keeps volumes. **Do not `down -v`.**

Migrating historical data is a separate exercise: inventory the old accounts and their
encryption variants, export only what you are authorised to, convert IDs / seq / versions /
ownership and verify both the counts and that ciphertext still decrypts, read-verify on both
ends, stop writes, cut over, and keep the old entry point available to roll back to.
`init.mjs` migrates nothing and takes over nothing.

---

[中文说明](README.zh-CN.md)

### Trusted reverse proxies

Login rate limits use the client IP. By default only loopback proxies
(`127.0.0.1/32,::1/128`) may supply forwarded addresses. For a container network,
set `LMC_TRUSTED_PROXIES` to the actual proxy address/CIDR (comma-separated).
An empty value disables proxy trust. Do not use a catch-all CIDR; configure the
proxy to overwrite forwarded headers from untrusted clients.

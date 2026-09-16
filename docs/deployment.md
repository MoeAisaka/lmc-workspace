# Deployment

How to run the LMC centre (`packages/lmc-server`) and what it expects around it.

**For the supported path, start with [`deploy/lmc/README.md`](../deploy/lmc/README.md)** —
one command brings up MySQL and the centre with Docker Compose. This page is the
reference behind it: what each service is for, and every environment variable the
centre reads.

## Runtime overview

- **Centre:** Node.js running `tsx sources/lmc/main.ts` (Fastify + Socket.IO).
- **Database:** MySQL 8.4 via Prisma (`provider = "mysql"` in `prisma/schema.prisma`).
- **Cache / fan-out:** Redis — **optional**, see below.
- **Object storage:** optional; falls back to the local filesystem.
- **Metrics:** optional Prometheus endpoint on a separate port.

## Services

### MySQL — required

All persisted data. Configure with `DATABASE_URL`. The Compose stack in `deploy/lmc/`
runs `mysql:8.4` and publishes it on loopback only.

### Redis — optional

Only needed to fan out Socket.IO events **across multiple centre processes**: the
adapter is attached in `sources/app/api/socket.ts` when `REDIS_URL` is set, and skipped
entirely when it is not. A single-process centre — which is what the Compose stack runs
— needs no Redis at all.

> Upstream's `sources/main.ts` pings Redis at startup and treats it as required. The LMC
> entry point (`sources/lmc/main.ts`) does not.

### S3-compatible storage — optional

Used for avatars and uploaded assets. Configure with `S3_HOST`, `S3_PORT`,
`S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL`, `S3_USE_SSL`.
**If `S3_HOST` is unset the centre stores files on local disk** (`./data/files/`), which
is what the Compose stack does — the named volume `center-data` holds them.

## Environment variables

### Required

| Variable | What it is |
|---|---|
| `DATABASE_URL` | MySQL connection string |
| `LMC_MASTER_KEY` | 32 random bytes, hex. Seals account secrets and feeds `HANDY_MASTER_SECRET`. `deploy/lmc/init.mjs` generates it |
| `LMC_PUBLIC_ORIGIN` | The HTTPS origin a browser actually uses, including a non-default port |

**Back up `LMC_MASTER_KEY` separately from the database.** Losing it makes the accounts
unrecoverable; rotating it casually does the same.

### Common

| Variable | Default | What it is |
|---|---|---|
| `PORT` | `3005` | API port. The Compose stack sets `4193` |
| `LMC_BIND_HOST` | `127.0.0.1` | Compose sets `0.0.0.0` inside the container and publishes to the host's loopback |
| `LMC_WEB_DIR` | — | Directory the built web bundle is served from |
| `DATA_DIR` | — | Runtime data (local file storage, logs) |
| `REDIS_URL` | unset | Enables the multi-process Socket.IO adapter |
| `METRICS_ENABLED` / `METRICS_PORT` | `9090` | Prometheus endpoint |

### Optional integrations

These are upstream features that LMC does not wire up; the variables are still read if
you set them.

- GitHub OAuth/App: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`,
  `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_REDIRECT_URL` (OAuth callback),
  `GITHUB_REDIRECT_URI` (App initializer).
- Voice: `ELEVENLABS_API_KEY`. Subscriptions: `REVENUECAT_API_KEY`.
- `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING` — file logging plus a dev log
  endpoint. The name is accurate; do not set it in production.

## Docker image

`Dockerfile.server` at the repository root builds the centre. `deploy/lmc/up.sh` builds
it for you.

- The centre defaults to port `3005`; set `PORT` explicitly in containers.
- The image carries FFmpeg and Python for media processing.
- It installs the server workspace only (`--filter lmc-server... --config.node-linker=isolated`).
  See [`deploy/lmc/README.md`](../deploy/lmc/README.md) for why that flag matters and why
  a multi-stage `COPY` of `node_modules` is the wrong fix.

## Putting it on the internet

The centre publishes on loopback. Terminate TLS in your own reverse proxy and forward
`Host`, `Origin` and the WebSocket upgrade to it. Do not expose MySQL.

## Migrations

`prisma migrate deploy` runs against `DATABASE_URL`. `deploy/lmc/up.sh` runs it after the
database is healthy and before the centre starts, and a failed migration stops the deploy
rather than starting a centre against a half-migrated schema.

## Implementation references

- Entry point: `packages/lmc-server/sources/lmc/main.ts`
- Socket layer and the Redis adapter: `packages/lmc-server/sources/app/api/socket.ts`
- Account sealing: `packages/lmc-server/sources/lmc/auth.ts`
- Schema: `packages/lmc-server/prisma/schema.prisma`

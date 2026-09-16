# Standalone happy-server: single container, no external dependencies
# Uses PGlite (embedded Postgres), local filesystem storage, no Redis

# Stage 1: install dependencies
FROM node:20 AS deps

RUN apt-get update && apt-get install -y python3 make g++ build-essential && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY scripts ./scripts
COPY patches ./patches

RUN mkdir -p packages/lmc-app packages/lmc-server packages/lmc-cli packages/lmc-agent packages/lmc-wire

COPY packages/lmc-app/package.json packages/lmc-app/
COPY packages/lmc-server/package.json packages/lmc-server/
COPY packages/lmc-cli/package.json packages/lmc-cli/
COPY packages/lmc-agent/package.json packages/lmc-agent/
COPY packages/lmc-wire/package.json packages/lmc-wire/

# Workspace postinstall requirements
COPY packages/lmc-app/patches packages/lmc-app/patches
COPY packages/lmc-server/prisma packages/lmc-server/prisma
COPY packages/lmc-cli/scripts packages/lmc-cli/scripts
COPY packages/lmc-cli/tools packages/lmc-cli/tools

RUN SKIP_LMC_WIRE_BUILD=1 pnpm install --frozen-lockfile

# Stage 2: copy source and type-check
FROM deps AS builder

COPY packages/lmc-wire ./packages/lmc-wire
COPY packages/lmc-server ./packages/lmc-server

RUN pnpm --filter lmc-wire --fail-if-no-match build
RUN pnpm --filter lmc-server --fail-if-no-match build

# Stage 3: runtime
FROM node:20-slim AS runner

WORKDIR /repo

RUN apt-get update && apt-get install -y ffmpeg curl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PGLITE_DIR=/data/pglite

COPY --from=builder /repo/node_modules /repo/node_modules
COPY --from=builder /repo/packages/lmc-wire /repo/packages/lmc-wire
COPY --from=builder /repo/packages/lmc-server /repo/packages/lmc-server

VOLUME /data
EXPOSE 3005

WORKDIR /repo/packages/lmc-server

CMD ["sh", "-c", "../../node_modules/.bin/tsx sources/standalone.ts migrate && exec ../../node_modules/.bin/tsx sources/standalone.ts serve"]

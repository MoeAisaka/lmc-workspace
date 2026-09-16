#!/usr/bin/env bash
# Bring up an LMC center from a fresh checkout, or update one already running.
#
#   deploy/lmc/up.sh https://lmc.example.com   first run, or update
#   deploy/lmc/up.sh --add-account             add another sign-in
#
# Everything except the web bundle runs in containers. The bundle is built on
# the host because Expo needs the app workspace, then baked into the center's
# image — a host mount would depend on Docker Desktop's file sharing, which
# silently yields an empty directory for paths it does not share.
#
# This script does not put the center on the internet: it publishes the port on
# loopback only. Point your own reverse proxy at it, terminating TLS and
# forwarding Host, Origin and the WebSocket upgrade.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
compose=(docker compose --env-file "$here/.env" -f "$here/compose.yaml")

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31merror: %s\033[0m\n' "$1" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }

create_account() {
    say "Creating a sign-in"
    local username password confirm
    read -r -p 'Username (3-64 chars): ' username
    read -r -s -p 'Password (at least 12 chars): ' password; echo
    read -r -s -p 'Repeat password: ' confirm; echo
    [ "$password" = "$confirm" ] || die 'The passwords did not match'
    [ "${#password}" -ge 12 ] || die 'The password must be at least 12 characters'
    # Passed on stdin so it never reaches the process list or shell history.
    USERNAME="$username" PASSWORD="$password" node -e \
        'process.stdout.write(JSON.stringify({username:process.env.USERNAME,password:process.env.PASSWORD}))' \
        | "${compose[@]}" run --rm -T center pnpm run lmc:setup
}

if [ "${1:-}" = '--add-account' ]; then
    [ -f "$here/.env" ] || die "No center here yet. Run: deploy/lmc/up.sh https://your-origin"
    need docker; need node
    "${compose[@]}" up -d --wait mysql
    create_account
    exit 0
fi

origin="${1:-}"
[ -n "$origin" ] || die "Usage: deploy/lmc/up.sh <public-origin>   e.g. https://lmc.example.com"

need docker; need node
if command -v pnpm >/dev/null 2>&1; then pnpm=(pnpm); else need corepack; pnpm=(corepack pnpm); fi
cd "$root"

say "Installing workspace dependencies"
"${pnpm[@]}" install --frozen-lockfile

say "Building the wire protocol and Prisma client"
"${pnpm[@]}" --filter @lmc/wire build
"${pnpm[@]}" --filter lmc-server generate

say "Building the device agent"
# bin/happy.mjs runs out of dist, so the agent is unusable until this runs.
"${pnpm[@]}" --filter link-my-cli exec pkgroll

say "Exporting the web bundle"
# Exported beside the current one and swapped in only on success, so a failed
# export never leaves the center with a half-written bundle to serve.
staging="$here/web-next"
rm -rf "$staging"
APP_ENV=production EXPO_PUBLIC_DISABLE_ANALYTICS=1 \
    env -u LMC_SERVER_URL -u LMC_HOME_DIR -u LMC_WEBAPP_URL \
    "${pnpm[@]}" --filter lmc-app exec expo export --platform web --output-dir "$staging" --max-workers 2
[ -f "$staging/index.html" ] || die 'The web export produced no index.html'
rm -rf "$here/web"
mv "$staging" "$here/web"

fresh=0
if [ ! -f "$here/.env" ]; then
    say "Writing a new private .env"
    node "$here/init.mjs" "$here" "$origin"
    fresh=1
else
    say "Keeping the existing .env"
    printf 'A configuration already exists and is never overwritten.\n'
    printf 'To change the public origin, edit LMC_PUBLIC_ORIGIN and PUBLIC_URL in %s/.env\n' "$here"
fi
mkdir -p "$here/data"

say "Starting the database"
"${compose[@]}" up -d --wait mysql

say "Building the center image and applying migrations"
"${compose[@]}" build center
"${compose[@]}" run --rm center pnpm run lmc:migrate

if [ "$fresh" = '1' ]; then create_account; fi

say "Starting the center"
"${compose[@]}" up -d --wait

port="$(grep -E '^PORT=' "$here/.env" | cut -d= -f2)"
public="$(grep -E '^LMC_PUBLIC_ORIGIN=' "$here/.env" | cut -d= -f2)"
cat <<EOF

The center is running on http://127.0.0.1:${port} and answers as ${public}

Still yours to do — the center is not reachable from the internet on its own:
  1. Point a reverse proxy at 127.0.0.1:${port}, terminating TLS for ${public},
     preserving Host and Origin and forwarding the WebSocket upgrade.
  2. On each machine you want to drive:
       export LMC_HOME_DIR="\$HOME/.lmc/agent"
       export LMC_SERVER_URL="${public}"
       export LMC_WEBAPP_URL="${public}"
       node packages/lmc-cli/bin/happy.mjs auth login
       node packages/lmc-cli/bin/happy.mjs daemon start

Add another sign-in with: deploy/lmc/up.sh --add-account
Stop with: docker compose --env-file deploy/lmc/.env -f deploy/lmc/compose.yaml stop
EOF

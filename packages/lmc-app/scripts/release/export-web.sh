#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd -- "$script_dir/../.." && pwd)"
repo_dir="$(cd -- "$app_dir/../.." && pwd)"
out_dir='/tmp/lmc-redesign-web-20260908'
while [[ $# -gt 0 ]]; do
    case "$1" in
        --out)
            [[ $# -ge 2 && -n "$2" ]] || { echo '--out requires a directory' >&2; exit 2; }
            out_dir="$2"
            shift 2
            ;;
        -h|--help)
            echo 'Usage: export-web.sh [--out DIRECTORY]'
            exit 0
            ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done
# Resolve relative output paths before changing to the app directory.
[[ "$out_dir" = /* ]] || out_dir="$PWD/$out_dir"
while [[ "$out_dir" != / && "$out_dir" = */ ]]; do out_dir="${out_dir%/}"; done
[[ "$out_dir" != / ]] || { echo 'Output directory cannot be /' >&2; exit 2; }
if [[ -e "$out_dir" || -L "$out_dir" ]]; then
    previous_dir="$out_dir.old-$(date +%s)"
    [[ ! -e "$previous_dir" && ! -L "$previous_dir" ]] || { echo "Archive already exists: $previous_dir" >&2; exit 1; }
    mv -- "$out_dir" "$previous_dir"
    echo "Previous export: $previous_dir"
fi
cd -- "$app_dir"
APP_ENV=production EXPO_PUBLIC_DISABLE_ANALYTICS=1 \
    env -u LMC_SERVER_URL -u LMC_HOME_DIR -u LMC_WEBAPP_URL \
    "$repo_dir/node_modules/.bin/expo" export --platform web \
    --output-dir "$out_dir" --max-workers 2

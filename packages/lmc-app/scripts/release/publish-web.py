#!/usr/bin/env python3
"""Publish exported web assets, preserving old hashes and replacing HTML last."""
import argparse
from pathlib import Path
import hashlib, re, shutil, os, time, urllib.request, ssl, json

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--marker', required=True, help='Release marker, e.g. lmc-redesign-20260908-v129')
parser.add_argument('--build-dir', type=Path, default=Path('/tmp/lmc-redesign-web-20260908'))
parser.add_argument('--live-dir', type=Path, default=os.environ.get('LMC_WEB_GATE_DIR'),
                    help='Directory the site is served from. Defaults to $LMC_WEB_GATE_DIR; required if that is unset.')
parser.add_argument('--allow-replace', action='append', default=[], metavar='FILENAME',
                    help='Allow replacing this exact asset filename (repeatable); old tabs may fail to lazy-load it until refreshed')
args = parser.parse_args()
if args.live_dir is None:
    parser.error('--live-dir is required when LMC_WEB_GATE_DIR is not set')
args.live_dir = Path(args.live_dir)
if not re.fullmatch(r'[A-Za-z0-9._-]+', args.marker):
    parser.error('--marker must contain only letters, digits, dots, underscores or hyphens')
live = args.live_dir.expanduser()
build = args.build_dir.expanduser()
assert build.resolve() != live.resolve(), 'Build and live directories must differ'
marker = args.marker

old = (live / 'index.html').read_text()
new = (build / 'index.html').read_text() \
    .replace('<title>LMC (dev)</title>', '<title>Link my Cli</title>') \
    .replace('<html lang="en">', '<html lang="zh-CN">')
icons = re.findall(r'<link[^>]+rel="(?:icon|apple-touch-icon)"[^>]*>', old)
assert icons, 'Missing icon links in live index.html'
new = new.replace('</head>', ''.join(icons) + f'<meta name="lmc-release" content="{marker}" /></head>')
assert '<html lang="zh-CN">' in new and '<title>Link my Cli</title>' in new

# Include root resources (WASM, workers, icons, manifests) and nested exports.
files = sorted(p for p in build.rglob('*') if p.is_file() and p != build / 'index.html')
assert not any(p.is_symlink() for p in build.rglob('*')), 'Build must not contain symlinks'
# Validate every conflict before modifying live files, even when some are approved.
allowed = set(args.allow_replace)
for name in allowed:
    if len([src for src in files if src.name == name]) != 1:
        parser.error(f'--allow-replace must identify exactly one build asset filename: {name}')
replacements = set()
replaced = []
for src in files:
    dest = live / src.relative_to(build)
    if dest.exists() and hashlib.sha256(src.read_bytes()).digest() != hashlib.sha256(dest.read_bytes()).digest():
        assert src.relative_to(build).parts[0] not in ('_expo', 'assets') or src.name in allowed, (
            f'Asset content conflict: {src.relative_to(build)}. After investigating, use '
            f'--allow-replace {src.name} to retain and replace the old asset; '
            'old tabs may fail to lazy-load this chunk until refreshed.'
        )
        replacements.add(src)
# Every URL referenced by the new HTML must exist in the build or already be live.
for url in re.findall(r'(?:src|href)="(/[^"?]+)', new):
    rel = url.lstrip('/')
    assert (build / rel).exists() or (live / rel).exists(), url

backup = live / f'index.previous-{int(time.time() * 1000)}.html'
shutil.copy2(live / 'index.html', backup)
# Assets first, HTML last: tabs opened before this release keep resolving old hashes.
for src in files:
    dest = live / src.relative_to(build)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if src in replacements:
        saved = dest.with_name(f'{dest.name}.pre-{marker}-{time.time_ns()}')
        assert not saved.exists(), f'Asset backup already exists: {saved}'
        shutil.copy2(dest, saved)
        pending_asset = dest.with_name(f'.{dest.name}.{os.getpid()}.tmp')
        shutil.copy2(src, pending_asset)
        os.replace(pending_asset, dest)
        replaced.append({'file': src.relative_to(build).as_posix(), 'backup': saved.relative_to(live).as_posix()})
    elif not dest.exists():
        shutil.copy2(src, dest)
# Check the served tree, not merely the build: an omitted copy must fail before HTML switches.
for src in files:
    dest = live / src.relative_to(build)
    assert dest.is_file() and hashlib.sha256(src.read_bytes()).digest() == hashlib.sha256(dest.read_bytes()).digest(), str(dest)
for url in re.findall(r'(?:src|href)="(/[^"?]+)', new):
    assert (live / url.lstrip('/')).is_file(), url
pending = live / f'.index-{os.getpid()}.tmp'
pending.write_text(new)
os.replace(pending, live / 'index.html')
print(json.dumps({'backup': backup.name, 'copiedAssets': len(files), 'marker': marker, 'replaced': replaced}, ensure_ascii=False))

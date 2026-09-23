#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Manual only. Fixtures stay beside this script, never in /tmp or the live site.
python3 - "$script_dir" <<'PY'
from pathlib import Path
import json
import subprocess
import sys
import tempfile

scripts = Path(sys.argv[1])
with tempfile.TemporaryDirectory(prefix='.publish-selftest-', dir=scripts) as scratch:
    build, live = (Path(scratch) / name for name in ('build', 'live'))
    for directory in (build, live):
        (directory / 'assets').mkdir(parents=True)
    original = '<html lang="zh-CN"><head><title>Link my Cli</title><link rel="icon" href="/icon.ico"></head></html>'
    (live / 'index.html').write_text(original)
    (live / 'icon.ico').write_bytes(b'icon')
    (build / 'index.html').write_text('<html lang="en"><head><title>LMC (dev)</title></head><body><script src="/assets/chunk.js"></script></body></html>')
    (build / 'canvaskit.wasm').write_bytes(b'new-wasm')
    (live / 'canvaskit.wasm').write_bytes(b'old-wasm')
    (build / 'worker.js').write_text('new-worker')
    for name in ('chunk.js', 'other.js'):
        (live / 'assets' / name).write_text('old-' + name)
        (build / 'assets' / name).write_text('new-' + name)
    command = [sys.executable, str(scripts / 'publish-web.py'), '--marker', 'selftest-v1', '--build-dir', str(build), '--live-dir', str(live)]
    for extra in ([], ['--allow-replace', 'chunk.js']):
        refused = subprocess.run(command + extra, capture_output=True, text=True)
        assert refused.returncode != 0 and '--allow-replace' in refused.stderr
        assert (live / 'index.html').read_text() == original
        assert not list(live.rglob('*.pre-*'))
        assert (live / 'assets/chunk.js').read_text() == 'old-chunk.js'
    print('PASS unapproved conflicts fail before any live mutation')
    result = subprocess.run(command + ['--allow-replace', 'chunk.js', '--allow-replace', 'other.js'], capture_output=True, text=True, check=True)
    report = json.loads(result.stdout)
    assert len(report['replaced']) == 3
    assert (live / 'canvaskit.wasm').read_bytes() == b'new-wasm'
    assert (live / 'worker.js').read_text() == 'new-worker'
    for entry in report['replaced']:
        name = Path(entry['file']).name
        suffix = 'wasm' if name == 'canvaskit.wasm' else name
        assert (live / entry['file']).read_text() == 'new-' + suffix
        assert (live / entry['backup']).read_text() == 'old-' + suffix
        assert '.pre-selftest-v1-' in entry['backup']
    assert 'selftest-v1' in (live / 'index.html').read_text()
    assert (live / 'index.html').exists()
    print('PASS root WASM replaced with backup and new worker published')
    print('PASS repeated --allow-replace preserves .pre- backups and replaces assets')
print('All publish self-checks passed; fixtures removed.')
PY

/**
 * Patches react-native-unistyles 3.1.1 so its web registry stops pinning DOM
 * elements that have left the document.
 *
 * UnistylesRegistry.connect() records every element using a style hash in
 * `stylesCounter: Map<hash, Set<HTMLElement>>`. The Set holds strong references
 * and the paired remove() does not run for every unmount, so on web it only
 * grows. Style hashes are reused, so the CSS side looks healthy while the
 * elements themselves are never released. A retaining-path walk through a heap
 * snapshot lands exactly here: Map -> table -> Set -> table -> the element.
 *
 * Measured in this app before the patch: each session switch leaked ~2000-3000
 * DOM nodes and ~350 listeners that survived a forced GC. A 535MB heap snapshot
 * held 22892 detached elements. DOM memory is charged to the renderer's native
 * heap, not the JS heap, so the tab reached 1GB while the JS heap read 226MB.
 *
 * The sweep runs from a microtask, not inline. Timing is the whole point: React
 * attaches the incoming element before detaching the outgoing one, so a sweep
 * running inside connect() sees everything still attached and frees nothing.
 * Deferring to the end of the current task is what upstream's own remove() does,
 * for this same reason. One sweep is scheduled per task however many elements
 * mount, and it walks only what the registry already holds.
 *
 * Upstream-safe: it only adds a sweep. If unistyles fixes this, the sweep finds
 * nothing to delete.
 */
const fs = require('fs');
const path = require('path');

const TARGETS = ['lib/module/web/registry.js', 'lib/commonjs/web/registry.js'];

const ORIGINAL = [
    '  connect = (ref, hash) => {',
    '    const stylesCounter = this.stylesCounter.get(hash) ?? new Set();',
    '    stylesCounter.add(ref);',
    '    this.stylesCounter.set(hash, stylesCounter);',
    '  };',
].join('\n');

const PATCHED = [
    '  __sweepScheduled = false;',
    '  // PATCHED (fix-unistyles-detached-refs): release elements that have left',
    '  // the document. Deferred to a microtask because React attaches the new',
    '  // element before detaching the old one, so an inline sweep frees nothing.',
    '  __sweepDetached = () => {',
    '    if (this.__sweepScheduled) {',
    '      return;',
    '    }',
    '    this.__sweepScheduled = true;',
    '    Promise.resolve().then(() => {',
    '      this.__sweepScheduled = false;',
    '      this.stylesCounter.forEach(set => {',
    '        set.forEach(element => {',
    '          if (element && element.isConnected === false) {',
    '            set.delete(element);',
    '          }',
    '        });',
    '      });',
    '    });',
    '  };',
    '  connect = (ref, hash) => {',
    '    const stylesCounter = this.stylesCounter.get(hash) ?? new Set();',
    '    stylesCounter.add(ref);',
    '    this.stylesCounter.set(hash, stylesCounter);',
    '    this.__sweepDetached();',
    '  };',
].join('\n');

// The first version swept inline from connect() behind a doubling threshold. It
// freed nothing, for the ordering reason above. Revert it where still installed.
const SUPERSEDED_MARKER = '__pruneDetached';
const SUPERSEDED_START = '  __pruneThresholds = new Map();';
const SUPERSEDED_END = '    this.__pruneDetached(hash, stylesCounter);\n  };';

const roots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/lmc-app/node_modules'),
];

let patched = 0;

for (const root of roots) {
    for (const target of TARGETS) {
        const file = path.join(root, 'react-native-unistyles', target);
        if (!fs.existsSync(file)) continue;
        let content = fs.readFileSync(file, 'utf8');
        if (content.includes('__sweepDetached')) continue;
        if (content.includes(SUPERSEDED_MARKER)) {
            const from = content.indexOf(SUPERSEDED_START);
            const to = content.indexOf(SUPERSEDED_END);
            if (from === -1 || to === -1) {
                console.warn('[patch] unistyles: superseded patch in unexpected shape, skipped:', file);
                continue;
            }
            content = content.slice(0, from) + ORIGINAL + content.slice(to + SUPERSEDED_END.length);
        }
        if (!content.includes(ORIGINAL)) {
            console.warn('[patch] unistyles: connect() not in the expected shape, skipped:', file);
            continue;
        }
        fs.writeFileSync(file, content.replace(ORIGINAL, PATCHED), 'utf8');
        patched++;
    }
}

if (patched > 0) {
    console.log('[patch] unistyles: release detached element refs (' + patched + ' file(s))');
}

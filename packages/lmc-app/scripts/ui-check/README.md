# Collaboration and hub sorting browser checks

This is a **manual interaction check**, not part of CI or the package `test`
script. It builds a small isolated page from the current source and drives it
with Playwright. It never connects to a production server or loads account data.

The actual CollaborationSheet, ModalProvider, CustomModal, BaseModal,
SortableHubGroups, splitHubGroups, useSessionRowMenu and React Native Web Pressable are rendered.
Headers and worker rows use the real contextmenu/press-in/long-press props;
a visible menu marker reflects the hook anchor. Native-only quick actions are stubbed.
Account data, settings I/O, typography/icons and unrelated UI branches are
fixtures. Settings use localStorage to exercise the write/reload boundary; this
is not an end-to-end test of server synchronization or native devices.

## Prerequisites

Install this repository's normal workspace dependencies with `pnpm install`.
The builder uses the existing esbuild, React and React Native Web packages.

The runner resolves `playwright` or `playwright-core` normally. If neither is
available, install Playwright outside the repository, then point the runner at
that package (no change to the app's dependencies is needed):

```sh
LMC_UI_TOOLS_DIR="$(mktemp -d)"
pnpm --dir "$LMC_UI_TOOLS_DIR" add playwright
pnpm --dir "$LMC_UI_TOOLS_DIR" exec playwright install chromium
export LMC_PLAYWRIGHT_MODULE="$LMC_UI_TOOLS_DIR/node_modules/playwright"
```

By default, Playwright launches its installed Chromium. To use an existing
Chrome/Chromium installation instead, set `LMC_CHROME_PATH` to its executable.
With `playwright-core`, either provide that executable or install the matching
browser using its CLI. No browser/cache path is embedded in these scripts.

## Run

From the repository root:

```sh
node packages/lmc-app/scripts/ui-check/verify.cjs
```

The script builds the fixture automatically, binds an HTTP server to a random
loopback port, launches a fresh headless browser, and closes both on completion
or failure. A failing assertion returns a nonzero exit code. Generated files
and `after.png` go into a new OS temporary directory printed by the script.
Optionally set `LMC_UI_CHECK_DIR` to a dedicated artifact directory; its fixture
files are overwritten on each run. To build only:

```sh
node packages/lmc-app/scripts/ui-check/build.cjs
```

Checks cover all five sheet states (plain, hub, worker, add-worker list and
custom duty input), each closed by the 44×44 button, backdrop and Escape. Escape
**modal dismissal already comes from RN Web Modal's document keyup handler**;
this check guards against breaking it. Closing discards unsubmitted duty input.

Sorting checks exercise real pointer events, unequal group heights, save/reload
of `sessionProjectOrder['lmc:hubs']`, no accidental navigation, nested worker/menu
exclusion, early swipe rejection, and Escape cancellation while keyboard focus
is outside the sorter. The separate jsdom component tests run in the ordinary
Vitest suite and cover the RN Web pointer-capture regression and listener cleanup.

Additional context-menu checks:
- Complete a hub group drag, then right-click its header and verify its menu opens.
- Right-click a worker row and verify only its menu opens, with group order and saved settings unchanged.

Run this manual script after changes to SortableHubGroups gestures or session-row menu wiring.

## Session header browser checks

`session-header.cjs` loads the actual modules and CSS from a Web release export,
without starting the app or loading an account. It renders `SessionView` with
synthetic Claude/Codex sessions, login/refresh errors, the real drawer, resource
window and session menu. All non-loopback requests are blocked. It saves
screenshots and `results.json` in a fresh temporary directory.

```sh
node packages/lmc-app/scripts/ui-check/session-header.cjs /path/to/web-export
LMC_WEBKIT=1 node packages/lmc-app/scripts/ui-check/session-header.cjs /path/to/web-export
```

Use `LMC_PLAYWRIGHT_MODULE` and optionally `LMC_CHROME_PATH` as above; the WebKit
run needs Playwright's matching WebKit browser installed. Each run checks 14
states, including actual control clicks, drawer masking, viewport restoration,
stale RN dimensions, draft preservation and desktop layout. One case explicitly
sets a screen container's scroll offset to 56px to model scroll restoration.
That is a controlled regression case, not a reproduction of a particular iPhone
gesture or an end-to-end test on iOS.

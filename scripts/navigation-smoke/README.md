# LMC navigation smoke test

Run `node scripts/navigation-smoke/verify.cjs` from the repository. Requires the existing esbuild dependency and an installed `playwright-core`; set `LMC_PLAYWRIGHT_MODULE` to its module directory if it is not on Node's search path. `LMC_CHROME_PATH` optionally selects a Chrome executable (default: macOS Google Chrome).

The runner creates an isolated temporary fixture and localhost server, starts a separate headless browser, and closes both after verification. It does not read browser profiles, authenticate, or contact the production API. The fixture uses the actual sorter, React Native Web Pressable, menu hook and order functions. Only settings sync, theme and action-sheet dependencies are mocked. Screenshots and fixture artifacts remain in the printed temporary directory.

Checks cover hidden and hover handles, mouse reorder without navigation, mobile hold+drag, stationary hold menu, early swipe, touch cancellation, keyboard commit/cancel, reduced motion and filtered-list sorting disabled. Physical iPhone and real settings server synchronization still require integration acceptance.

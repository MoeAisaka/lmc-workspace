# Phone drawer alignment

Run against an exported Web build:

```sh
LMC_PLAYWRIGHT_MODULE=/path/to/playwright-core \
  node scripts/drawer-alignment-smoke/verify.cjs /path/to/exported-web
```

Requires Chrome (or `LMC_CHROME_PATH`). The fixture renders the actual
SessionViewLoaded, AgentInput, FloatingSessionDrawer and account menu with
synthetic data. Session synchronization is stubbed and external requests are
blocked; it does not access real accounts or sessions.

Checks the input-card and drawer bottom edges at widths 320/390/430/667,
changing viewport heights, light/dark themes, usage-row presence, and bottom
safe areas of 0/34. Also checks the avatar submenu's top alignment and removal
of the chat anchor on navigation blur. Screenshots go to the printed temporary
artifact directory.

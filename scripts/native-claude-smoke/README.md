# Native Claude controls visual regression

`LMC_PLAYWRIGHT_MODULE=/path/to/playwright-core node scripts/native-claude-smoke/verify.cjs /path/to/export`

Loads real exported components with a synthetic encrypted-RPC substitute.
Blocks all non-local requests and opens no logged-in browser profile. Checks
phone/landscape/desktop, light/dark, explicit versioned input, double clicks,
connection loss/recovery and panel close/reopen. Writes screenshots/results
under a newly created system temporary directory.

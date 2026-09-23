# Account-menu usage cards

The D26 menu reads a **single configured dashboard source**, via encrypted
`account-quota` machine RPC. It never sums quotas from multiple sessions or
devices. Both Codex and Claude are shown, with unknown values displayed as `—`.

## Optional dashboard connector

On the device running the dashboard, create `quota-dashboard.json` in the LMC
Agent home (`~/.lmc/agent` by default, or `LMC_HOME_DIR`):

```json
{"configPath":"/absolute/path/to/dashboard_config.json"}
```

This stores only a reference to the dashboard's existing local configuration;
do not copy its token into LMC configuration, the repository or the browser.
The connector reads its `token` and `port` (default 19390) locally, requests only
`http://127.0.0.1:<port>/api/summary`, rejects redirects, and projects an allowlist
of quota fields. No provider requests or authentication refreshes are performed.
RPC callers cannot choose a URL, file path or credential. Other dashboard data,
raw errors and credentials never leave the device.

Use the normal managed Agent upgrade/restart to publish the `accountQuota`
capability after configuring the file. Only this source device needs the
connector; clients on other devices read through the same LMC account. Legacy
or unconfigured devices are not probed. With no configured source online, the
menu shows an explicit waiting state. To disable, remove the reference file
and use the normal daemon restart; no sessions need to be stopped.

The menu polls while open every 30 seconds and on foreground return; the Agent
coalesces concurrent requests and caches results/errors for 15 seconds. Manual
refresh rereads the dashboard cache, **not** the provider. The displayed sample
time comes from the underlying collector (Codex file mtime, Claude last success),
so a UI refresh cannot make old readings look fresh. Stale/failure states retain
the previous successful snapshot. Quota data is cached in browser memory only.

## Dashboard calculations

- The daily marker splits the multi-day window evenly by days since the window
  began. Today's whole share is available at the start of the day. The floor is
  `100 - currentDay * 100 / totalDays`; current remaining minus this floor gives
  today's available points (or overspend). Pending/expired/5-hour windows have
  no daily marker. This is not an observed average burn rate or exhaustion ETA.
- The existing dashboard convention maps a full Fable pool to **50 weekly
  points**. This is an explicit visualization assumption, not a provider
  guarantee. Fable's remaining percent × 0.5 is its reservation on the shared
  weekly bar, with a compact legend instead of a separate Fable card or bar.
  Purple is covered reservation; amber is the shortfall. No extra
  quota is added. Comparison requires matching, unexpired weekly reset times.
- Missing Fable data leaves its legend visible as unknown. A genuine zero remains
  zero. Reset coupons appear only if the source supplies them.

## Verification

`packages/lmc-wire/src/accountQuota.test.ts` covers daily boundaries and Fable
conversion. `packages/lmc-cli/src/daemon/accountQuota.test.ts` covers projection,
missing/zero readings, stale data, secret exclusion and request coalescing.

After a production web export:

```sh
node scripts/account-quota-smoke/verify.cjs /path/to/web-export
```

The smoke test renders the real AccountMenu and hook with synthetic quota RPCs,
blocks external network requests, checks 320/390/1000px light/dark rendering,
scroll access to menu items, failed refresh and missing data. Set
`LMC_PLAYWRIGHT_MODULE` / `LMC_CHROME_PATH` if needed. It does not connect to any
real session or provider.

# release

The two scripts an Agent release is shipped with. They used to live in /tmp on
each Mac and were lost when the tmp directory was swept; they live here now.

```
# from the repo root, after `pkgroll` in packages/lmc-cli
python3 packages/lmc-cli/scripts/release/stage-agent.py packages/lmc-cli ~/.lmc/agent-releases/<previous-tag> <new-tag>
node packages/lmc-cli/scripts/release/rollout.mjs upgrade agent     # activate the staged release on this Mac's daemon
node packages/lmc-cli/scripts/release/rollout.mjs status|retry|snapshot|latest    # status's last line is JSON; retry re-tries a stuck session
```

For the other Mac: tar `dist bin package.json`, scp, extract, and run
stage-agent.py against the extracted directory, then `rollout.mjs upgrade agent`
there (node is at /opt/homebrew/bin on the MacBook).

Run the switch-lab probes before staging anything that touches the refresh or
handoff paths; see ../switch-lab/README.md.

## 另一台 Mac 的安装包

```
# on this Mac, from the repo root
tar czf /tmp/lmc-agent-<new-tag>.tar.gz -C packages/lmc-cli dist bin package.json scripts/release
scp /tmp/lmc-agent-<new-tag>.tar.gz other-mac:/tmp/

# on the other Mac
mkdir -p /tmp/lmc-agent-<new-tag>
tar xzf /tmp/lmc-agent-<new-tag>.tar.gz -C /tmp/lmc-agent-<new-tag>
python3 /tmp/lmc-agent-<new-tag>/scripts/release/stage-agent.py /tmp/lmc-agent-<new-tag> ~/.lmc/agent-releases/<previous-tag> <new-tag>
node /tmp/lmc-agent-<new-tag>/scripts/release/rollout.mjs upgrade agent
```

`/tmp` gets swept by the OS on a schedule, so the target Mac can't be counted
on to already have stage-agent.py or rollout.mjs — that's why both ship inside
the tarball under scripts/release instead of being fetched separately.

Web export and publishing: [Web release guide](../../../lmc-app/scripts/release/README.md).

## Document search dependencies (Agent 1.2.48+)

Before staging an Agent that adds PDF/DOCX search, create a portable dependency
bundle from the installed, lockfile-pinned packages:

```sh
node packages/lmc-cli/scripts/release/pack-document-deps.cjs "$PWD/packages/lmc-cli" /tmp/lmc-document-deps
```

Include its contents as `runtime-dependencies/` next to `dist`, `bin` and
`package.json` in the release source directory. `stage-agent.py` copies these
packages into the new release only, replacing inherited symlinks, and checks
parser resolution before updating the catalog. The script uses `node` from PATH
on both macOS and Linux. Keep the previous release and catalog backup for rollback.

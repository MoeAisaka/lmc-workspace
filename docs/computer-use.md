# Device computer tools

Agent 1.2.64 can attach a device-local desktop MCP to Claude and Codex. Claude's
explicit `--chrome` / `--no-chrome` choice also reaches the remote Agent SDK now;
previously the remote SDK options dropped it. No unrestricted CLI argument forwarding
or changes to the provider's interactive-only computer-use gate are involved.

Configuration is optional: `<LMC_HOME_DIR>/computer-use.json` (normally
`~/.lmc/agent/computer-use.json`). It contains executable configuration only, never
credentials. Example for a Mac whose Codex already has native computer tools:

```json
{
  "version": 1,
  "enabled": true,
  "engines": ["claude"],
  "chrome": true,
  "desktop": {
    "command": "/absolute/path/to/peekaboo",
    "args": ["mcp"]
  }
}
```

Use `engines: ["claude", "codex"]` to attach the same MCP to both. Desktop MCP
launch is limited to macOS; Chrome is a separate Claude capability. Missing,
invalid, disabled or unsupported configuration does not launch the desktop tool.
Tools retain each session's existing permission policy; they are not added to
LMC's automatically allowed hub tools. Connected MCP status alone does not prove
macOS permissions or browser-extension connectivity.

The deployed backend is Peekaboo **4.6.0**, built from its exact release commit
`b54551ce2d0013e52c2a405bfeabced88ec5c2e0` using Apple Swift 6.3.3 and the macOS
26.5 SDK. The official npm binary was built with Swift 6.4 and failed before
startup on macOS 26.5.1 with a missing `_swift_initBorrow` symbol. Rebuilding the
same source with a compatible compiler fixes this without replacing system
libraries, injecting symbol stubs, or modifying vendor code.

On both Macs, `desktop.command` selects
`~/.lmc/tools/computer-use-4.6.0-compat-b54551ce/lmc-peekaboo` (expanded to an
absolute path), with `args: ["mcp"]`. This launcher contains:

```sh
#!/bin/sh
export PEEKABOO_CAPTURE_ENGINE=classic
exec "$(dirname "$0")/peekaboo" "$@" --no-remote
```

The documented local classic capture mode supports independent LMC sessions.
With the default ScreenCaptureKit route, a second MCP connection failed after
the first captured an image because the first process owned capture without a
compatible Bridge endpoint. Two simultaneous clients both captured the lab
window successfully with this launcher. ScreenCaptureKit streaming and vendor
signed Bridge interoperability are not claimed for this local build.

Reproduce the compatibility build on an arm64 Mac with Swift 6.3.3:

1. Clone the `v4.6.0` tag and its pinned submodules; confirm the exact commit above.
2. Copy the canonical `Apps/Peekaboo.xcworkspace/xcshareddata/swiftpm/Package.resolved`
   to `Apps/CLI/Package.resolved`. Resolve once and verify that retained dependency
   revisions still match the canonical lock.
3. Generate a temporary CLI Info.plist from `Apps/CLI/Sources/Resources/Info.plist`,
   recording the actual `PeekabooSourceCommit`, git tag/commit and build date. Pass
   its absolute path as `PEEKABOO_CLI_INFO_PLIST_PATH`.
4. From `Apps/CLI`, run `python3 ../../scripts/setup-swift-workspace.py run --release
   -- swift build -c release --product peekaboo --jobs 2`. The helper verifies the
   clean release source and owns only checkout-local SwiftPM configuration.
5. Package the executable and generated resource bundles in a new private tool
   directory. Run `xcrun swift-stdlib-tool --copy --scan-executable <binary>
   --platform macosx --destination <directory>`, include the resulting
   `libswiftCompatibilitySpan.dylib`, and add the executable-relative rpath.
6. Apply a local ad-hoc code signature, verify it, and retain a `BUILD.json` receipt
   with compiler/SDK versions, source commit and file digests. This is a local
   compatibility build, not a vendor-signed or notarized release.

The deployed native binary SHA-256 is
`9e3f53aed8c3f0d7b882caa7164705a54fd895a1da00fd9958cda72acf266699`.

Grant the selected runtime host Screen Recording and Accessibility; background
input additionally requires Event Synthesizing. Check with `peekaboo permissions
status --json` from the same GUI Agent context that launches the tools: SSH can
report different permission and keychain state. In 4.6.0, `see` supplies an
accessibility map and inline image; `image` with `format: "data"` also delivers
pixels directly to the model. An unconfirmed input receipt requires a fresh
observation, not blind replay. Neither `agent` nor
`analyze` is needed for this integration: the connected Claude session interprets
the screenshot itself. Chrome also requires the user's installed, signed-in
Claude in Chrome extension. Credentials and Codex plugin directories are never
copied between providers or machines.

After changing configuration, use LMC's safe refresh at a real idle boundary.
To disable, set `enabled: false` and safely refresh. The previous configuration
is retained as `computer-use.before-4.6.0-20260930.json`; restore it to select the
previous backend. Preserve backend packages and native conversation files for
rollback. Do not force-stop active sessions.

Official backend docs: https://peekaboo.sh/MCP.html and
https://github.com/openclaw/Peekaboo/releases/tag/v4.6.0 .

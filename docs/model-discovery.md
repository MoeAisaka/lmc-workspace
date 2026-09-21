# Model discovery

LMC discovers model catalogs from each machine's selected engines instead of
requiring a WebApp release for every new model ID or reasoning effort.

- Codex: a temporary app-server connection calls the paginated `model/list` API.
- Claude: a temporary SDK query calls `supportedModels()` with an empty input
  stream and `persistSession: false`.
- Neither discovery path sends a user prompt, starts a model turn, resumes a
  conversation, or invokes tools. The temporary processes are closed afterwards.

The daemon discovers both engines at startup and every 15 minutes. It checks the
managed runtime selection every minute and refreshes after a change. An engine
upgrade may still be necessary before that engine advertises a newly released
model; this feature does not install or activate engine upgrades.

Each engine's result is cached in `model-catalogs.json` under the LMC home and
published in machine metadata. The cache contains model IDs, display names,
aliases, effort levels, a capture timestamp and runtime version, never credentials.
Failure keeps the last successful result and marks it stale. An engine's discovery
failure does not discard the other engine's catalog.

The session composer, engine-switch menu, new-session controls, sidebar labels and
agent-default settings consume discovered catalogs. Existing model selections,
including aliases and custom model IDs, are retained when a list changes. Existing
sessions are never automatically moved to the newest model.

An advertised empty effort list means no effort override; a missing list means
unknown capability. Advertised levels take precedence over compatibility tables.
Implicit defaults are adjusted to supported levels. An incompatible explicit
choice is rejected before sending instead of silently changing the request.

New runners advertise `sessionCapabilities.modelDiscovery`; old runners retain
compatibility menus until refreshed at their normal safe boundary. A session
pinned to an older engine uses its matching session snapshot, not a catalog from
an upgraded engine on the same machine. New-session controls use their selected
target machine's catalog. Global default settings show the newest reported catalog
per engine; the actual target validates the selection when starting or sending.

This adapts model identifiers, names and reasoning effort values within the
existing discovery and turn protocols. Changes to those protocols or new kinds of
provider capability still require adapter work. Provider authorization remains
final: appearing in a catalog is not a guarantee that every request is available
to every account or workspace configuration.

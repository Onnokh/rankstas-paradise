# The Effect v4 monorepo rewrite

## Status

accepted — supersedes the implementation shape assumed by
[0001-rp-as-hosted-service.md](0001-rp-as-hosted-service.md). ADR 0001's
_product_ decision (RP is a hosted, bearer-authed service; apps and agents are
clients) still holds; only the code it described — a flat `src/` of module-global
singletons on Effect v3 — has been replaced.

## Context

The original code lived in one flat `src/` directory (19 files) written against
**Effect v3**. State was module-global: a single `database()` handle, a
module-level `jobs: Job[]` array, and an `AsyncLocalStorage`-backed `withSite()`
thread-local that every site-scoped read implicitly threaded through. That shape
worked for one Mac and one person, but it made the hosted, multi-site service
from ADR 0001 awkward: ambient per-site state and process-global singletons fight
an always-on server that serves several sites concurrently, and nothing was
independently testable or reusable across the TUI / desktop / agent surfaces.

We rewrote the whole thing on **Effect v4-beta** as a Bun-workspaces monorepo,
following the module contract in [../effect-conventions.md](../effect-conventions.md).

## Decision

### Monorepo split

```
packages/domain      — the SEO core as Effect services (server-only concern)
packages/api-client  — the typed HTTP client + client config (RP_API_URL/RP_TOKEN)
apps/server          — the HttpApi server: apps/server/src/main.ts (the entrypoint)
apps/tui             — remote-only opentui dashboard + agent CLI (talks HTTP)
apps/desktop         — placeholder for the native client (not in the build graph)
```

**Surface topology.** Only `apps/server` depends on `packages/domain` (it owns
the data, Google, and SQLite). `apps/tui` and the future `apps/desktop` depend
only on `packages/api-client` — they never see the domain, they only speak HTTP.
The TS reference graph is `domain → (none)`, `api-client → domain`,
`server → domain`, `tui → api-client`. Build with `bun run check` (`tsc --build`)
from the repo root.

### Effect v3 → v4-beta, in lockstep

`effect`, `@effect/platform-bun`, and `@effect/sql-sqlite-bun` are all pinned to
the **exact** version `4.0.0-beta.99` at the workspace root, so the whole
workspace resolves one copy. This is a deliberate, load-bearing risk (see below).

### From module-global state to scoped services

Three global-singleton patterns became explicit Effect services:

- **`withSite()` / `AsyncLocalStorage` → `CurrentSite` + per-site
  `ManagedRuntime` cache.** The active site is no longer an ambient thread-local
  read implicitly deep in a call stack. It is a scoped service (`CurrentSite`,
  `packages/domain/src/sites/current-site.ts`) that the site-scoped services
  (`Storage`, `Registry`, `Sitemap`, `Reports`, `Sync`, and the site-scoped parts
  of `SearchConsole`) read from context — they never take a site parameter. The
  domain's `AppLayer` composes a die-stub `CurrentSite.defaultLayer` for
  type-checking; the real active site is supplied at the boundary via
  `CurrentSite.layerForSite(site)`. The server builds **one `ManagedRuntime` per
  site**, cached by site id (`apps/server/src/http/runtime.ts`), so each site's
  SQLite connection (a scoped resource on `Storage` acquisition) is opened once
  and reused across requests. This replaces the per-call `withSite(...)` wrap.
- **module-global `database()` → scoped `Storage`.** The SQLite handle is now
  `@effect/sql-sqlite-bun`'s `SqliteClient`, opened once as a **scoped resource**
  on `Storage` layer acquisition (keyed off `CurrentSite.databasePath()`) and
  closed when the runtime is disposed — not a lazily-created module global.
- **module-global `jobs: Job[]` array → `Jobs` service.** The hosted server's
  background-job registry and single-job lock is now one service
  (`apps/server/src/jobs/jobs.ts`) built from Effect primitives: a `Ref` for the
  registry (was the array), a `Semaphore(1)` for the single-job lock (was an
  ad-hoc `runningJob()` guard), `Effect.forkDetach` for fire-and-forget work
  (was `work().then(...)`), and a `Cache` with a TTL for the read-triggered
  "warm" freshness/in-flight gate (was `maybeEnqueueSync`). It lives in
  `apps/server`, not the domain, because it is a hosting concern.

## The beta-version risk

`4.0.0-beta.99` is pre-release; its API is not the v3 most training data and
online examples assume, and it churns between betas. Concretely, this repo was
built and verified against these v4-beta facts — trust
[../effect-conventions.md](../effect-conventions.md) over memory:

- **HTTP / SQL live under `effect/unstable/*` subpaths, not the barrel** —
  `effect/unstable/http`, `effect/unstable/httpapi`, `effect/unstable/sql`.
- **`Config.*` recipes are lowercase functions** — `Config.string`,
  `Config.boolean`, `Config.redacted`, not `Config.String`.
- **`forkDetach`, not `forkDaemon`**, for detached background fibers.
- **Services use `Context.Service`, errors use `Schema.TaggedErrorClass`** (not
  `Effect.Service` / `Schema.TaggedError`).
- **`Effect.catchAll` is gone** in beta.99 — which is exactly why the legacy v3
  `src/` could not run under the pinned deps at all.

Mitigation: the exact-version lockstep pin, the pinned API map in
`effect-conventions.md`, and the golden HTTP replay
(`apps/server/test/http-golden.test.ts`) that asserts the new server reproduces
the committed contract byte-for-byte.

## Consequences

- The flat `src/` tree is deleted (PLO-278). Every module has a new home: the
  server copied its own `debug.ts` / `native-feed.ts`; the TUI and api-client
  reimplemented their pieces as remote clients.
- The legacy Effect-v3 golden **baseline** (which booted `src/` in an isolated
  `effect@3.22.0` workspace) is retired with it. The committed snapshot
  (`apps/server/test/__snapshots__/golden.test.ts.snap`) is kept as the oracle,
  and `http-golden.test.ts` replays it against the new server — that new-server
  replay is now the standing gate.
- `apps/desktop` is intentionally outside the TypeScript build graph; it consumes
  the server's plain-text feed surface (see
  [../native-app-contract.md](../native-app-contract.md)).
- The single-job lock and the per-site runtime cache are in-process, so they
  still assume **one** server instance (as ADR 0001 already noted for sync).

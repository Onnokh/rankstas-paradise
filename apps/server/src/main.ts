// Canonical server entrypoint for Ranksta's Paradise.
//
// Boots the whole server as ONE bootable program: build the root Layer (Bun HTTP
// server + the HttpApi app + the bearer-gated `/mcp` mount) via the shared
// bootstrap, wire the real MCP adapter into the `/mcp` seam, then run everything
// under a single long-lived runtime with `Layer.launch` + `BunRuntime.runMain`.
// Because the whole process shares this one launched root Layer, each of its
// components is instantiated exactly once (Layer memoization within the runtime).
// The per-site `ManagedRuntime`s (runtime.ts) are intentionally one-per-site.
//
// Run with: `bun run apps/server/src/main.ts [--debug]`
// Config:   SEO_PORT (default 8790), RP_TOKEN (bearer), DEBUG / --debug.
//
// Deploy note: the daily Coolify scheduled task keeps the data warm by POSTing
// `/api/jobs/sync?site=<id>` per configured site (see the root Dockerfile header
// and apps/server/README.md; the full ADR 0002 is PLO-278).
import { Effect, Layer } from "effect"
import { BunRuntime } from "@effect/platform-bun"

import { Sync } from "@rp/domain/sync/sync"

import { bootstrap } from "./http/bootstrap.ts"
import { makeMcpMount } from "./http/mcp-mount.ts"
import { mountMcp } from "./http/mcp.ts"
import { Jobs } from "./jobs/jobs.ts"

const { port, debug, ctx, serverLayer } = await bootstrap()

// Wire the real MCP adapter into the already-bearer-gated `/mcp` route before
// the server starts accepting requests. The mount routes each tool call through
// the per-site runtime cache so tools get correctly per-site-scoped services.
mountMcp(makeMcpMount(ctx))

// Preserve the legacy startup line verbatim (port, debug/live mode, token state).
console.log(
  `Ranksta's Paradise server listening on http://0.0.0.0:${port} (${debug ? "debug" : "live"} mode, ${Bun.env.RP_TOKEN ? "token configured" : "NO TOKEN — set RP_TOKEN"})`,
)

// Resync every configured site once on boot, so a fresh deploy lands current
// data instead of waiting for the first read (reads warm lazily; a site nothing
// reads would otherwise sit stale until the daily cron). Fire-and-forget per
// site — each site's runtime owns its own single-job lock, so a boot sync can't
// interleave with a read-triggered warm for the same site, and different sites
// run independently. Best-effort: a JobAlreadyRunningError (a read beat us to
// it) or any sync failure is swallowed. Skipped in debug (never calls Google).
if (!debug) {
  void ctx
    .loadSites()
    .then((sites) => {
      for (const site of sites) {
        const rt = ctx.runtimeFor(site)
        const work = Effect.promise(() => rt.runPromise(Sync.use.syncSearchConsole()))
        void rt.runPromise(Jobs.use.startJob("sync", site.id, work)).catch(() => {})
      }
    })
    .catch(() => {})
}

BunRuntime.runMain(Layer.launch(serverLayer))

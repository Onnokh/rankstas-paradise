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
import { Layer } from "effect"
import { BunRuntime } from "@effect/platform-bun"

import { bootstrap } from "./http/bootstrap.ts"
import { makeMcpMount } from "./http/mcp-mount.ts"
import { mountMcp } from "./http/mcp.ts"

const { port, debug, ctx, serverLayer } = await bootstrap()

// Wire the real MCP adapter into the already-bearer-gated `/mcp` route before
// the server starts accepting requests. The mount routes each tool call through
// the per-site runtime cache so tools get correctly per-site-scoped services.
mountMcp(makeMcpMount(ctx))

// Preserve the legacy startup line verbatim (port, debug/live mode, token state).
console.log(
  `Ranksta's Paradise server listening on http://0.0.0.0:${port} (${debug ? "debug" : "live"} mode, ${Bun.env.RP_TOKEN ? "token configured" : "NO TOKEN — set RP_TOKEN"})`,
)

BunRuntime.runMain(Layer.launch(serverLayer))

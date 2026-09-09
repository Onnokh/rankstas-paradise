// Wires PLO-274's MCP adapter (apps/server/src/mcp/mcp.ts) into PLO-275's `/mcp`
// seam (./mcp.ts), bridging two impedance gaps:
//
//  1. Runtime scoping. The adapter's `run` seam is site-agnostic — the site
//     arrives inside each tool's `site` arg. Site-scoped services (Reports,
//     Storage, …) resolve `CurrentSite.current()` at LAYER CONSTRUCTION, so they
//     must be built per-site, not on the global die-stub. We therefore route each
//     tool call to the per-site `ManagedRuntime` (runtime.ts's cache, the same
//     mechanism the HTTP handlers use), keyed by the tool's `site` arg. An
//     unknown site falls back to any site's runtime purely so the adapter's own
//     `CurrentSite.layerFor` can surface the `UnknownSiteError` as a structured
//     MCP error result (it fails before any Reports work runs).
//
//  2. Site settings. A Market read has to see the stored catalog entry and a
//     Market write has to retire the Site's cached runtime, so neither can run
//     inside one. Both are wired to the same ServerContext the HTTP settings
//     route uses, so the two surfaces write the catalog the same way.
//
//  3. Transport shape. The adapter is a Web-standard `(Request) => Promise<Response>`;
//     the seam expects an Effect over the platform's request/response. We convert
//     at the boundary and never leak an error out of the route (any failure maps
//     to a 500 body, matching a raw handler crash).
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

import { Config } from "@rp/domain/config/config"

import { mcpHandler, type MarketTool, type RunTool } from "../mcp/mcp.ts"
import { type McpHandler } from "./mcp.ts"
import { type ServerContext } from "./runtime.ts"

export const makeMcpMount = (ctx: ServerContext): McpHandler => {
  // Site-aware runner: pick the per-site runtime so `Reports` is scoped to the
  // right site — its `CurrentSite` was bound at layer construction there. Unknown
  // site → any runtime, where the effect's own `CurrentSite.layerFor` raises
  // UnknownSiteError and the adapter maps it to a structured error (it fails
  // before any Reports work runs).
  //
  // The per-site runtime keeps `Config` internal (provided, not exposed), and the
  // adapter's `CurrentSite.layerFor` rebuild needs it, so we supply `Config` at
  // this boundary; `Reports` + `Sites` come from the runtime. The rebuilt
  // CurrentSite is inert (Reports is already bound) — it only satisfies the seam.
  const run: RunTool = async (siteId, effect) => {
    const site = await ctx.siteFor(siteId).catch(() => ctx.firstSite())
    const runnable = effect.pipe(Effect.provide(Config.defaultLayer))
    return (await ctx.runtimeFor(site)).runPromise(runnable)
  }

  // Straight through to the catalog operations: the pair a write names is
  // already checked against the Market table at the tool boundary, and the
  // runtime drop happens inside `setMarket`.
  const market: MarketTool = {
    read: (site, search) => ctx.catalog.market(site, search),
    set: (site, chosen) => ctx.catalog.setMarket(site, chosen),
  }

  const webHandler = mcpHandler(run, market)

  return (request) =>
    HttpServerRequest.toWeb(request).pipe(
      Effect.flatMap((webRequest) => Effect.promise(() => webHandler(webRequest))),
      Effect.map(HttpServerResponse.fromWeb),
      Effect.catchCause(() =>
        Effect.succeed(
          HttpServerResponse.text("MCP request failed", { status: 500 }),
        ),
      ),
    )
}

// Shared server bootstrap — the SINGLE place the HTTP server graph is built.
//
// The canonical entrypoint (apps/server/src/main.ts) and the golden suite both
// go through here, so there is exactly one server definition (no second,
// divergent copy). `bootstrap()` reads config once, builds the per-site runtime
// cache (runtime.ts), assembles the HttpApi app + the `/mcp` mount + the global
// bearer middleware, and returns a launchable root Layer plus the context the
// caller needs to mount MCP and log startup.
//
// It does NOT run anything: the caller launches `serverLayer` under a single
// long-lived runtime (`Layer.launch` + `BunRuntime.runMain`) so the whole
// process shares one root layer instantiation (see main.ts).
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { BunHttpServer } from "@effect/platform-bun"

import { Api } from "./api.ts"
import { makeApiGroup } from "./handlers.ts"
import { healthRoute } from "./health.ts"
import { bearerLayer } from "./middleware.ts"
import { mcpRoute } from "./mcp.ts"
import { makeServerContext, type ServerContext } from "./runtime.ts"

export interface Boot {
  readonly port: number
  readonly debug: boolean
  readonly ctx: ServerContext
  // The launchable root Layer: the Bun HTTP server serving the composed app.
  readonly serverLayer: Layer.Layer<never>
}

export const bootstrap = async (): Promise<Boot> => {
  // Debug is config (the domain Config reads DEBUG). Bridge the legacy `--debug`
  // CLI flag into that env before the runtime reads it.
  if (process.argv.includes("--debug")) process.env.DEBUG = "true"

  const port = Number(Bun.env.SEO_PORT ?? 8790)

  const ctx = await makeServerContext()

  // The API routes + their handlers, the raw `/mcp` mount, the unauthenticated
  // `/health` liveness route, and a global bearer middleware that wraps every
  // route so nothing (bar `/health`) is served unauthenticated.
  const apiLayer = HttpApiBuilder.layer(Api).pipe(Layer.provide(makeApiGroup(ctx)))
  const appLayer = Layer.mergeAll(apiLayer, mcpRoute, healthRoute, bearerLayer(ctx.debug))

  // Bind 0.0.0.0 — the container sits behind Coolify's TLS proxy, so it must
  // listen on all interfaces rather than loopback (ported from the legacy serve).
  const serverLayer = HttpRouter.serve(appLayer).pipe(
    Layer.provide(BunHttpServer.layer({ port, hostname: "0.0.0.0" })),
  )

  return { port, debug: ctx.debug, ctx, serverLayer }
}

// Bootable HTTP server entry — the Effect HttpApi (api.ts) served over
// @effect/platform-bun's BunHttpServer, bearer-gated on every route (including
// the /mcp mount), binding the port from SEO_PORT (default 8790).
//
// This is its OWN entry; it does NOT replace apps/server/src/main.ts. The
// canonical entrypoint + root Layer + Docker wiring is PLO-276. The golden
// suite points `RP_GOLDEN_SERVER_ENTRY` at this file to replay the committed
// snapshots against the new server.
//
// PLO-276: call `mountMcp(handler)` (from ./mcp.ts) before importing/booting to
// wire the real MCP adapter into the already-gated /mcp route.
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"

import { Api } from "./api.ts"
import { makeApiGroup } from "./handlers.ts"
import { bearerLayer } from "./middleware.ts"
import { mcpRoute } from "./mcp.ts"
import { makeServerContext } from "./runtime.ts"

// Debug is config (the domain Config reads DEBUG). Bridge the legacy `--debug`
// CLI flag the golden harness passes into that env before the runtime is built.
if (process.argv.includes("--debug")) process.env.DEBUG = "true"

const port = Number(Bun.env.SEO_PORT ?? 8790)

const main = async () => {
  const ctx = await makeServerContext()

  // The API routes + their handlers, the raw /mcp mount, and a global bearer
  // middleware that wraps every route so nothing is served unauthenticated.
  const apiLayer = HttpApiBuilder.layer(Api).pipe(Layer.provide(makeApiGroup(ctx)))
  const appLayer = Layer.mergeAll(apiLayer, mcpRoute, bearerLayer(ctx.debug))

  const serverLayer = HttpRouter.serve(appLayer).pipe(
    Layer.provide(BunHttpServer.layer({ port })),
  )

  BunRuntime.runMain(Layer.launch(serverLayer))
}

void main()

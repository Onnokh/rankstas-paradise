// The `/mcp` mount point — a seam for the MCP adapter (PLO-274) that PLO-276
// wires in. The bearer middleware already gates every route including this one,
// so the MCP tools are bearer-protected for free (as in the legacy server).
//
// PLO-276 calls `mountMcp(handler)` at boot with the real Web-Standard MCP
// request handler; until then the route responds 501 so the path exists and
// stays authenticated. We deliberately do NOT import `apps/server/src/mcp`
// here — that module may not exist on this branch.
import { Effect } from "effect"
import {
  HttpRouter,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"

// The request→response handler shape the MCP adapter supplies. Returns an
// Effect so the adapter can run its own decoding/encoding in the Effect world.
export type McpHandler = (
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<HttpServerResponse.HttpServerResponse>

let handler: McpHandler | undefined

// PLO-276 seam: register the real MCP handler before the server boots.
export const mountMcp = (mcpHandler: McpHandler): void => {
  handler = mcpHandler
}

// A router layer that serves POST/GET/etc. `/mcp` through the mounted handler,
// or a 501 stub until one is mounted.
export const mcpRoute = HttpRouter.use((router) =>
  router.add("*", "/mcp", (request) =>
    handler
      ? handler(request)
      : Effect.succeed(
          HttpServerResponse.text("MCP is not mounted", { status: 501 }),
        ),
  ),
)

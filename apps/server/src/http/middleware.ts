// A bearer token guards every request — no internal/external distinction, so
// the check stays one branch (see ADR 0001). Installed as a GLOBAL router
// middleware so it wraps ALL routes, including the `/mcp` mount, exactly as the
// legacy `requireBearer` did, and can replace the response with a 401/503
// short-circuit.
//
// Two kinds of token are accepted: the shared RP_TOKEN from the environment
// (the bootstrap and break-glass credential) and the per-client tokens the
// Clients service issues (`rp_…`), looked up by hash through `auth`.
//
// Fail-closed semantics:
//   - nothing could authenticate (no RP_TOKEN and no active client) -> 503
//   - missing or wrong bearer                                         -> 401
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"

import { HEALTH_PATH } from "./health.ts"
import { errorEnvelope } from "./response.ts"

const BEARER_PREFIX = "Bearer "

// The per-client half of the check, supplied by the server context.
export interface BearerAuth {
  // Whether a presented token belongs to an active client.
  readonly accepts: (token: string) => Promise<boolean>
  // Whether any client could authenticate at all.
  readonly hasActiveClient: () => Promise<boolean>
}

export const bearerLayer = (debug: boolean, auth: BearerAuth) =>
  HttpRouter.middleware(
    (app) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        // The liveness probe is exempt from auth (ported from the legacy
        // `/health`, which returned before `requireBearer`): it must answer even
        // when RP_TOKEN is unset, so the container health check works standalone.
        if (request.url.split("?")[0] === HEALTH_PATH) {
          return yield* app
        }
        const expected = Bun.env.RP_TOKEN
        const header = (request.headers as Record<string, string | undefined>)[
          "authorization"
        ]
        const token = header?.startsWith(BEARER_PREFIX)
          ? header.slice(BEARER_PREFIX.length)
          : null
        // Plain string compare: the shared token is a static single-tenant
        // secret behind Coolify's TLS proxy, so a constant-time compare isn't
        // worth it here.
        if (token && expected && token === expected) return yield* app
        if (token && (yield* Effect.promise(() => auth.accepts(token)))) return yield* app
        // Fail closed: with no RP_TOKEN and no client the server refuses
        // everything rather than silently serving the data unauthenticated.
        if (!expected && !(yield* Effect.promise(() => auth.hasActiveClient()))) {
          return errorEnvelope("server misconfigured: set RP_TOKEN", debug, 503)
        }
        return errorEnvelope("unauthorized", debug, 401)
      }),
    { global: true },
  )

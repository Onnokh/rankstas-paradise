// A single static bearer token guards every request — no internal/external
// distinction, so the check stays one branch (see ADR 0001). Installed as a
// GLOBAL router middleware so it wraps ALL routes, including the `/mcp` mount,
// exactly as the legacy `requireBearer` did, and can replace the response with
// a 401/503 short-circuit.
//
// Fail-closed semantics, ported verbatim:
//   - no RP_TOKEN configured  -> 503 { error: "server misconfigured: set RP_TOKEN" }
//   - missing or wrong bearer  -> 401 { error: "unauthorized" }
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"

import { HEALTH_PATH } from "./health.ts"
import { errorEnvelope } from "./response.ts"

const BEARER_PREFIX = "Bearer "

export const bearerLayer = (debug: boolean) =>
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
        // Fail closed: if RP_TOKEN is unset the server refuses everything rather
        // than silently serving the data unauthenticated.
        if (!expected) {
          return errorEnvelope("server misconfigured: set RP_TOKEN", debug, 503)
        }
        const header = (request.headers as Record<string, string | undefined>)[
          "authorization"
        ]
        const token = header?.startsWith(BEARER_PREFIX)
          ? header.slice(BEARER_PREFIX.length)
          : null
        // Plain string compare: the token is a static single-tenant secret behind
        // Coolify's TLS proxy, so a constant-time compare isn't worth it here.
        if (token !== expected) {
          return errorEnvelope("unauthorized", debug, 401)
        }
        return yield* app
      }),
    { global: true },
  )

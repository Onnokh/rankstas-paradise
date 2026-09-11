// A bearer token guards every request — no internal/external distinction, so
// the check stays one branch (see ADR 0001). Installed as a GLOBAL router
// middleware so it wraps ALL routes, including the `/mcp` mount, exactly as the
// legacy `requireBearer` did, and can replace the response with a 401/503
// short-circuit.
//
// Three kinds of caller are accepted:
//   - the shared RP_TOKEN from the environment (the bootstrap and break-glass
//     credential, checked first and needing no database at all);
//   - a per-client API key (`rp_…`), verified by Better Auth;
//   - a signed-in person, carrying a Better Auth session.
//
// The session branch is why sign-in is worth having at all: a person who signed
// in with Google reaches the API with no key to copy anywhere. Who may sign in
// is fixed by the allowlist in auth.ts, not here.
//
// Fail-closed semantics:
//   - nothing could authenticate (no RP_TOKEN and no active client) -> 503
//   - missing or wrong credential                                    -> 401
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"

import { AUTH_PATH } from "../auth/auth.ts"
import { HEALTH_PATH } from "./health.ts"
import { errorEnvelope } from "./response.ts"

const BEARER_PREFIX = "Bearer "

// The per-client half of the check, supplied by the server context.
export interface BearerAuth {
  // Whether a presented token belongs to an active client.
  readonly accepts: (token: string) => Promise<boolean>
  // Whether the request's own headers carry a valid session.
  readonly acceptsSession: (headers: Headers) => Promise<boolean>
  // Whether any client could authenticate at all.
  readonly hasActiveClient: () => Promise<boolean>
}

export const bearerLayer = (debug: boolean, auth: BearerAuth) =>
  HttpRouter.middleware(
    (app) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const path = request.url.split("?")[0] ?? ""
        // The liveness probe is exempt from auth (ported from the legacy
        // `/health`, which returned before `requireBearer`): it must answer even
        // when RP_TOKEN is unset, so the container health check works standalone.
        if (path === HEALTH_PATH) {
          return yield* app
        }
        // Better Auth's own subtree is exempt for the same structural reason:
        // these are the routes a caller uses to GET a credential, so requiring
        // one would close the only door in.
        if (path === AUTH_PATH || path.startsWith(`${AUTH_PATH}/`)) {
          return yield* app
        }
        const expected = Bun.env.RP_TOKEN
        const headers = request.headers as Record<string, string | undefined>
        const header = headers["authorization"]
        const token = header?.startsWith(BEARER_PREFIX)
          ? header.slice(BEARER_PREFIX.length)
          : null
        // Plain string compare: the shared token is a static single-tenant
        // secret behind Coolify's TLS proxy, so a constant-time compare isn't
        // worth it here.
        if (token && expected && token === expected) return yield* app
        if (token && (yield* Effect.promise(() => auth.accepts(token)))) return yield* app
        // Only asked once the token branches have failed, so a machine caller
        // never pays for a session lookup it will not use.
        const webHeaders = new Headers()
        for (const [name, value] of Object.entries(headers)) {
          if (value !== undefined) webHeaders.set(name, value)
        }
        if (yield* Effect.promise(() => auth.acceptsSession(webHeaders)))
          return yield* app
        // Fail closed: with no RP_TOKEN and no client the server refuses
        // everything rather than silently serving the data unauthenticated.
        if (!expected && !(yield* Effect.promise(() => auth.hasActiveClient()))) {
          return errorEnvelope("server misconfigured: set RP_TOKEN", debug, 503)
        }
        return errorEnvelope("unauthorized", debug, 401)
      }),
    { global: true },
  )

// The `/api/auth/*` mount: Better Auth's own routes, served through the same
// Bun server as everything else.
//
// Better Auth is a Web-standard `(Request) => Promise<Response>` handler, so
// this bridges the Effect request in and the Web response out, exactly as the
// `/mcp` mount does for the MCP adapter.
//
// This subtree is the one place the bearer wall stands aside (see
// middleware.ts): signing in cannot require already being signed in. Everything
// under it is Better Auth's own business — the Google redirect, the callback,
// the session endpoints — and each one authenticates on its own terms.
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

import { AUTH_PATH, type Auth } from "../auth/auth.ts"

export const authRoute = (auth: Auth) =>
  HttpRouter.use((router) =>
    router.add("*", `${AUTH_PATH}/*`, (request) =>
      HttpServerRequest.toWeb(request).pipe(
        Effect.flatMap((webRequest) =>
          Effect.promise(() => auth.handler(webRequest)),
        ),
        Effect.map(HttpServerResponse.fromWeb),
        // A crash inside the auth handler must not take the server's request
        // loop with it; the caller gets a 500 like any other failed route.
        Effect.catchCause(() =>
          Effect.succeed(
            HttpServerResponse.text("Authentication failed", { status: 500 }),
          ),
        ),
      ),
    ),
  )

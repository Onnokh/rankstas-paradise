// Unauthenticated liveness route for the container health check (see the root
// Dockerfile HEALTHCHECK). Mounted as a raw router route and served through the
// same app as everything else, but the global bearer middleware (middleware.ts)
// explicitly exempts HEALTH_PATH — the probe carries no site data and must
// answer even when RP_TOKEN is unset, so it needs no token. Ported from the
// legacy `/health`, which returned before `requireBearer`.
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"

export const HEALTH_PATH = "/health"

export const healthRoute = HttpRouter.add(
  "GET",
  HEALTH_PATH,
  HttpServerResponse.text("ok"),
)

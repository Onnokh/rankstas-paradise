// HTTP API over the service layer, so any frontend (native app, web, agent)
// can consume the same data the CLI and TUI show. Hosted as a Coolify service
// (see ADR 0001): binds 0.0.0.0 behind the proxy, gated by a bearer token on
// every request, and owns the SQLite/CSV/token state on a persistent volume.
//
// JSON endpoints live under /api/*, agents connect over MCP at /mcp, and the
// /pages.txt endpoint serves a pipe-delimited line format for the Native SDK
// app, whose app-core subset has no JSON parser.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"

import { backfillSearchConsole, syncSearchConsole } from "./automation.ts"
import { debugMode } from "./config.ts"
import { buildMcpServer } from "./mcp.ts"
import { loadSites, siteFor, withSite } from "./site.ts"
import { feedFor, type FeedView } from "./native-feed.ts"
import { type RegistryPatch } from "./registry.ts"
import {
  historyReport,
  logAdd,
  logList,
  opportunitiesReport,
  pageReport,
  pagesReport,
  queriesReport,
  registryAdd,
  registryList,
  registrySet,
  statusReport,
} from "./service.ts"

const port = Number(Bun.env.SEO_PORT ?? 8790)

type JobName = "sync" | "backfill"

type Job = {
  readonly id: number
  readonly name: JobName
  readonly siteId: string
  status: "running" | "done" | "failed"
  readonly startedAt: string
  finishedAt: string | null
  message: string | null
}

// Google-touching jobs run one at a time: syncs use delete-then-insert
// transactions that must not interleave.
const jobs: Job[] = []
let nextJobId = 1

const runningJob = () => jobs.find((job) => job.status === "running")

const startJob = (name: JobName, siteId: string, work: () => Promise<string>): Job | null => {
  if (runningJob()) return null
  const job: Job = { id: nextJobId++, name, siteId, status: "running", startedAt: new Date().toISOString(), finishedAt: null, message: null }
  jobs.push(job)
  work()
    .then((message) => {
      job.status = "done"
      job.message = message
    })
    .catch((cause) => {
      job.status = "failed"
      job.message = cause instanceof Error ? cause.message : String(cause)
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString()
    })
  return job
}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify({ generatedAt: new Date().toISOString(), mode: debugMode ? "debug" : "live", ...(payload as object) }, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  })

const badRequest = (message: string) => json({ error: message }, 400)

// A single static bearer token guards every request — no internal/external
// distinction, so the check stays one branch (see ADR 0001). Fail closed: if
// RP_TOKEN is unset the server refuses everything rather than silently serving
// the data unauthenticated. Returns a Response to short-circuit `handle`, or
// null when the caller is authorized.
const requireBearer = (request: Request): Response | null => {
  const expected = Bun.env.RP_TOKEN
  if (!expected) return json({ error: "server misconfigured: set RP_TOKEN" }, 503)
  const header = request.headers.get("authorization")
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
  // Plain string compare: the token is a static single-tenant secret behind
  // Coolify's TLS proxy, so the timing-attack surface isn't worth a
  // constant-time compare here.
  if (token !== expected) return json({ error: "unauthorized" }, 401)
  return null
}

const numberParam = (url: URL, name: string): number | undefined => {
  const value = url.searchParams.get(name)
  if (value === null) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number, got: ${value}`)
  return parsed
}

const pagesLines = async (windowDays = 28): Promise<string> => {
  const report = await pagesReport(windowDays)
  const lines = report.pages.map((page) => {
    const metrics = (page.trueTotals ?? page.allQueries)?.current ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 }
    return [
      page.path,
      metrics.clicks,
      metrics.impressions,
      `${(metrics.ctr * 100).toFixed(1)}%`,
      metrics.position.toFixed(1),
    ].join("|")
  })
  const header = `latest=${report.window.currentEnd ?? "none"}|window=${report.window.currentStart ?? "?"}..${report.window.currentEnd ?? "?"}`
  return [header, ...lines].join("\n")
}

const handle = async (request: Request): Promise<Response> => {
  const denied = requireBearer(request)
  if (denied) return denied
  const url = new URL(request.url)
  const route = `${request.method} ${url.pathname}`
  if (route === "GET /api/sites") return json({ sites: await loadSites() })
  // Plain-text site catalog for the Native SDK app (no JSON parser): one
  // `id\tname` line per site.
  if (route === "GET /sites.txt") {
    const sites = await loadSites()
    return new Response(sites.map((candidate) => `${candidate.id}\t${candidate.name}`).join("\n"), { headers: { "content-type": "text/plain" } })
  }
  // MCP surface for agents (see mcp.ts and ADR 0001). requireBearer above
  // already gated this, so the tools are bearer-protected for free. A fresh
  // stateless server+transport per request keeps JSON-RPC state isolated; the
  // Web Standard transport speaks Bun's Request/Response fetch model directly.
  if (url.pathname === "/mcp") {
    const mcp = buildMcpServer()
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await mcp.connect(transport)
    return transport.handleRequest(request)
  }
  const site = await siteFor(url.searchParams.get("site") ?? "sleevy")
  switch (route) {
    case "GET /api/status": return json(await withSite(site, () => statusReport()))
    case "GET /api/pages": return json(await withSite(site, () => pagesReport(numberParam(url, "window") ?? 28)))
    case "GET /api/page": {
      const path = url.searchParams.get("path")
      if (!path || !path.startsWith("/")) return badRequest("page requires ?path=</path>")
      return json(await withSite(site, () => pageReport(path)))
    }
    case "GET /api/queries": return json(await withSite(site, () => queriesReport({
      page: url.searchParams.get("page") ?? undefined,
      windowDays: numberParam(url, "window"),
      minImpressions: numberParam(url, "min-impressions"),
      includeBrand: url.searchParams.get("include-brand") === "true",
      limit: numberParam(url, "limit"),
    })))
    case "GET /api/opportunities": return json(await withSite(site, () => opportunitiesReport(url.searchParams.get("kind") ?? undefined)))
    case "GET /api/registry": return json(await withSite(site, () => registryList()))
    case "POST /api/registry": {
      const body = await request.json() as Parameters<typeof registryAdd>[0]
      return json(await withSite(site, () => registryAdd(body)))
    }
    case "PATCH /api/registry": {
      const body = await request.json() as { target?: string; keyword?: string; patch?: RegistryPatch }
      const target = body.target
      if (!target) return badRequest("registry set requires target")
      return json(await withSite(site, () => registrySet(target, body.keyword, body.patch ?? {})))
    }
    case "GET /api/log": return json(await withSite(site, () => logList(url.searchParams.get("path") ?? undefined)))
    case "POST /api/log": {
      const body = await request.json() as Parameters<typeof logAdd>[0]
      return json(await withSite(site, () => logAdd(body)))
    }
    case "GET /api/history": return json(await withSite(site, () => historyReport(numberParam(url, "limit") ?? 28)))
    case "GET /api/jobs": return json({ jobs })
    case "POST /api/jobs/sync": {
      const job = startJob("sync", site.id, () => withSite(site, syncSearchConsole))
      return job ? json({ job }, 202) : json({ error: `a ${runningJob()!.name} job is already running` }, 409)
    }
    case "POST /api/jobs/backfill": {
      const body = await request.json().catch(() => ({})) as { months?: number }
      const job = startJob("backfill", site.id, () => withSite(site, () => backfillSearchConsole(body.months ?? 16)))
      return job ? json({ job }, 202) : json({ error: `a ${runningJob()!.name} job is already running` }, 409)
    }
    case "GET /pages.txt": return new Response(await withSite(site, () => pagesLines(numberParam(url, "window") ?? 28)), { headers: { "content-type": "text/plain" } })
    case "GET /tui/home.txt":
    case "GET /tui/opportunities.txt":
    case "GET /tui/history.txt":
    case "GET /tui/registry.txt":
    case "GET /tui/log.txt": {
      const view = url.pathname.slice("/tui/".length, -".txt".length) as FeedView
      return new Response(await withSite(site, () => feedFor(view)), { headers: { "content-type": "text/plain" } })
    }
    default: return json({ error: `no route: ${route}` }, 404)
  }
}

Bun.serve({
  port,
  // Behind Coolify's proxy now, so bind all interfaces rather than loopback.
  hostname: "0.0.0.0",
  fetch: (request) =>
    handle(request).catch((cause) => badRequest(cause instanceof Error ? cause.message : String(cause))),
})

console.log(`Ranksta’s Paradise server listening on http://0.0.0.0:${port} (${debugMode ? "debug" : "live"} mode, ${Bun.env.RP_TOKEN ? "token configured" : "NO TOKEN — set RP_TOKEN"})`)

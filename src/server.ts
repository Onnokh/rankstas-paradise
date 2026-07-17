// HTTP API over the service layer, so any frontend (native app, web, agent)
// can consume the same data the CLI and TUI show. Local-only by design:
// binds 127.0.0.1 and reuses the local SQLite/CSV/token state.
//
// JSON endpoints live under /api/*. The /pages.txt endpoint serves a
// pipe-delimited line format for the Native SDK app, whose app-core subset
// has no JSON parser.
import { backfillSearchConsole, syncSearchConsole } from "./automation.ts"
import { debugMode } from "./config.ts"
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

const startJob = (name: JobName, work: () => Promise<string>): Job | null => {
  if (runningJob()) return null
  const job: Job = { id: nextJobId++, name, status: "running", startedAt: new Date().toISOString(), finishedAt: null, message: null }
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
  const url = new URL(request.url)
  const route = `${request.method} ${url.pathname}`
  switch (route) {
    case "GET /api/status": return json(await statusReport())
    case "GET /api/pages": return json(await pagesReport(numberParam(url, "window") ?? 28))
    case "GET /api/page": {
      const path = url.searchParams.get("path")
      if (!path || !path.startsWith("/")) return badRequest("page requires ?path=</path>")
      return json(await pageReport(path))
    }
    case "GET /api/queries": return json(await queriesReport({
      page: url.searchParams.get("page") ?? undefined,
      windowDays: numberParam(url, "window"),
      minImpressions: numberParam(url, "min-impressions"),
      includeBrand: url.searchParams.get("include-brand") === "true",
      limit: numberParam(url, "limit"),
    }))
    case "GET /api/opportunities": return json(await opportunitiesReport(url.searchParams.get("kind") ?? undefined))
    case "GET /api/registry": return json(await registryList())
    case "POST /api/registry": return json(await registryAdd(await request.json() as Parameters<typeof registryAdd>[0]))
    case "PATCH /api/registry": {
      const body = await request.json() as { target?: string; keyword?: string; patch?: RegistryPatch }
      if (!body.target) return badRequest("registry set requires target")
      return json(await registrySet(body.target, body.keyword, body.patch ?? {}))
    }
    case "GET /api/log": return json(logList(url.searchParams.get("path") ?? undefined))
    case "POST /api/log": return json(logAdd(await request.json() as Parameters<typeof logAdd>[0]))
    case "GET /api/history": return json(historyReport(numberParam(url, "limit") ?? 28))
    case "GET /api/jobs": return json({ jobs })
    case "POST /api/jobs/sync": {
      const job = startJob("sync", syncSearchConsole)
      return job ? json({ job }, 202) : json({ error: `a ${runningJob()!.name} job is already running` }, 409)
    }
    case "POST /api/jobs/backfill": {
      const body = await request.json().catch(() => ({})) as { months?: number }
      const job = startJob("backfill", () => backfillSearchConsole(body.months ?? 16))
      return job ? json({ job }, 202) : json({ error: `a ${runningJob()!.name} job is already running` }, 409)
    }
    case "GET /pages.txt": return new Response(await pagesLines(numberParam(url, "window") ?? 28), { headers: { "content-type": "text/plain" } })
    case "GET /tui/home.txt":
    case "GET /tui/opportunities.txt":
    case "GET /tui/history.txt":
    case "GET /tui/registry.txt": {
      const view = url.pathname.slice("/tui/".length, -".txt".length) as FeedView
      return new Response(await feedFor(view), { headers: { "content-type": "text/plain" } })
    }
    default: return json({ error: `no route: ${route}` }, 404)
  }
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch: (request) =>
    handle(request).catch((cause) => badRequest(cause instanceof Error ? cause.message : String(cause))),
})

console.log(`sleevy-seo server listening on http://127.0.0.1:${port} (${debugMode ? "debug" : "live"} mode)`)

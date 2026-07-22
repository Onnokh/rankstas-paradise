// Handler implementations for the HttpApi group. Each handler returns a fully
// built `HttpServerResponse` (the `{ generatedAt, mode, ... }` JSON envelope or a
// text feed), so response bytes exactly reproduce the legacy `src/server.ts`.
//
// The domain work runs on the per-site `ManagedRuntime` from runtime.ts (which
// binds the real CurrentSite). Handlers wrap that in `Effect.promise`, so the
// HttpApi handler effects carry no service requirements of their own.
//
// Route → behaviour is a 1:1 port of the legacy server:
//   - site-scoped routes require ?site= (missing -> 400) and warm the site on
//     GET reads (non-debug), fire-and-forget;
//   - number params validate to a positive number (bad -> 400);
//   - POST /api/jobs/sync seeds the debug fixture in --debug mode (closing the
//     seeding gap the new Sync dropped) and returns the legacy summary string.
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { type HttpServerResponse } from "effect/unstable/http"

import { Jobs } from "../jobs/jobs.ts"
import { JobAlreadyRunningError } from "../jobs/schema.ts"
import { Reports } from "@rp/domain/reports/reports"
import { Storage } from "@rp/domain/storage/storage"
import { Sync } from "@rp/domain/sync/sync"
import { type RegistryPatch } from "@rp/domain/registry/schema"
import { SiteId } from "@rp/domain/sites/schema"
import { type Site } from "@rp/domain/sites/schema"

import { debugDailyTotals, debugDates, debugSnapshots } from "../debug.ts"
import { feedFor, type FeedView } from "../native-feed.ts"
import { Api } from "./api.ts"
import { errorEnvelope, jsonEnvelope, plainText } from "./response.ts"
import { type ServerContext, type SiteRuntime } from "./runtime.ts"

// Parse a positive-number query param; undefined when absent. Throws on an
// invalid value so the caller maps it to a 400 (legacy numberParam semantics).
const numberParam = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got: ${value}`)
  }
  return parsed
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const SITE_REQUIRED = "site is required: add ?site=<id> (see GET /api/sites)"

// Site-scoped Sync effects, run on the site runtime by the job handlers.
const SyncEffect = Sync.use.syncSearchConsole()
const BackfillEffect = (months: number) => Sync.use.backfillSearchConsole(months)

export const makeApiGroup = (ctx: ServerContext) => {
  // Resolve ?site= to a Site, or a short-circuit 400 response.
  const resolveSite = async (
    siteParam: string | undefined,
  ): Promise<Site | HttpServerResponse.HttpServerResponse> => {
    if (!siteParam) return errorEnvelope(SITE_REQUIRED, ctx.debug, 400)
    try {
      return await ctx.siteFor(SiteId.make(siteParam))
    } catch (cause) {
      return errorEnvelope(messageOf(cause), ctx.debug, 400)
    }
  }

  // Warm the site on GET reads (non-debug), fire-and-forget — never disturbs the
  // read. Legacy `maybeEnqueueSync` no-ops in debug, so we skip it there.
  const warm = (rt: SiteRuntime, site: Site): void => {
    if (ctx.debug) return
    void rt.runPromise(Jobs.use.warmOnRead(site.id)).then(
      () => {},
      () => {},
    )
  }

  // Run a site-scoped JSON read: resolve site, warm, run the report effect on
  // the site runtime, and wrap the payload in the envelope. Any failure maps to
  // a 400 with the error text (legacy caught every handler throw as a 400).
  const siteJson = async <A extends object>(
    siteParam: string | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    effect: Effect.Effect<A, unknown, any>,
  ): Promise<HttpServerResponse.HttpServerResponse> => {
    const site = await resolveSite(siteParam)
    if (!("id" in site)) return site
    const rt = ctx.runtimeFor(site)
    warm(rt, site)
    try {
      const payload = await rt.runPromise(effect)
      return jsonEnvelope(payload, ctx.debug)
    } catch (cause) {
      return errorEnvelope(messageOf(cause), ctx.debug, 400)
    }
  }

  // Run a site-scoped text feed: resolve site, warm, render, serve text/plain.
  const siteText = async (
    siteParam: string | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    effect: Effect.Effect<string, unknown, any>,
  ): Promise<HttpServerResponse.HttpServerResponse> => {
    const site = await resolveSite(siteParam)
    if (!("id" in site)) return site
    const rt = ctx.runtimeFor(site)
    warm(rt, site)
    try {
      const body = await rt.runPromise(effect)
      return plainText(body)
    } catch (cause) {
      return errorEnvelope(messageOf(cause), ctx.debug, 400)
    }
  }

  // pages.txt: pipe-delimited page lines for the Native SDK app (no JSON parser).
  const pagesLines = (windowDays: number) =>
    Effect.gen(function* () {
      const report = yield* Reports.use.pagesReport(windowDays)
      const lines = report.pages.map((page) => {
        const metrics = (page.trueTotals ?? page.allQueries)?.current ?? {
          clicks: 0,
          impressions: 0,
          ctr: 0,
          position: 0,
        }
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
    })

  const tuiFeed = (siteParam: string | undefined, view: FeedView) =>
    siteText(siteParam, feedFor(view))

  // Start a job (sync/backfill). In --debug mode the sync work seeds the debug
  // fixture and returns the legacy summary; live mode runs the real Sync. The
  // work is fully provided by the site runtime before it reaches Jobs.
  const startJob = async (
    siteParam: string | undefined,
    name: "sync" | "backfill",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    work: (rt: SiteRuntime) => Promise<string>,
  ): Promise<HttpServerResponse.HttpServerResponse> => {
    const site = await resolveSite(siteParam)
    if (!("id" in site)) return site
    const rt = ctx.runtimeFor(site)
    const workEffect: Effect.Effect<string, unknown> = Effect.promise(() =>
      work(rt),
    )
    try {
      const job = await rt.runPromise(Jobs.use.startJob(name, site.id, workEffect))
      return jsonEnvelope({ job }, ctx.debug, 202)
    } catch (cause) {
      if (cause instanceof JobAlreadyRunningError) {
        return errorEnvelope(`a ${name} job is already running`, ctx.debug, 409)
      }
      return errorEnvelope(messageOf(cause), ctx.debug, 400)
    }
  }

  // The debug seed effect — writes the fixture straight into Storage, returning
  // the exact legacy summary string the golden snapshot asserts.
  const seedDebug = (rt: SiteRuntime): Promise<string> =>
    rt.runPromise(
      Effect.gen(function* () {
        yield* Storage.use.saveSnapshots(debugSnapshots, debugDates)
        yield* Storage.use.saveDailyTotals(debugDailyTotals, debugDates)
        return `Saved ${debugSnapshots.length} fake rows to the isolated debug database.`
      }),
    )

  const runSync = (rt: SiteRuntime): Promise<string> =>
    ctx.debug ? seedDebug(rt) : rt.runPromise(SyncEffect)

  return HttpApiBuilder.group(Api, "api", (handlers) =>
    handlers
      .handle("sites", () =>
        Effect.promise(async () =>
          jsonEnvelope({ sites: await ctx.loadSites() }, ctx.debug),
        ),
      )
      .handle("status", ({ query }) =>
        Effect.promise(() => siteJson(query.site, Reports.use.statusReport())),
      )
      .handle("dashboard", ({ query }) =>
        Effect.promise(() =>
          siteJson(query.site, Reports.use.dashboardSnapshot()),
        ),
      )
      .handle("pages", ({ query }) =>
        Effect.promise(async () => {
          let windowDays: number | undefined
          try {
            windowDays = numberParam(query.window, "window")
          } catch (cause) {
            return errorEnvelope(messageOf(cause), ctx.debug, 400)
          }
          return siteJson(query.site, Reports.use.pagesReport(windowDays ?? 28))
        }),
      )
      .handle("page", ({ query }) =>
        Effect.promise(() => {
          const path = query.path
          if (!path || !path.startsWith("/")) {
            return Promise.resolve(
              errorEnvelope("page requires ?path=</path>", ctx.debug, 400),
            )
          }
          return siteJson(query.site, Reports.use.pageReport(path))
        }),
      )
      .handle("queries", ({ query }) =>
        Effect.promise(async () => {
          try {
            const options = {
              page: query.page ?? undefined,
              windowDays: numberParam(query.window, "window"),
              minImpressions: numberParam(query["min-impressions"], "min-impressions"),
              includeBrand: query["include-brand"] === "true",
              limit: numberParam(query.limit, "limit"),
            }
            return await siteJson(query.site, Reports.use.queriesReport(options))
          } catch (cause) {
            return errorEnvelope(messageOf(cause), ctx.debug, 400)
          }
        }),
      )
      .handle("opportunities", ({ query }) =>
        Effect.promise(() =>
          siteJson(
            query.site,
            Reports.use.opportunitiesReport(query.kind ?? undefined),
          ),
        ),
      )
      .handle("registry", ({ query }) =>
        Effect.promise(() => siteJson(query.site, Reports.use.registryList())),
      )
      .handle("log", ({ query }) =>
        Effect.promise(() =>
          siteJson(query.site, Reports.use.logList(query.path ?? undefined)),
        ),
      )
      .handle("history", ({ query }) =>
        Effect.promise(async () => {
          let limit: number | undefined
          try {
            limit = numberParam(query.limit, "limit")
          } catch (cause) {
            return errorEnvelope(messageOf(cause), ctx.debug, 400)
          }
          return siteJson(query.site, Reports.use.historyReport(limit ?? 28))
        }),
      )
      .handle("jobs", () =>
        Effect.promise(async () => {
          const site = await ctx.firstSite()
          const rt = ctx.runtimeFor(site)
          const jobs = await rt.runPromise(Jobs.use.list())
          return jsonEnvelope({ jobs }, ctx.debug)
        }),
      )
      // --- writes ---
      .handle("registryAdd", ({ query, payload }) =>
        Effect.promise(() =>
          siteJson(query.site, Reports.use.registryAdd(payload)),
        ),
      )
      .handle("registrySet", ({ query, payload }) =>
        Effect.promise(() => {
          if (!payload.target) {
            return Promise.resolve(
              errorEnvelope("registry set requires target", ctx.debug, 400),
            )
          }
          return siteJson(
            query.site,
            Reports.use.registrySet(
              payload.target,
              payload.keyword,
              (payload.patch ?? {}) as RegistryPatch,
            ),
          )
        }),
      )
      .handle("logAdd", ({ query, payload }) =>
        Effect.promise(() => siteJson(query.site, Reports.use.logAdd(payload))),
      )
      .handle("syncJob", ({ query }) =>
        Effect.promise(() => startJob(query.site, "sync", (rt) => runSync(rt))),
      )
      .handle("backfillJob", ({ query, payload }) =>
        Effect.promise(() =>
          startJob(query.site, "backfill", (rt) =>
            rt.runPromise(BackfillEffect(payload.months ?? 16)),
          ),
        ),
      )
      // --- text feeds ---
      .handle("sitesTxt", () =>
        Effect.promise(async () => {
          const sites = await ctx.loadSites()
          return plainText(
            sites.map((site) => `${site.id}\t${site.name}`).join("\n"),
          )
        }),
      )
      .handle("pagesTxt", ({ query }) =>
        Effect.promise(async () => {
          let windowDays: number | undefined
          try {
            windowDays = numberParam(query.window, "window")
          } catch (cause) {
            return errorEnvelope(messageOf(cause), ctx.debug, 400)
          }
          return siteText(query.site, pagesLines(windowDays ?? 28))
        }),
      )
      .handle("tuiHome", ({ query }) => Effect.promise(() => tuiFeed(query.site, "home")))
      .handle("tuiOpportunities", ({ query }) => Effect.promise(() => tuiFeed(query.site, "opportunities")))
      .handle("tuiHistory", ({ query }) => Effect.promise(() => tuiFeed(query.site, "history")))
      .handle("tuiRegistry", ({ query }) => Effect.promise(() => tuiFeed(query.site, "registry")))
      .handle("tuiLog", ({ query }) => Effect.promise(() => tuiFeed(query.site, "log"))),
  )
}

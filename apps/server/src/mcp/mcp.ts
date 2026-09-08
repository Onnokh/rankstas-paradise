// MCP surface adapter over the domain runtime — the agent-native equivalent of
// the HTTP API. Every tool is a thin wrapper: decode its args, resolve the
// active site from the required `site` arg, run the matching `Reports` effect,
// and return the report DTO as pretty-JSON text. No business logic lives here;
// the domain `Reports` service stays the single source (ported from the legacy
// src/mcp.ts).
//
// This module is wired to a *runtime seam*, not the root runtime: `buildMcpServer`
// (and `mcpHandler`) take a `run` function that executes an effect against a
// `ManagedRuntime`. Tests inject a test runtime over a mock `Reports`; PLO-276
// injects the real application runtime. Reads SKIP warm-on-read (that is Jobs'
// concern, PLO-273) — they just run the read.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Schema } from "effect"
import { z } from "zod"

import { Config } from "@rp/domain/config/config"
import { KeywordDiscovery } from "@rp/domain/keyword-discovery/keyword-discovery"
import type {
  KeywordDiscoveryError,
} from "@rp/domain/keyword-discovery/schema"
import type { UnservedMarketError } from "@rp/domain/keyword-metrics/schema"
import { RegistryPatch } from "@rp/domain/registry/schema"
import { Reports } from "@rp/domain/reports/reports"
import type { ReportsError } from "@rp/domain/reports/schema"
import {
  LogAddInput,
  QueriesOptions,
  RegistryAddInput,
} from "@rp/domain/reports/schema"
import { CurrentSite } from "@rp/domain/sites/current-site"
import { SiteId } from "@rp/domain/sites/schema"
import type { UnknownSiteError } from "@rp/domain/sites/schema"
import { Sites } from "@rp/domain/sites/sites"

// The runtime seam. `buildMcpServer`/`mcpHandler` never build the root runtime;
// they run every tool effect through this. A tool effect requires the domain
// services the application runtime provides (`Reports` plus `Sites`/`Config`,
// which `CurrentSite.layerFor` needs to resolve the site) and has already had
// its domain errors caught, so its error channel is `never`.
//
// `run` also receives the tool's target `site`. Site-scoped services resolve
// `CurrentSite.current()` at layer construction, so they must be built PER SITE;
// the seam surfaces the site (it is site-agnostic otherwise) so PLO-276 can route
// each call to the matching per-site runtime rather than a single global one.
// PLO-276 wires this as `(site, effect) => perSiteRuntime(site).runPromise(effect)`;
// tests pass `(_site, effect) => testRuntime.runPromise(effect)` over a mock `Reports`.
export type McpRuntimeContext =
  | Reports.Service
  | KeywordDiscovery.Service
  | Sites.Service
  | Config.Service
export type RunTool = <A>(
  site: SiteId,
  effect: Effect.Effect<A, never, McpRuntimeContext>,
) => Promise<A>

// The DTO rendered as compact JSON text — the same document the HTTP API
// returns. Compact, not pretty: these documents land in an agent's context
// window, where indentation only doubles the size.
const asReport = (payload: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
})

// A domain tagged error rendered as a structured MCP error result (not a crash).
const errorResult = (
  cause:
    | ReportsError
    | UnknownSiteError
    | KeywordDiscoveryError
    | UnservedMarketError,
): CallToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(
        {
          error: cause._tag,
          // An UnservedMarketError carries no `message` — it carries the pair
          // DataForSEO will not answer for, and the reason. Naming the pair is
          // the whole use of it: the fix is a different Market, not a retry.
          message:
            cause._tag === "UnservedMarketError"
              ? `${cause.reason} (location ${cause.locationCode}, language ${cause.languageCode})`
              : cause.message,
        },
        null,
        2,
      ),
    },
  ],
  isError: true,
})

// Decode the required `site` arg into a branded SiteId at the boundary.
const toSiteId = (site: string): SiteId => Schema.decodeUnknownSync(SiteId)(site)

// Run a `Reports` effect scoped to a site: shape the DTO as a report, bind the
// active site for the scope via `CurrentSite.layerFor`, and map the domain
// tagged errors (`ReportsError`, `UnknownSiteError`) to a structured MCP error
// result. The result requires only the runtime seam's context and cannot fail.
const scoped = <A>(
  effect: Effect.Effect<A, ReportsError, Reports.Service>,
  siteId: SiteId,
): Effect.Effect<CallToolResult, never, McpRuntimeContext> =>
  effect.pipe(
    Effect.map(asReport),
    Effect.provide(CurrentSite.layerFor(siteId)),
    Effect.catchTags({
      ReportsError: (cause) => Effect.succeed(errorResult(cause)),
      UnknownSiteError: (cause) => Effect.succeed(errorResult(cause)),
    }),
  )

// The discovery twin of `scoped`. Its own helper because the errors are
// different ones and because the service is not Reports: a discovery run writes
// and spends, so it cannot sit behind a report read.
const scopedDiscovery = <A>(
  effect: Effect.Effect<
    A,
    KeywordDiscoveryError | UnservedMarketError,
    KeywordDiscovery.Service
  >,
  siteId: SiteId,
): Effect.Effect<CallToolResult, never, McpRuntimeContext> =>
  effect.pipe(
    Effect.map(asReport),
    Effect.provide(CurrentSite.layerFor(siteId)),
    Effect.catchTags({
      KeywordDiscoveryError: (cause) => Effect.succeed(errorResult(cause)),
      UnservedMarketError: (cause) => Effect.succeed(errorResult(cause)),
      UnknownSiteError: (cause) => Effect.succeed(errorResult(cause)),
    }),
  )

const site = z
  .string()
  .describe("Site id to scope the query to (from the configured catalog).")

// Build a fresh, stateless MCP server exposing the report tools over `run`. Name
// and version match the legacy server for a behaviour-preserving port.
export const buildMcpServer = (run: RunTool): McpServer => {
  const server = new McpServer({ name: "rankstas-paradise", version: "1.0.0" })

  // --- reads ---

  server.registerTool(
    "status",
    {
      // The tool has no output schema of its own — it returns the shared
      // StatusReport DTO, the same document GET /api/status serves. The two
      // freshness instants are named here because an agent reads only this
      // description before deciding whether the data it is about to reason over
      // is current, and reading either one alone leads it to the wrong verdict.
      description:
        "Data range, row counts, and registry/sitemap coverage for the site. " +
        "data.lastSyncedAt is when the site's data last CHANGED; " +
        "data.lastCheckedAt is when Ranksta last ASKED Google. A lastCheckedAt " +
        "newer than lastSyncedAt means the sync ran and Google had nothing new. " +
        "analytics names the site's web-analytics provider and how many days of " +
        "visits are stored (null when the site has none); ready=false with a " +
        "reason means visits cannot be fetched.",
      inputSchema: { site },
    },
    async ({ site }) => {
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.statusReport(), id))
    },
  )

  server.registerTool(
    "pages",
    {
      description:
        "Per-page metrics for the current and previous window, with verdicts and signals. " +
        "visits (pageviews and visits from the site's analytics provider, same windows) " +
        "is present when the site has one; beside trueTotals.clicks it says how much of " +
        "a page's traffic is organic search.",
      inputSchema: {
        site,
        window: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Window length in days (default 28)."),
      },
    },
    async ({ site, window }) => {
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.pagesReport(window ?? 28), id))
    },
  )

  server.registerTool(
    "page",
    {
      description:
        "Full report for one page: daily series, top queries, plan, baseline, action log, " +
        "and visits from the site's analytics provider when it has one.",
      inputSchema: {
        site,
        path: z.string().describe('Page path starting with "/", e.g. "/pricing".'),
      },
    },
    async ({ site, path }) => {
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.pageReport(path), id))
    },
  )

  server.registerTool(
    "queries",
    {
      description:
        "Top search queries, optionally scoped to a page, with brand and mapping flags. " +
        "Each row carries `demand` when DataForSEO has an answer for it: search volume, " +
        "difficulty (0-100), cost per click, competition and intent, in the `market` the " +
        "response names. An absent `demand` means no answer is stored, not that the query " +
        "has no demand; a null `searchVolume` means the term is too rare for the vendor to " +
        "report. Brand and operator queries never carry one — they are never asked about.",
      inputSchema: {
        site,
        page: z.string().optional().describe("Page path to scope queries to."),
        window: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Window length in days (default 28)."),
        minImpressions: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Drop queries below this impression count."),
        includeBrand: z
          .boolean()
          .optional()
          .describe("Include brand queries (default false)."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of query rows (default 50)."),
      },
    },
    async ({ site, page, window, minImpressions, includeBrand, limit }) => {
      const options = Schema.decodeUnknownSync(QueriesOptions)({
        page,
        windowDays: window,
        minImpressions,
        includeBrand,
        limit,
      })
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.queriesReport(options), id))
    },
  )

  server.registerTool(
    "opportunities",
    {
      description:
        "The opportunity digest signals (striking-distance, ctr, new-demand, cannibalization), " +
        "strongest first. Returns the top `limit` signals; `totalSignals` reports how many " +
        "matched. `score` ranks striking-distance, new-demand and cannibalization by search " +
        "volume when it is known, because impressions at position 18 are structurally tiny " +
        "and would bury the biggest prizes; ctr stays impression-weighted, since it measures " +
        "clicks lost on appearances the site already has. Each signal carries `demand` when " +
        "an answer is stored. `difficulty` is reported and never scored — weigh it against " +
        "the site's Domain Rating from `status` before acting on a high-volume signal.",
      inputSchema: {
        site,
        kind: z.string().optional().describe("Filter to one signal kind."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of signals (default 50)."),
      },
    },
    async ({ site, kind, limit }) => {
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.opportunitiesReport(kind, limit ?? 50), id))
    },
  )

  server.registerTool(
    "registry",
    {
      description:
        "The keyword registry: every target URL with its phase, plan, and progress, " +
        "plus visits from the analytics provider over the same 28 days (null " +
        "without a provider). Each planned keyword carries `demand` when DataForSEO has " +
        "an answer for it — search volume, difficulty, cost per click, competition and " +
        "intent, in the `market` the response names. This is what makes the plan " +
        "checkable: a keyword with no demand behind it is a page nobody will find, " +
        "whatever its priority says.",
      inputSchema: { site },
    },
    async ({ site }) => {
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.registryList(), id))
    },
  )

  server.registerTool(
    "registry_health",
    {
      description:
        "The keyword registry judged on demand: which planned keywords have searches " +
        "behind them and which do not. Every keyword carries a `verdict` — " +
        '"has-demand", "no-demand" (the vendor measured zero), "unreported" (the vendor ' +
        'has no volume because the term is too rare to report), or "unmeasured" (nobody ' +
        "has asked yet, so it says nothing about the keyword). Keywords with demand come " +
        "first, strongest first; `totals.monthlyVolume` sums their searches, which is the " +
        "size of the addressable market and NOT a traffic forecast. `difficultyGap` is " +
        "the keyword's difficulty minus the site's Domain Rating, positive meaning the " +
        "keyword scores harder than the site rates — a rough guide from two different " +
        "vendors' scales, deliberately reported as a number and never as a verdict. Use " +
        "this to check an existing plan; use `opportunities` to find what is missing " +
        "from it.",
      inputSchema: { site },
    },
    async ({ site }) => {
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.registryHealth(), id))
    },
  )

  server.registerTool(
    "log",
    {
      description: "The action log, site-wide or for one path, newest first.",
      inputSchema: {
        site,
        path: z.string().optional().describe("Restrict to a single page path."),
      },
    },
    async ({ site, path }) => {
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.logList(path), id))
    },
  )

  server.registerTool(
    "history",
    {
      description:
        "Daily true site totals (clicks, impressions, ctr, position) for the last N days. " +
        "Each day also carries visits (pageviews, visits, visitors) from the site's " +
        "analytics provider, or null when it has none.",
      inputSchema: {
        site,
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Number of days (default 28)."),
      },
    },
    async ({ site, limit }) => {
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.historyReport(limit ?? 28), id))
    },
  )

  server.registerTool(
    "events",
    {
      description:
        "The site's custom events (purchase, download_shader, …) from its analytics " +
        "provider over the last N days against the N days before, strongest first, " +
        "each with current, previous and delta. Empty when the site has no provider " +
        "or nothing is synced yet.",
      inputSchema: {
        site,
        window: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Window length in days (default 28)."),
      },
    },
    async ({ site, window }) => {
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.eventsReport(window ?? 28), id))
    },
  )

  server.registerTool(
    "revenue",
    {
      description:
        "The site's sales from its commerce provider (Polar, …) over the last N " +
        "whole days against the N days before, from the ledger: one row per day " +
        "(orders, revenue, net after refunds; amounts in the currency's minor " +
        "unit, so cents), plus current, previous and delta totals. revenue (the " +
        "status) is null when the site has no commerce provider; ready false with " +
        "a reason means one is configured but cannot be read.",
      inputSchema: {
        site,
        window: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Window length in days (default 28)."),
      },
    },
    async ({ site, window }) => {
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.revenueReport(window ?? 28), id))
    },
  )

  server.registerTool(
    "today",
    {
      description:
        "Today so far in the site's time zone, from the ledger: totals (pageviews, " +
        "visits, visitors), 24 hourly rows, pages and events, re-fetched from the " +
        "analytics provider every few minutes (syncedAt says when). today is null " +
        "when the site has no provider; analytics.ready false with a reason means " +
        "the provider cannot be read, and the day stays at its last synced state.",
      inputSchema: { site },
    },
    async ({ site }) => {
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.todayReport(), id))
    },
  )

  server.registerTool(
    "live",
    {
      description:
        "Visitors active on the site in the last 30 minutes, from its analytics " +
        "provider, with live.online (the last 5 minutes: the people on the site " +
        "right now) and live.series: one count per minute, oldest first. The one " +
        "read that asks the provider (answers are memoised for 30 seconds). live is " +
        "null when the site has no provider; analytics.ready false with a reason " +
        "means the provider is configured but cannot be read.",
      inputSchema: { site },
    },
    async ({ site }) => {
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.liveReport(), id))
    },
  )

  server.registerTool(
    "live-events",
    {
      description:
        "What visitors did on the site in the last 30 minutes, newest first, from " +
        "its analytics provider: one row per pageview or event with the page, the " +
        "event name and properties, and the visitor's country, browser, OS and " +
        "device. events is null when the site has no provider; analytics.ready " +
        "false with a reason means the provider is configured but cannot be read. " +
        "Answers are memoised for 5 seconds.",
      inputSchema: { site },
    },
    async ({ site }) => {
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.liveEventsReport(), id))
    },
  )

  // --- keyword discovery (spends money; see the tool descriptions) ---

  server.registerTool(
    "keywords_discover",
    {
      // The description carries the price and the filters because an agent
      // reads only this before deciding how to call it, and both are things it
      // would otherwise get wrong: it would run a seed it has already run, and
      // it would ask for the maximum limit because more looks better.
      description:
        "Expand one seed keyword at DataForSEO and store what survives filtering as " +
        "proposals for review. COSTS MONEY: the Labs expansions bill about $0.0001 " +
        "per row returned plus $0.01 for the task, so `limit` is the price of the " +
        "call — leave it at the default of 200 unless a narrower run came back " +
        "almost empty. Filters out, and counts separately: keywords already in the " +
        "registry or already proposed or dismissed, brand and site: queries, " +
        "anything under `minVolume`, and optionally anything over `maxDifficulty` " +
        "or outside `intents`. Read the drop counts before re-running: an empty " +
        "result with a high droppedKnown means the seed is exhausted, not that the " +
        "subject has no demand. Proposals are NOT registry rows — they wait for a " +
        "person, or for a `registry_add` call once one is agreed.",
      inputSchema: {
        site,
        seed: z.string().describe("The keyword to expand."),
        source: z
          .enum(["suggestions", "related"])
          .optional()
          .describe(
            "suggestions (default) returns long-tail phrases containing the seed. " +
              "related returns terms Google relates to it, which need not contain it " +
              "— the only one that finds a subject the site does not cover. Ignored " +
              "in markets DataForSEO serves through Google Ads, which has one " +
              "expansion and reports no difficulty or intent.",
          ),
        limit: z
          .number()
          .optional()
          .describe("Rows to ask for, 1-1000. Default 200. This is the price."),
        minVolume: z
          .number()
          .optional()
          .describe(
            "Monthly searches a keyword must report to be proposed. Default 10; a " +
              "keyword the vendor reports nothing for is not evidence of demand.",
          ),
        maxDifficulty: z
          .number()
          .optional()
          .describe(
            "Drop keywords harder than this (0-100). Absent by default: compare it " +
              "to the site's domain rating from `dashboard` rather than guessing, " +
              "and prefer leaving it off so the reader can judge the numbers.",
          ),
        intents: z
          .array(z.string())
          .optional()
          .describe(
            'Keep only these search intents, e.g. ["informational"]. Rows with no ' +
              "reported intent are kept either way.",
          ),
      },
    },
    async ({ site, ...rest }) => {
      const id = toSiteId(site)
      return run(id, scopedDiscovery(KeywordDiscovery.use.discover(rest), id))
    },
  )

  server.registerTool(
    "keywords_proposed",
    {
      description:
        "The stored keyword proposals still waiting on a decision, strongest demand " +
        "first. Free — reads nothing but this site's own store. Excludes dismissed " +
        "proposals and any keyword the registry has since taken. Each row carries " +
        "the vendor's numbers as they read when it was proposed, which is why a row " +
        "may disagree with `registry_health`: that reports the current metric.",
      inputSchema: { site },
    },
    async ({ site }) => {
      const id = toSiteId(site)
      return run(id, scopedDiscovery(KeywordDiscovery.use.proposed(), id))
    },
  )

  server.registerTool(
    "keywords_dismiss",
    {
      description:
        "Set proposals aside by keyword; returns how many changed. Free. A dismissed " +
        "keyword stays dismissed: a later `keywords_discover` run that finds it again " +
        "will not propose it, which is what makes repeated runs on one seed useful.",
      inputSchema: {
        site,
        keywords: z.array(z.string()).describe("The keywords to dismiss."),
      },
    },
    async ({ site, keywords }) => {
      const id = toSiteId(site)
      return run(
        id,
        scopedDiscovery(
          KeywordDiscovery.use.dismiss(keywords).pipe(
            Effect.map((dismissed) => ({ dismissed })),
          ),
          id,
        ),
      )
    },
  )

  // --- writes (no warm-on-read; recording an action shouldn't fetch) ---

  server.registerTool(
    "registry_add",
    {
      description:
        "Append a validated registry row (keyword mapping or inventory page).",
      inputSchema: {
        site,
        target: z.string().describe('Target page path starting with "/".'),
        keyword: z
          .string()
          .optional()
          .describe("Keyword to map; omit for an inventory-only row."),
        cluster: z.string().optional(),
        intent: z.string().optional(),
        priority: z.string().optional(),
        why: z.string().optional().describe("Why this is an opportunity."),
        publishedAt: z.string().optional().describe("YYYY-MM-DD."),
        baselineDate: z.string().optional().describe("YYYY-MM-DD."),
        status: z.string().optional(),
      },
    },
    async ({ site, ...rest }) => {
      const input = Schema.decodeUnknownSync(RegistryAddInput)(rest)
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.registryAdd(input), id))
    },
  )

  server.registerTool(
    "registry_set",
    {
      description:
        "Patch existing registry rows for a target (optionally a single keyword).",
      inputSchema: {
        site,
        target: z.string().describe("Target page path to update."),
        keyword: z
          .string()
          .optional()
          .describe("Restrict the update to this keyword's row."),
        patch: z
          .object({
            cluster: z.string().optional(),
            intent: z.string().optional(),
            priority: z.string().optional(),
            publishedAt: z.string().optional(),
            baselineDate: z.string().optional(),
            status: z.string().optional(),
            whyOpportunity: z.string().optional(),
            newTargetUrl: z.string().optional(),
          })
          .describe("Fields to change; at least one is required."),
      },
    },
    async ({ site, target, keyword, patch }) => {
      const decoded = Schema.decodeUnknownSync(RegistryPatch)(patch)
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.registrySet(target, keyword, decoded), id))
    },
  )

  server.registerTool(
    "log_add",
    {
      description: "Record an action or note against a page in the action log.",
      inputSchema: {
        site,
        path: z.string().describe('Page path starting with "/".'),
        kind: z
          .string()
          .describe(
            "One of: publish, content-update, title-change, internal-links, consolidation, note.",
          ),
        date: z.string().optional().describe("YYYY-MM-DD (defaults to today)."),
        note: z.string().optional(),
      },
    },
    async ({ site, ...rest }) => {
      const input = Schema.decodeUnknownSync(LogAddInput)(rest)
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.logAdd(input), id))
    },
  )

  return server
}

// A Web Standard fetch handler for the MCP surface: a fresh stateless
// server+transport per request keeps JSON-RPC state isolated, and the Web
// Standard transport speaks the Request/Response model directly. PLO-276 mounts
// this at `/mcp` behind the shared bearer gate.
export const mcpHandler =
  (run: RunTool) =>
  async (request: Request): Promise<Response> => {
    const server = buildMcpServer(run)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    return transport.handleRequest(request)
  }

export * as Mcp from "./mcp"

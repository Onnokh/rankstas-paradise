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
export type McpRuntimeContext = Reports.Service | Sites.Service | Config.Service
export type RunTool = <A>(
  site: SiteId,
  effect: Effect.Effect<A, never, McpRuntimeContext>,
) => Promise<A>

// The DTO rendered as pretty-JSON text, so an agent reads the same document the
// HTTP API returns.
const asReport = (payload: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
})

// A domain tagged error rendered as a structured MCP error result (not a crash).
const errorResult = (
  cause: ReportsError | UnknownSiteError,
): CallToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ error: cause._tag, message: cause.message }, null, 2),
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
      description:
        "Data range, row counts, and registry/sitemap coverage for the site.",
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
        "Per-page metrics for the current and previous window, with verdicts and signals.",
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
        "Full report for one page: daily series, top queries, plan, baseline, and action log.",
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
        "Top search queries, optionally scoped to a page, with brand and mapping flags.",
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
        "The opportunity digest signals (striking-distance, ctr, new-demand, cannibalization).",
      inputSchema: {
        site,
        kind: z.string().optional().describe("Filter to one signal kind."),
      },
    },
    async ({ site, kind }) => {
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.opportunitiesReport(kind), id))
    },
  )

  server.registerTool(
    "registry",
    {
      description:
        "The keyword registry: every target URL with its phase, plan, and progress.",
      inputSchema: { site },
    },
    async ({ site }) => {
      const id = toSiteId(site)
      return run(id, scoped(Reports.use.registryList(), id))
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
        "Daily true site totals (clicks, impressions, ctr, position) for the last N days.",
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
        country: z.string().optional(),
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
            country: z.string().optional(),
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

// MCP surface over the service layer — the agent-native equivalent of the
// HTTP API in server.ts. Every tool is a thin wrapper: it resolves the site
// (like server.ts does), runs the matching service.ts function inside
// `withSite`, and returns the service report JSON verbatim as text content.
// No business logic lives here; the service layer stays the single source.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import { siteFor, withSite } from "./site.ts"
import type { RegistryPatch } from "./registry.ts"
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

// Every tool scopes to a site exactly as the HTTP routes do: resolve the full
// Site from config (origin, brand terms), then run the work inside its
// AsyncLocalStorage context. The site is always explicit — there is no server
// default (the agent names the site it is working on).
const onSite = async <T>(siteId: string, work: () => T | Promise<T>): Promise<T> => {
  const site = await siteFor(siteId)
  return withSite(site, work)
}

// The MCP tool result: the service DTO rendered as pretty JSON text, so an
// agent reads the same document the HTTP API returns.
const asReport = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
})

const site = z.string().describe("Site id to scope the query to (from the configured catalog).")

export const buildMcpServer = (): McpServer => {
  const server = new McpServer({ name: "rankstas-paradise", version: "1.0.0" })

  server.registerTool("status", {
    description: "Data range, row counts, and registry/sitemap coverage for the site.",
    inputSchema: { site },
  }, async ({ site }) => asReport(await onSite(site, () => statusReport())))

  server.registerTool("pages", {
    description: "Per-page metrics for the current and previous window, with verdicts and signals.",
    inputSchema: {
      site,
      window: z.number().int().positive().optional().describe("Window length in days (default 28)."),
    },
  }, async ({ site, window }) => asReport(await onSite(site, () => pagesReport(window ?? 28))))

  server.registerTool("page", {
    description: "Full report for one page: daily series, top queries, plan, baseline, and action log.",
    inputSchema: {
      site,
      path: z.string().describe("Page path starting with \"/\", e.g. \"/pricing\"."),
    },
  }, async ({ site, path }) => asReport(await onSite(site, () => pageReport(path))))

  server.registerTool("queries", {
    description: "Top search queries, optionally scoped to a page, with brand and mapping flags.",
    inputSchema: {
      site,
      page: z.string().optional().describe("Page path to scope queries to."),
      window: z.number().int().positive().optional().describe("Window length in days (default 28)."),
      minImpressions: z.number().int().nonnegative().optional().describe("Drop queries below this impression count."),
      includeBrand: z.boolean().optional().describe("Include brand queries (default false)."),
      limit: z.number().int().positive().optional().describe("Maximum number of query rows (default 50)."),
    },
  }, async ({ site, page, window, minImpressions, includeBrand, limit }) =>
    asReport(await onSite(site, () => queriesReport({ page, windowDays: window, minImpressions, includeBrand, limit }))))

  server.registerTool("opportunities", {
    description: "The opportunity digest signals (striking-distance, ctr, new-demand, cannibalization).",
    inputSchema: {
      site,
      kind: z.string().optional().describe("Filter to one signal kind."),
    },
  }, async ({ site, kind }) => asReport(await onSite(site, () => opportunitiesReport(kind))))

  server.registerTool("registry", {
    description: "The keyword registry: every target URL with its phase, plan, and progress.",
    inputSchema: { site },
  }, async ({ site }) => asReport(await onSite(site, () => registryList())))

  server.registerTool("log", {
    description: "The action log, site-wide or for one path, newest first.",
    inputSchema: {
      site,
      path: z.string().optional().describe("Restrict to a single page path."),
    },
  }, async ({ site, path }) => asReport(await onSite(site, () => logList(path))))

  server.registerTool("history", {
    description: "Daily true site totals (clicks, impressions, ctr, position) for the last N days.",
    inputSchema: {
      site,
      limit: z.number().int().positive().optional().describe("Number of days (default 28)."),
    },
  }, async ({ site, limit }) => asReport(await onSite(site, () => historyReport(limit ?? 28))))

  server.registerTool("registry_add", {
    description: "Append a validated registry row (keyword mapping or inventory page).",
    inputSchema: {
      site,
      target: z.string().describe("Target page path starting with \"/\"."),
      keyword: z.string().optional().describe("Keyword to map; omit for an inventory-only row."),
      cluster: z.string().optional(),
      intent: z.string().optional(),
      priority: z.string().optional(),
      country: z.string().optional(),
      why: z.string().optional().describe("Why this is an opportunity."),
      publishedAt: z.string().optional().describe("YYYY-MM-DD."),
      baselineDate: z.string().optional().describe("YYYY-MM-DD."),
      status: z.string().optional(),
    },
  }, async ({ site, ...input }) => asReport(await onSite(site, () => registryAdd(input))))

  server.registerTool("registry_set", {
    description: "Patch existing registry rows for a target (optionally a single keyword).",
    inputSchema: {
      site,
      target: z.string().describe("Target page path to update."),
      keyword: z.string().optional().describe("Restrict the update to this keyword's row."),
      patch: z.object({
        cluster: z.string().optional(),
        intent: z.string().optional(),
        country: z.string().optional(),
        priority: z.string().optional(),
        publishedAt: z.string().optional(),
        baselineDate: z.string().optional(),
        status: z.string().optional(),
        whyOpportunity: z.string().optional(),
        newTargetUrl: z.string().optional(),
      }).describe("Fields to change; at least one is required."),
    },
  }, async ({ site, target, keyword, patch }) =>
    asReport(await onSite(site, () => registrySet(target, keyword, patch as RegistryPatch))))

  server.registerTool("log_add", {
    description: "Record an action or note against a page in the action log.",
    inputSchema: {
      site,
      path: z.string().describe("Page path starting with \"/\"."),
      kind: z.string().describe("One of: publish, content-update, title-change, internal-links, consolidation, note."),
      date: z.string().optional().describe("YYYY-MM-DD (defaults to today)."),
      note: z.string().optional(),
    },
  }, async ({ site, path, kind, date, note }) => asReport(await onSite(site, () => logAdd({ path, kind, date, note }))))

  return server
}

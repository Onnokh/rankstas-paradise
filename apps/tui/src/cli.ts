// Remote-only agent CLI — every command is a thin wrapper over `@rp/api-client`
// and prints one JSON document on stdout. Ported from the legacy `src/cli.ts`,
// dropping its local (direct SQLite/CSV) execution path and the --local/--network/
// --debug mode flags: this client only ever talks to the configured server
// (RP_API_URL/RP_TOKEN or client.json). The command set is unchanged.
import { Effect } from "effect"

import { ApiClient } from "@rp/api-client/client"
import type { ApiError } from "@rp/api-client/schema"

import { runApi } from "./runtime.ts"
import type { SiteId } from "./types.ts"

type Flags = ReadonlyMap<string, string | boolean>

const parseArguments = (args: readonly string[]) => {
  const flags = new Map<string, string | boolean>()
  const positional: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (!argument.startsWith("--")) {
      positional.push(argument)
      continue
    }
    const name = argument.slice(2)
    const next = args[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next)
      index += 1
    } else {
      flags.set(name, true)
    }
  }
  return { flags: flags as Flags, positional }
}

const stringFlag = (flags: Flags, name: string): string | undefined => {
  const value = flags.get(name)
  return typeof value === "string" ? value : undefined
}

const numberFlag = (flags: Flags, name: string): number | undefined => {
  const value = stringFlag(flags, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive number, got: ${value}`)
  return parsed
}

const logKinds = ["publish", "content-update", "title-change", "internal-links", "consolidation", "note"] as const

const helpText = `Ranksta’s Paradise agent CLI — every command prints one JSON document on stdout.

Usage: bun run seo <command> [options]

Data source: the hosted server (RP_API_URL/RP_TOKEN or client.json). This client is
remote-only — reads and writes hit the server.

All commands accept --site <id>; the default is the first site in the server catalog.
List the ids via GET /api/sites.

Read commands (never call Google — served from the remote server):
  status                          Data freshness, coverage, registry and sitemap summary.
  pages [--window N]              Every page with current/previous window metrics, planning
                                  context, signals, and a verdict. Answers "what performed
                                  well" and "what needs optimization".
  page <path>                     Full bundle for one page: plan, rationale, daily series,
                                  top queries, baseline, logged actions.
  queries [--page <path>] [--min-impressions N] [--include-brand] [--limit N] [--window N]
                                  Top queries with previous-window comparison and registry mapping.
  opportunities [--kind <kind>]   Classified signals (striking-distance, ctr, new-demand,
                                  cannibalization) with recommendations.
  registry                        The SEO plan: targets, intents, keywords, rationale, phases.
  log list [--path <path>]        Logged interventions.

Write commands:
  registry add --target </path> [--keyword K --cluster C --intent I --priority P] [--country C]
               [--why TEXT] [--published-at D] [--baseline-date D] [--status S]
                                  Add a keyword mapping (or inventory-only page row without --keyword).
  registry set --target </path> [--keyword K] [--cluster C] [--intent I] [--country C] [--priority P]
               [--published-at D] [--baseline-date D] [--status S] [--why TEXT] [--new-target </path>]
                                  Update any field. Without --keyword every row of the target is
                                  patched; with --keyword only that row. --new-target remaps rows
                                  to another page (e.g. consolidating cannibalized keywords).
  log add --path </path> --kind <${logKinds.join("|")}> [--date D] [--note TEXT]
                                  Record an intervention so later readouts can compare before/after.

Google commands (queued as server jobs):
  sync                            Fetch missing finalized days and reconcile recent ones.
  backfill [--months N]           One-time history fetch (Search Console retains ~16 months).

Fields: dates are YYYY-MM-DD; CSV fields must not contain commas.`

type Result = Effect.Effect<unknown, ApiError, ApiClient.Service>

const commandPage = (flags: Flags, positional: readonly string[], site: SiteId): Result => {
  const path = positional[0] ?? stringFlag(flags, "path")
  if (!path || !path.startsWith("/")) throw new Error(`Usage: page </path> — got: ${path ?? "nothing"}`)
  return ApiClient.use.page(path, site)
}

const commandQueries = (flags: Flags, site: SiteId): Result =>
  ApiClient.use.queries(
    {
      page: stringFlag(flags, "page"),
      windowDays: numberFlag(flags, "window"),
      minImpressions: numberFlag(flags, "min-impressions"),
      includeBrand: flags.get("include-brand") === true,
      limit: numberFlag(flags, "limit"),
    },
    site,
  )

const commandRegistry = (flags: Flags, positional: readonly string[], site: SiteId): Result => {
  const action = positional[0]
  if (action === "add") {
    const target = stringFlag(flags, "target")
    if (!target) throw new Error("registry add requires --target </path>")
    return ApiClient.use.registryAdd(
      {
        target,
        keyword: stringFlag(flags, "keyword"),
        cluster: stringFlag(flags, "cluster"),
        intent: stringFlag(flags, "intent"),
        priority: stringFlag(flags, "priority"),
        country: stringFlag(flags, "country"),
        why: stringFlag(flags, "why"),
        publishedAt: stringFlag(flags, "published-at"),
        baselineDate: stringFlag(flags, "baseline-date"),
        status: stringFlag(flags, "status"),
      },
      site,
    )
  }
  if (action === "set") {
    const target = stringFlag(flags, "target")
    if (!target) throw new Error("registry set requires --target </path>")
    const patch = {
      cluster: stringFlag(flags, "cluster"),
      intent: stringFlag(flags, "intent"),
      country: stringFlag(flags, "country"),
      priority: stringFlag(flags, "priority"),
      publishedAt: stringFlag(flags, "published-at"),
      baselineDate: stringFlag(flags, "baseline-date"),
      status: stringFlag(flags, "status"),
      whyOpportunity: stringFlag(flags, "why"),
      newTargetUrl: stringFlag(flags, "new-target"),
    }
    if (Object.values(patch).every((value) => value === undefined)) {
      throw new Error("registry set requires at least one field flag: --cluster, --intent, --country, --priority, --published-at, --baseline-date, --status, --why, --new-target.")
    }
    return ApiClient.use.registrySet(target, stringFlag(flags, "keyword"), patch, site)
  }
  if (action !== undefined && action !== "list") throw new Error(`Unknown registry action: ${action}. Use list, add, or set.`)
  return ApiClient.use.registry(site)
}

const commandLog = (flags: Flags, positional: readonly string[], site: SiteId): Result => {
  const action = positional[0]
  if (action === "add") {
    const path = stringFlag(flags, "path")
    const kind = stringFlag(flags, "kind")
    if (!path || !path.startsWith("/")) throw new Error("log add requires --path </path>")
    if (!kind || !logKinds.includes(kind as never)) throw new Error(`log add requires --kind <${logKinds.join("|")}>`)
    const date = stringFlag(flags, "date")
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must use YYYY-MM-DD: ${date}`)
    return ApiClient.use.logAdd({ path, kind, date, note: stringFlag(flags, "note") }, site)
  }
  if (action !== undefined && action !== "list") throw new Error(`Unknown log action: ${action}. Use list or add.`)
  return ApiClient.use.log(stringFlag(flags, "path"), site)
}

export const runCli = async (args: readonly string[]): Promise<number> => {
  const [command, ...rest] = args
  const { flags, positional } = parseArguments(rest)
  try {
    if (command === undefined || command === "help" || flags.get("help") === true) {
      console.log(helpText)
      return command === undefined ? 1 : 0
    }
    // No hardcoded default site: --site wins, otherwise fall back to the first
    // site in the server's catalog. Erroring beats silently guessing.
    const siteId =
      (stringFlag(flags, "site") as SiteId | undefined) ??
      (await runApi(ApiClient.use.sites())).sites[0]?.id
    if (!siteId) throw new Error("No sites configured on the server. Pass --site <id>.")
    const run = (): Result => {
      switch (command) {
        case "status": return ApiClient.use.status(siteId)
        case "pages": return ApiClient.use.pages(numberFlag(flags, "window") ?? 28, siteId)
        case "page": return commandPage(flags, positional, siteId)
        case "queries": return commandQueries(flags, siteId)
        case "opportunities": return ApiClient.use.opportunities(stringFlag(flags, "kind"), siteId)
        case "registry": return commandRegistry(flags, positional, siteId)
        case "log": return commandLog(flags, positional, siteId)
        case "sync": return ApiClient.use.syncJob(siteId)
        case "backfill": return ApiClient.use.backfillJob(numberFlag(flags, "months") ?? 16, siteId)
        default: throw new Error(`Unknown command: ${command}. Run "bun run seo help" for usage.`)
      }
    }
    const payload = await runApi(run())
    console.log(JSON.stringify({ command, generatedAt: new Date().toISOString(), mode: "remote", ...(payload as object) }, null, 2))
    return 0
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    return 1
  }
}

import { createApiClient, type ApiClient } from "./apiClient.ts"
import { backfillSearchConsole, syncSearchConsole } from "./automation.ts"
import { resolveMode } from "./clientConfig.ts"
import { debugMode } from "./config.ts"
import { type RegistryPatch } from "./registry.ts"
import {
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
  type RegistryAddInput,
} from "./service.ts"
import { logKinds } from "./storage.ts"
import { loadSites, siteFor, withSite } from "./site.ts"

// Command context: in remote mode `api` is the HTTP client (bound to a site by
// id); in local mode it is null and commands call the service functions
// directly inside a withSite context.
type Context = { readonly api: ApiClient | null; readonly siteId: string }

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

const helpText = `Ranksta’s Paradise agent CLI — every command prints one JSON document on stdout.

Usage: bun run seo [--debug] [--local|--network] <command> [options]

Data source: auto — the hosted server when a client is configured (RP_API_URL/RP_TOKEN
or client.json), otherwise local SQLite/CSV. Force it with --local (direct local data)
or --network (the configured remote server). In remote mode reads and writes hit the
server; in local mode they touch this machine's data directly.

All commands accept --site <id>; the default is the first configured site. List the ids via GET /api/sites or config.json.

Read commands (never call Google — served from local data or the remote server):
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

Google commands:
  sync                            Fetch missing finalized days and reconcile recent ones.
  backfill [--months N]           One-time history fetch (Search Console retains ~16 months).

Fields: dates are YYYY-MM-DD; CSV fields must not contain commas. --debug targets the isolated
fake database and registry overrides used for development.`

const commandPage = (flags: Flags, positional: readonly string[], ctx: Context) => {
  const path = positional[0] ?? stringFlag(flags, "path")
  if (!path || !path.startsWith("/")) throw new Error(`Usage: page </path> — got: ${path ?? "nothing"}`)
  return ctx.api ? ctx.api.page(path, ctx.siteId) : pageReport(path)
}

const commandQueries = (flags: Flags, ctx: Context) => {
  const options = {
    page: stringFlag(flags, "page"),
    windowDays: numberFlag(flags, "window"),
    minImpressions: numberFlag(flags, "min-impressions"),
    includeBrand: flags.get("include-brand") === true,
    limit: numberFlag(flags, "limit"),
  }
  return ctx.api ? ctx.api.queries(options, ctx.siteId) : queriesReport(options)
}

const commandRegistry = (flags: Flags, positional: readonly string[], ctx: Context) => {
  const action = positional[0]
  if (action === "add") {
    const target = stringFlag(flags, "target")
    if (!target) throw new Error("registry add requires --target </path>")
    const input: RegistryAddInput = {
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
    }
    return ctx.api ? ctx.api.registryAdd(input, ctx.siteId) : registryAdd(input)
  }
  if (action === "set") {
    const target = stringFlag(flags, "target")
    if (!target) throw new Error("registry set requires --target </path>")
    const patch: RegistryPatch = {
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
    const keyword = stringFlag(flags, "keyword")
    return ctx.api ? ctx.api.registrySet(target, keyword, patch, ctx.siteId) : registrySet(target, keyword, patch)
  }
  if (action !== undefined && action !== "list") throw new Error(`Unknown registry action: ${action}. Use list, add, or set.`)
  return ctx.api ? ctx.api.registry(ctx.siteId) : registryList()
}

const commandLog = (flags: Flags, positional: readonly string[], ctx: Context) => {
  const action = positional[0]
  if (action === "add") {
    const path = stringFlag(flags, "path")
    const kind = stringFlag(flags, "kind")
    if (!path || !path.startsWith("/")) throw new Error("log add requires --path </path>")
    if (!kind || !logKinds.includes(kind as never)) throw new Error(`log add requires --kind <${logKinds.join("|")}>`)
    const date = stringFlag(flags, "date")
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must use YYYY-MM-DD: ${date}`)
    const input = { path, kind, date, note: stringFlag(flags, "note") }
    return ctx.api ? ctx.api.logAdd(input, ctx.siteId) : logAdd(input)
  }
  if (action !== undefined && action !== "list") throw new Error(`Unknown log action: ${action}. Use list or add.`)
  return ctx.api ? ctx.api.log(stringFlag(flags, "path"), ctx.siteId) : logList(stringFlag(flags, "path"))
}

export const runCli = async (args: readonly string[]): Promise<number> => {
  const [command, ...rest] = args
  const { flags, positional } = parseArguments(rest)
  try {
    if (command === undefined || command === "help" || flags.get("help") === true) {
      console.log(helpText)
      return command === undefined ? 1 : 0
    }
    const mode = await resolveMode()
    const api = mode === "remote" ? createApiClient() : null
    // No hardcoded default site: --site wins, otherwise fall back to the first
    // configured site (from the server's catalog when remote, config.json when
    // local). Erroring beats silently guessing which property to touch.
    const siteId = stringFlag(flags, "site")
      ?? (api ? (await api.sites()).sites[0]?.id : (await loadSites())[0]?.id)
    if (!siteId) throw new Error("No sites configured. Add a site to config.json or pass --site <id>.")
    const ctx: Context = { api, siteId }
    const run = (): unknown => {
      switch (command) {
        case "status": return ctx.api ? ctx.api.status(siteId) : statusReport()
        case "pages": { const window = numberFlag(flags, "window") ?? 28; return ctx.api ? ctx.api.pages(window, siteId) : pagesReport(window) }
        case "page": return commandPage(flags, positional, ctx)
        case "queries": return commandQueries(flags, ctx)
        case "opportunities": { const kind = stringFlag(flags, "kind"); return ctx.api ? ctx.api.opportunities(kind, siteId) : opportunitiesReport(kind) }
        case "registry": return commandRegistry(flags, positional, ctx)
        case "log": return commandLog(flags, positional, ctx)
        case "sync": return ctx.api ? ctx.api.syncJob(siteId) : syncSearchConsole().then((message) => ({ message }))
        case "backfill": { const months = numberFlag(flags, "months") ?? 16; return ctx.api ? ctx.api.backfillJob(months, siteId) : backfillSearchConsole(months).then((message) => ({ message })) }
        default: throw new Error(`Unknown command: ${command}. Run "bun run seo help" for usage.`)
      }
    }
    // Local commands read/write this machine's data, so they run inside a site
    // context; remote commands carry the site id in each request and need none.
    const payload = ctx.api ? await run() : await withSite(await siteFor(siteId), run)
    console.log(JSON.stringify({ command, generatedAt: new Date().toISOString(), mode: mode === "remote" ? "remote" : debugMode ? "debug" : "live", ...(payload as object) }, null, 2))
    return 0
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    return 1
  }
}

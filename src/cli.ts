import { backfillSearchConsole, syncSearchConsole } from "./automation.ts"
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
} from "./service.ts"
import { logKinds } from "./storage.ts"
import { siteFor, withSite } from "./site.ts"

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

Usage: bun run seo [--debug] <command> [options]

All commands accept --site <id>; the default is sleevy. Use the configured ids from GET /api/sites (currently sleevy and missingmounts).

Read commands (local data only, never call Google):
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

const commandPage = (flags: Flags, positional: readonly string[]) => {
  const path = positional[0] ?? stringFlag(flags, "path")
  if (!path || !path.startsWith("/")) throw new Error(`Usage: page </path> — got: ${path ?? "nothing"}`)
  return pageReport(path)
}

const commandQueries = (flags: Flags) =>
  queriesReport({
    page: stringFlag(flags, "page"),
    windowDays: numberFlag(flags, "window"),
    minImpressions: numberFlag(flags, "min-impressions"),
    includeBrand: flags.get("include-brand") === true,
    limit: numberFlag(flags, "limit"),
  })

const commandRegistry = (flags: Flags, positional: readonly string[]) => {
  const action = positional[0]
  if (action === "add") {
    const target = stringFlag(flags, "target")
    if (!target) throw new Error("registry add requires --target </path>")
    return registryAdd({
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
    })
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
    return registrySet(target, stringFlag(flags, "keyword"), patch)
  }
  if (action !== undefined && action !== "list") throw new Error(`Unknown registry action: ${action}. Use list, add, or set.`)
  return registryList()
}

const commandLog = (flags: Flags, positional: readonly string[]) => {
  const action = positional[0]
  if (action === "add") {
    const path = stringFlag(flags, "path")
    const kind = stringFlag(flags, "kind")
    if (!path || !path.startsWith("/")) throw new Error("log add requires --path </path>")
    if (!kind || !logKinds.includes(kind as never)) throw new Error(`log add requires --kind <${logKinds.join("|")}>`)
    const date = stringFlag(flags, "date")
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must use YYYY-MM-DD: ${date}`)
    return logAdd({ path, kind, date, note: stringFlag(flags, "note") })
  }
  if (action !== undefined && action !== "list") throw new Error(`Unknown log action: ${action}. Use list or add.`)
  return logList(stringFlag(flags, "path"))
}

export const runCli = async (args: readonly string[]): Promise<number> => {
  const [command, ...rest] = args
  const { flags, positional } = parseArguments(rest)
  try {
    if (command === undefined || command === "help" || flags.get("help") === true) {
      console.log(helpText)
      return command === undefined ? 1 : 0
    }
    const site = await siteFor(stringFlag(flags, "site") ?? "sleevy")
    const payload = await withSite(site, () => (() => {
      switch (command) {
        case "status": return statusReport()
        case "pages": return pagesReport(numberFlag(flags, "window") ?? 28)
        case "page": return commandPage(flags, positional)
        case "queries": return commandQueries(flags)
        case "opportunities": return opportunitiesReport(stringFlag(flags, "kind"))
        case "registry": return commandRegistry(flags, positional)
        case "log": return commandLog(flags, positional)
        case "sync": return syncSearchConsole().then((message) => ({ message }))
        case "backfill": return backfillSearchConsole(numberFlag(flags, "months") ?? 16).then((message) => ({ message }))
        default: throw new Error(`Unknown command: ${command}. Run "bun run seo help" for usage.`)
      }
    })())
    console.log(JSON.stringify({ command, generatedAt: new Date().toISOString(), mode: debugMode ? "debug" : "live", ...payload }, null, 2))
    return 0
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    return 1
  }
}

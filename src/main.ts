import { Effect, Exit } from "effect"

import { syncSearchConsole } from "./automation.ts"
import { createApiClient, type ApiClient, type SyncJob } from "./apiClient.ts"
import { isRemoteMode } from "./clientConfig.ts"
import { debugMode } from "./config.ts"
import { connectGoogle, hasGoogleConnection } from "./google.ts"
import { withSite, type Site } from "./site.ts"
import { showTui } from "./tui.ts"

// --debug and the mode flags are global switches, not commands/arguments; strip
// them so `bun run seo --local status` still dispatches the "status" command
// (and `bun run seo --local` with no command still opens the TUI).
const globalFlags = new Set(["--debug", "--local", "--network"])
const cliArguments = Bun.argv.slice(2).filter((argument) => !globalFlags.has(argument))
if (cliArguments.length > 0) {
  const { runCli } = await import("./cli.ts")
  process.exit(await runCli(cliArguments))
}

// Watch a queued server job through to completion so the remote TUI can
// repaint with the synced data instead of the stale snapshot it painted at
// startup. Polls the process-wide job list (~1s) until the job leaves
// "running"; caps the wait so a wedged job can't hang the refresh forever.
const waitForJob = async (api: ApiClient, id: number): Promise<SyncJob | undefined> => {
  for (let attempt = 0; attempt < 600; attempt++) {
    const { jobs } = await api.jobs()
    const job = jobs.find((candidate) => candidate.id === id)
    if (job && job.status !== "running") return job
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return undefined
}

// Remote refresh: force a server sync (ungated — a human opening the TUI or
// pressing reload always means "get fresh now"), then wait for it so the caller
// repaints synced data rather than the cached snapshot. A warm sync the TUI's
// own dashboard read may have already started makes the POST 409; coalesce onto
// that running job instead of failing.
const runServerSync = async (api: ApiClient, site: Site): Promise<string> => {
  const job = await api.syncJob(site.id).then((result) => result.job).catch(async (cause) => {
    if (!String(cause).includes("(409)")) throw cause
    const { jobs } = await api.jobs()
    return jobs.find((candidate) => candidate.status === "running")
  })
  if (!job) return `Refreshing ${site.name} on the server…`
  const finished = await waitForJob(api, job.id)
  if (!finished) return `Sync for ${site.name} is still running on the server.`
  return finished.status === "done"
    ? `Synced ${site.name} from the server.`
    : `Server sync failed for ${site.name}: ${finished.message ?? "unknown error"}`
}

const program = Effect.gen(function* () {
  // Remote mode (RP_API_URL/RP_TOKEN or client.json): the server owns Google
  // and the data, so skip the local OAuth gate and never run a local sync — the
  // TUI forces the server's sync job and polls it to completion (runServerSync).
  const remote = yield* Effect.promise(() => isRemoteMode())
  if (!remote && !debugMode && !(yield* hasGoogleConnection)) {
    yield* Effect.sync(() => console.log("No Google Search Console connection found. Opening authorization…"))
    yield* connectGoogle
  }
  // Paint the TUI immediately from cached data; the refresh runs in the
  // background against the active site and repaints the view when it lands, so
  // startup no longer blocks on Search Console (local) or the API (remote).
  const initialStatus = debugMode && !remote ? undefined : "Refreshing Search Console data in the background…"
  const api = remote ? createApiClient() : undefined
  const backgroundRefresh: ((site: Site) => Promise<string>) | undefined = remote
    ? (site) => runServerSync(api!, site)
    : debugMode
      ? undefined
      : (site) => withSite(site, () => syncSearchConsole())
  return yield* Effect.tryPromise({ try: () => showTui(initialStatus, backgroundRefresh), catch: (cause) => new Error(String(cause)) })
}).pipe(Effect.as("Closed SEO dashboard."))

const exit = await Effect.runPromiseExit(program)
if (Exit.isFailure(exit)) {
  console.error(exit.cause)
  process.exit(1)
}
console.log(exit.value)

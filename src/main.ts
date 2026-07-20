import { Effect, Exit } from "effect"

import { syncSearchConsole } from "./automation.ts"
import { createApiClient } from "./apiClient.ts"
import { isRemoteMode } from "./clientConfig.ts"
import { debugMode } from "./config.ts"
import { connectGoogle, hasGoogleConnection } from "./google.ts"
import { withSite, type Site } from "./site.ts"
import { showTui } from "./tui.ts"

// --debug and the mode flags are global switches, not commands/arguments; strip
// them so `bun run seo --local status` still dispatches the "status" command
// (and `bun run seo --local` with no command still opens the TUI).
const globalFlags = new Set(["--debug", "--local", "--network", "--remote"])
const cliArguments = Bun.argv.slice(2).filter((argument) => !globalFlags.has(argument))
if (cliArguments.length > 0) {
  const { runCli } = await import("./cli.ts")
  process.exit(await runCli(cliArguments))
}

const program = Effect.gen(function* () {
  // Remote mode (RP_API_URL/RP_TOKEN or client.json): the server owns Google
  // and the data, so skip the local OAuth gate and never run a local sync — the
  // TUI reads over HTTP and its refresh only queues the server's sync job.
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
    ? (site) => api!.syncJob(site.id).then((result) => `Queued server sync for ${site.name} (job ${result.job.id}).`)
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

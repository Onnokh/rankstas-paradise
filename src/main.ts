import { Effect, Exit } from "effect"

import { syncSearchConsole } from "./automation.ts"
import { debugMode } from "./config.ts"
import { connectGoogle, hasGoogleConnection } from "./google.ts"
import { showTui } from "./tui.ts"

const cliArguments = Bun.argv.slice(2).filter((argument) => argument !== "--debug")
if (cliArguments.length > 0) {
  const { runCli } = await import("./cli.ts")
  process.exit(await runCli(cliArguments))
}

const program = Effect.gen(function* () {
  if (!debugMode && !(yield* hasGoogleConnection)) {
    yield* Effect.sync(() => console.log("No Google Search Console connection found. Opening authorization…"))
    yield* connectGoogle
  }
  // Paint the TUI immediately from cached SQLite; the sync runs in the
  // background against the active site and refreshes the view when it lands,
  // so startup no longer blocks on Search Console round-trips.
  const initialStatus = debugMode ? undefined : "Refreshing Search Console data in the background…"
  return yield* Effect.tryPromise({ try: () => showTui(initialStatus, debugMode ? undefined : syncSearchConsole), catch: (cause) => new Error(String(cause)) })
}).pipe(Effect.as("Closed SEO dashboard."))

const exit = await Effect.runPromiseExit(program)
if (Exit.isFailure(exit)) {
  console.error(exit.cause)
  process.exit(1)
}
console.log(exit.value)

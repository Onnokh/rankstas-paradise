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

const refreshBeforeTui = async () => {
  const label = debugMode
    ? "Ranksta’s Paradise · Loading isolated development data…"
    : "Ranksta’s Paradise · Fetching missing days and reconciling recent Search Console data…"
  if (process.stdout.isTTY) process.stdout.write(label)
  try {
    return await syncSearchConsole()
  } catch (cause) {
    const message = String(cause).split("\n")[0]
    return `Startup refresh failed; showing cached data. ${message}`
  } finally {
    if (process.stdout.isTTY) process.stdout.write("\r\u001b[2K")
  }
}

const program = Effect.gen(function* () {
  if (!debugMode && !(yield* hasGoogleConnection)) {
    yield* Effect.sync(() => console.log("No Google Search Console connection found. Opening authorization…"))
    yield* connectGoogle
  }
  const startupStatus = yield* Effect.tryPromise({ try: refreshBeforeTui, catch: (cause) => new Error(String(cause)) })
  return yield* Effect.tryPromise({ try: () => showTui(startupStatus), catch: (cause) => new Error(String(cause)) })
}).pipe(Effect.as("Closed SEO dashboard."))

const exit = await Effect.runPromiseExit(program)
if (Exit.isFailure(exit)) {
  console.error(exit.cause)
  process.exit(1)
}
console.log(exit.value)

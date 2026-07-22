// TUI entry point — a remote-only client for Ranksta's Paradise. With arguments
// it dispatches the agent CLI (one JSON document per command); with none it
// opens the interactive opentui dashboard. Either way every read/write goes
// through `@rp/api-client`, so a remote target (RP_API_URL/RP_TOKEN or
// client.json) must be configured — the first API call fails loudly otherwise.
import { runCli } from "./cli.ts"
import { showTui } from "./tui.ts"
import { backgroundRefresh } from "./tuiData.ts"

const args = Bun.argv.slice(2)
if (args.length > 0) {
  process.exit(await runCli(args))
}

// Paint the TUI immediately from the cached server snapshot; the refresh runs in
// the background per site (forces the server's sync job and polls it) and
// repaints when it lands, so startup never blocks on Search Console.
try {
  await showTui("Refreshing Search Console data in the background…", backgroundRefresh)
  console.log("Closed SEO dashboard.")
} catch (cause) {
  console.error(cause)
  process.exit(1)
}

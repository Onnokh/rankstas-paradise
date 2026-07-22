# @rp/tui — remote-only client

Interactive terminal dashboard and agent CLI for Ranksta's Paradise. Built on
[`@opentui/core`](https://www.npmjs.com/package/@opentui/core), it renders one
site's dashboard and consumes the HTTP server exclusively through
`@rp/api-client` — no local SQLite, no Google, no site context. A remote target
must be configured via `RP_API_URL` + `RP_TOKEN` (or
`~/.config/rankstas-paradise/client.json`).

- `bun run src/main.ts` — open the interactive dashboard (background-syncs each
  site via the server's `POST /api/jobs/sync` and repaints when it lands).
- `bun run src/main.ts <command> [options]` — run the agent CLI; each command
  prints one JSON document. Run `help` for the command list.

Layout:

- `main.ts` — entry point: dispatch the CLI with args, else open the TUI.
- `tui.ts` — the opentui renderer (ported unchanged from the legacy client).
- `tuiData.ts` — the data seam: every read/refresh goes through `@rp/api-client`.
- `cli.ts` — thin remote wrappers over the client, one per command.
- `presentation.ts` — pure display copy/formatting helpers.
- `types.ts` — render shapes derived structurally from the wire contract.
- `runtime.ts` — the single `ManagedRuntime` bridging Effects to the imperative loop.

Dependency graph: `tui → api-client → domain`.

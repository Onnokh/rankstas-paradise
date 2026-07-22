# Ranksta’s Paradise

A keyboard-first SEO dashboard and agent API over Google Search Console. It tracks
each site's Search Console history in local SQLite, maps observed queries against a
keyword registry, classifies opportunities, and records the interventions you make so
later readouts can compare before and after.

## Architecture

It is a **Bun-workspaces monorepo** built on **Effect v4**. A single bearer-authed HTTP service owns the data and the Google connection; every UI is a client of it. See [docs/adr/0002-effect-v4-monorepo.md](docs/adr/0002-effect-v4-monorepo.md) for the design (and [0001](docs/adr/0001-rp-as-hosted-service.md) for the hosted-service decision it builds on).

```
packages/domain      — the SEO core as Effect services (server-only)
packages/api-client  — typed HTTP client + client config for the UIs
apps/server          — the HTTP + MCP service; entry apps/server/src/main.ts
apps/tui             — remote-only opentui dashboard + agent CLI (talks HTTP)
apps/desktop         — placeholder for the native client (not in the build graph)
```

Only `apps/server` depends on `packages/domain`; `apps/tui` (and the future desktop app) depend only on `packages/api-client` and never touch SQLite or Google directly. Deploy the service on Coolify — see [docs/deploy.md](docs/deploy.md).

Multiple sites are supported; each has an `id` in `config.json` and its own data under `sites/<id>/`.

## Getting started

```sh
bun install          # install the whole workspace
bun run check        # tsc --build across every package
bun test             # full workspace test suite
```

Run the server locally with `bun --cwd apps/server run serve` (= `bun run apps/server/src/main.ts`). It needs `RP_TOKEN` set (bearer, fail-closed), plus `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (or a `config.json`) for live data; add `--debug` for the isolated fake fixture. Point a UI at it with `RP_API_URL` + `RP_TOKEN`.

## First connection

1. In Google Cloud Console, create or select a personal project, enable **Google Search Console API**, and create an OAuth Client with application type **Desktop app**.
2. Copy `config.example.json` to `config.json`, then set your site(s) and paste the client ID/secret — either into the file, or into `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` env vars (env wins).
3. Mint the Google token once, locally: run the interactive `connectGoogle` bootstrap (the `SearchConsole` domain service, [packages/domain/src/search-console/search-console.ts](packages/domain/src/search-console/search-console.ts)) to complete Google’s read-only authorization in the browser. It writes `google-token.json`, which the server then refreshes headlessly (see [docs/deploy.md](docs/deploy.md)).

The tool requests only `https://www.googleapis.com/auth/webmasters.readonly`.

State lives in an XDG app home (`${XDG_CONFIG_HOME:-~/.config}/rankstas-paradise`), never next to the code: the OAuth token, per-site SQLite and registry CSV, and `config.json`.

## Keyword registry

`keyword-registry.csv` is the mapping from a keyword to its intended URL. Its `why_opportunity` column records the research rationale for each cluster. Registry groups those mappings by target page, so the main table shows one progress row per URL and the detail pane shows the rationale and mapped keywords. Opportunities compares observed queries with these mappings.

Every indexable URL in a site's sitemap also gets a registry row. Inventory-only pages use a blank `keyword`; they remain visible in Registry and collect page-level performance without counting as keyword targets. Startup caches the live sitemap, and Home flags any sitemap URL whose path is absent from `target_url`.

Registry labels inventory-only rows as `PAGE` and reports all-query page visibility, since branded traffic is often the meaningful signal for pages such as `/`. Keyword targets retain non-brand performance and launch phases (`PRE`, `LIVE`, or `NONE`).

Registry uses the Google Search Console URL Inspection API to dim targets Google reports as unindexed. The daily sync refreshes this status for every registry target; failed inspections retain the most recent cached result.

## The dashboard (TUI)

The TUI (`apps/tui`) is a **remote-only** client: it reads the server exclusively over HTTP through `@rp/api-client` — no local SQLite, no Google. Configure a target first (`RP_API_URL` + `RP_TOKEN`, or `~/.config/rankstas-paradise/client.json` via `rp init`), then open it:

```sh
bun --cwd apps/tui run src/main.ts
```

It is a keyboard-first master-detail dashboard: use `↑`/`↓` to select a row, and `Enter` to open the selected target page in your browser. Use `1` for opportunities, `2` for daily history, `3` for the registry, `4` for the activity log, `r` to reload data, and `q` to quit. The Log view lists every recorded Action and Note newest-first; each action's detail shows a before/after readout (28 days before the action date versus 28 days after, marked partial while fewer than 28 days have finalized). Home shows the latest few actions, and each registry target's detail lists its own activity.

The TUI paints immediately from the server's cached snapshot; startup and `r` force a server-side sync job and poll it to completion, then repaint with the synced data. The sync itself (server-side) keeps a ledger of finalized dates, fetches every missing day through Google’s latest finalized date, and reconciles the five newest finalized days as a complete unit, so changed or removed rows are reflected; dates returning zero rows are recorded too. If Google is temporarily unavailable, reads keep serving cached data.

Drag across text inside either pane to select it. Releasing the mouse copies that section directly to the macOS clipboard, without including the other pane's full lines.

## Agent CLI

Passing a command to the TUI (`bun --cwd apps/tui run src/main.ts <command>`) skips the interactive dashboard and prints a single JSON document from the server, so agents can query the SEO plan and its outcomes without touching the raw database. Read commands (`status`, `pages`, `page </path>`, `queries`, `opportunities`, `registry`, `log list`) are pure reads. Each page answer bundles the planning context — cluster, intent, priority, rationale, phase — with current-versus-previous window metrics, classified signals, and a verdict (`improving`, `needs-optimization`, `declining`, …) plus the reasons behind it.

Write commands let agents extend the plan and record work: `registry add`/`registry set` manage keyword mappings and launch fields in `keyword-registry.csv`, and `log add` records interventions (title changes, content updates, internal links, consolidations) in the `action_log` table. `sync` runs the normal daily refresh; `backfill` fetches the full Search Console history once (the API retains about 16 months). All commands accept `--site <id>`. Run the CLI with `help` for the full option list.

Because Google withholds anonymized long-tail queries from query-level rows, every sync also stores query-less daily totals (`site_daily` and `page_daily`); page reports expose both the true totals and the known non-brand subset.

## Agent MCP surface

When hosted, the service also exposes the read and write commands as MCP tools at `/mcp` (same bearer token), so opencode agents can pull SEO data and record actions inside their own runs. See the ADR for how this fits the automation loop.

## Automation

Sync runs entirely on the server and is **read-driven with a scheduled floor**. Any read — an app over HTTP or an agent over MCP — warms the site: if its ledger hasn't been reconciled within the reconciliation window (6h), the read kicks a background sync and still returns current data immediately, so a warm site is never more than a few hours stale. Concurrent or in-flight syncs coalesce into a no-op (the single-job lock, now a `Semaphore`; see the `Jobs` service), so bursty agent traffic can't stack jobs. Each sync fills finalized dates absent from the ledger and re-fetches the five newest finalized dates to absorb late Search Console processing. A per-site daily Coolify scheduled task (see [docs/deploy.md](docs/deploy.md)) is the cold-start floor for sites nothing reads. Opening the TUI or pressing `r` forces a sync regardless of the window. A sync can also be triggered on demand from the CLI (`sync`) or the server (`POST /api/jobs/sync`).

Home and Opportunities classify striking-distance, CTR, new-demand, and cannibalization signals on demand, server-side from SQLite and the registry CSV — comparing the current and preceding 28-day windows.

## Development dashboard

Run the server with `--debug` (or `DEBUG=true`) — `bun --cwd apps/server run serve --debug` — to load an isolated database of realistic fake Search Console rows. Debug mode never calls Google and writes only to a `.debug.sqlite` fixture; point the TUI at it like any other server.

## Deployment

To run the HTTP service as a hosted deployment on Coolify, see [docs/deploy.md](docs/deploy.md).

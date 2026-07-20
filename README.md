# Ranksta’s Paradise

A keyboard-first SEO dashboard and agent API over Google Search Console. It tracks
each site's Search Console history in local SQLite, maps observed queries against a
keyword registry, classifies opportunities, and records the interventions you make so
later readouts can compare before and after.

It runs two ways from the same code:

- **Local** — a TUI (and CLI) reading SQLite/CSV directly on your machine. This is the default; no server required.
- **Hosted** — a single Bun HTTP service (bearer-authed) that owns the data and Google connection. The TUI, CLI, and opencode agents connect to it as clients — over HTTP for the apps, over MCP for agents. See [docs/adr/0001-rp-as-hosted-service.md](docs/adr/0001-rp-as-hosted-service.md) for the design and [docs/deploy.md](docs/deploy.md) to deploy on Coolify.

Multiple sites are supported; each has an `id` in `config.json` and its own data under `sites/<id>/`.

## First connection

1. In Google Cloud Console, create or select a personal project, enable **Google Search Console API**, and create an OAuth Client with application type **Desktop app**.
2. Copy `config.example.json` to `config.json`, then set your site(s) and paste the client ID/secret — either into the file, or into `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` env vars (env wins).
3. Run `bun install`, then `bun run seo`. If no saved connection exists, the app opens Google’s read-only authorization flow and continues into the dashboard after approval.

The tool requests only `https://www.googleapis.com/auth/webmasters.readonly`.

State lives in an XDG app home (`${XDG_CONFIG_HOME:-~/.config}/rankstas-paradise`), never next to the code: the OAuth token, per-site SQLite and registry CSV, and `config.json`.

## Keyword registry

`keyword-registry.csv` is the mapping from a keyword to its intended URL. Its `why_opportunity` column records the research rationale for each cluster. Registry groups those mappings by target page, so the main table shows one progress row per URL and the detail pane shows the rationale and mapped keywords. Opportunities compares observed queries with these mappings.

Every indexable URL in a site's sitemap also gets a registry row. Inventory-only pages use a blank `keyword`; they remain visible in Registry and collect page-level performance without counting as keyword targets. Startup caches the live sitemap, and Home flags any sitemap URL whose path is absent from `target_url`.

Registry labels inventory-only rows as `PAGE` and reports all-query page visibility, since branded traffic is often the meaningful signal for pages such as `/`. Keyword targets retain non-brand performance and launch phases (`PRE`, `LIVE`, or `NONE`).

Registry uses the Google Search Console URL Inspection API to dim targets Google reports as unindexed. The daily sync refreshes this status for every registry target; failed inspections retain the most recent cached result.

## The dashboard (TUI)

Open the application with `bun run seo`. It is a keyboard-first master-detail dashboard: use `↑`/`↓` to select a row, and `Enter` to open the selected target page in your browser. Use `1` for opportunities, `2` for daily history, `3` for the registry, `4` for the activity log, `r` to reload data, and `q` to quit. The Log view lists every recorded Action and Note newest-first; each action's detail shows a before/after readout (28 days before the action date versus 28 days after, marked partial while fewer than 28 days have finalized). Home shows the latest few actions, and each registry target's detail lists its own activity.

Startup keeps a local ledger of finalized dates, fetches every missing day through Google’s latest finalized date, and reconciles the five newest finalized days before building each view from SQLite. Reconciled days are replaced as a complete unit, so changed or removed rows are reflected. Dates returning zero rows are recorded too. If Google is temporarily unavailable, the dashboard still opens with cached data and reports the refresh failure in the footer.

Drag across text inside either pane to select it. Releasing the mouse copies that section directly to the macOS clipboard, without including the other pane's full lines.

## Local vs. hosted

The TUI and CLI pick their data source automatically: the hosted server when a client is configured (`RP_API_URL` + `RP_TOKEN`, or `client.json`), otherwise this machine's local SQLite/CSV. Force it per-run with `--local` (direct local data) or `--network` (the configured remote server):

```sh
bun run seo --local          # this machine's own data
bun run seo --network status # the configured hosted server
```

In hosted mode the TUI reads over HTTP; startup and `r` force a server-side sync job and poll it to completion, then repaint with the synced data rather than calling Google locally.

## Agent CLI

Running `bun run seo <command>` skips the TUI and prints a single JSON document, so agents can query the SEO plan and its outcomes without touching the raw database. Read commands (`status`, `pages`, `page </path>`, `queries`, `opportunities`, `registry`, `log list`) never open the OAuth flow. Each page answer bundles the planning context — cluster, intent, priority, rationale, phase — with current-versus-previous window metrics, classified signals, and a verdict (`improving`, `needs-optimization`, `declining`, …) plus the reasons behind it.

Write commands let agents extend the plan and record work: `registry add`/`registry set` manage keyword mappings and launch fields in `keyword-registry.csv`, and `log add` records interventions (title changes, content updates, internal links, consolidations) in the `action_log` table. `sync` runs the normal daily refresh; `backfill` fetches the full Search Console history once (the API retains about 16 months). All commands accept `--site <id>`. Run `bun run seo help` for the full option list.

Because Google withholds anonymized long-tail queries from query-level rows, every sync also stores query-less daily totals (`site_daily` and `page_daily`); page reports expose both the true totals and the known non-brand subset.

## Agent MCP surface

When hosted, the service also exposes the read and write commands as MCP tools at `/mcp` (same bearer token), so opencode agents can pull SEO data and record actions inside their own runs. See the ADR for how this fits the automation loop.

## Automation

Locally, launching the dashboard paints immediately from the ledger, then refreshes Search Console in the background — the active site first for a fast repaint, then every other configured site — so opening the TUI keeps all sites current without a scheduled job. Each sync fills finalized dates absent from the ledger and re-fetches the five newest finalized dates to absorb late Search Console processing. A sync can also be triggered on demand from the CLI (`sync`) or the server (`POST /api/jobs/sync`).

When hosted, sync is read-driven with a scheduled floor. Any read — an app over HTTP or an agent over MCP — warms the site: if its ledger hasn't been reconciled within the reconciliation window (6h), the read kicks a background sync and still returns current data immediately, so a warm site is never more than a few hours stale. Concurrent or in-flight syncs coalesce into a no-op, so bursty agent traffic can't stack jobs. A per-site daily scheduled task (see [docs/deploy.md](docs/deploy.md)) is the cold-start floor for sites nothing reads. Opening the TUI or pressing `r` forces a sync regardless of the window.

Home and Opportunities classify striking-distance, CTR, new-demand, and cannibalization signals on demand, directly from SQLite and the registry CSV — comparing the current and preceding 28-day windows.

## Development dashboard

Use `bun run seo --debug` to load an isolated database of realistic fake Search Console rows. Debug mode never calls Google and writes only to a `.debug.sqlite` fixture.

## Deployment

To run the HTTP service as a hosted deployment on Coolify, see [docs/deploy.md](docs/deploy.md).
</content>
</invoke>

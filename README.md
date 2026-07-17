# Sleevy SEO (local only)

This directory is deliberately outside the Sleevy repository. It holds a local Google OAuth token and SQLite Search Console history; neither should be committed or deployed.

## First connection

1. In Google Cloud Console, create or select a personal project, enable **Google Search Console API**, and create an OAuth Client with application type **Desktop app**.
2. Copy `config.example.json` to `config.json`, then paste the client ID and client secret from that desktop OAuth client.
3. Run `bun install`, then `bun run seo`. If no saved connection exists, the app opens Google’s read-only authorization flow and continues into the dashboard after approval.

The tool requests only `https://www.googleapis.com/auth/webmasters.readonly`.

## Keyword registry

`keyword-registry.csv` is the local mapping from a keyword to its intended URL. Its `why_opportunity` column records the research rationale for each cluster. Registry groups those mappings by target page, so the main table shows one progress row per URL and the detail pane shows the rationale and mapped keywords. Opportunities compares observed queries with these mappings.

Every indexable URL in `https://sleevy.app/sitemap.xml` also has a registry row. Inventory-only pages use a blank `keyword`; they remain visible in Registry and collect page-level performance without counting as keyword targets. Startup caches the live sitemap, and Home flags any sitemap URL whose path is absent from `target_url`.

Registry labels inventory-only rows as `PAGE` and reports all-query page visibility, since branded traffic is often the meaningful signal for pages such as `/`. Keyword targets retain non-brand performance and launch phases (`PRE`, `LIVE`, or `NONE`).

Registry uses the Google Search Console URL Inspection API to dim targets Google reports as unindexed. The daily sync refreshes this status for every registry target; failed inspections retain the most recent cached result.

Open the application with `bun run seo`. It is a keyboard-first master-detail dashboard: use `↑`/`↓` to select a row, and `Enter` to open the selected target page in your browser. Use `1` for opportunities, `2` for daily history, `3` for the registry, `r` to reload local SQLite/CSV data, and `q` to quit.

TUI startup keeps a local ledger of finalized dates, fetches every missing day through Google’s latest finalized date, and reconciles the five newest finalized days before building each view from SQLite. Reconciled days are replaced as a complete unit, so changed or removed rows are reflected. Dates returning zero rows are recorded too. If Google is temporarily unavailable, the dashboard still opens with cached data and reports the refresh failure in the footer.

Drag across text inside either pane to select it. Releasing the mouse copies that section directly to the macOS clipboard, without including the other pane's full lines.

## Agent CLI

Running `bun run seo <command>` skips the TUI and prints a single JSON document, so local agents can query the SEO plan and its outcomes without touching Google or the raw database. Read commands (`status`, `pages`, `page </path>`, `queries`, `opportunities`, `registry`, `log list`) use only local SQLite/CSV data and never open the OAuth flow. Each page answer bundles the planning context — cluster, intent, priority, rationale, phase — with current-versus-previous window metrics, classified signals, and a verdict (`improving`, `needs-optimization`, `declining`, …) plus the reasons behind it.

Write commands let agents extend the plan and record work: `registry add`/`registry set` manage keyword mappings and launch fields in `keyword-registry.csv`, and `log add` records interventions (title changes, content updates, internal links, consolidations) in the `action_log` table so later readouts can compare before and after. `sync` runs the normal daily refresh; `backfill` fetches the full Search Console history once (the API retains about 16 months). Run `bun run seo help` for the full option list.

Because Google withholds anonymized long-tail queries from query-level rows, every sync also stores query-less daily totals (`site_daily` and `page_daily`); page reports expose both the true totals and the known non-brand subset.

## Automation

The installed daily launchd job fills finalized dates absent from the local ledger and re-fetches the five newest finalized dates to absorb late Search Console processing. Older completed dates are retained locally without repeated requests.

The weekly launchd job refreshes the current and preceding 28-day windows, classifies striking-distance, CTR, new-demand, cannibalization, and launch-readout signals, and writes the retained digest to `data/weekly-digest.json`. Home and Opportunities use the same classifier directly from SQLite and the registry CSV.

The installed launch agents run the daily sync at 09:15 and the weekly digest each Monday at 09:30. Their logs are retained under `data/`.

## Development dashboard

Use `bun run seo --debug` to load an isolated database of realistic fake Search Console rows. Debug mode never calls Google and writes only to `data/search-console.debug.sqlite`.

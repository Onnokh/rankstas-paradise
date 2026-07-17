# Agent interface design

Goal: let an agent (Claude skill, cron job, or any script) use this tool headlessly to answer:

1. Which pages performed well?
2. Which pages need optimization?
3. Where are the opportunities — which pages should we create or improve?
4. What was set out (published/changed), and when — and what happened afterwards?

The TUI stays as-is for humans. Agents get a non-interactive command surface over the same SQLite/CSV data.

## What the app already has

- `search_snapshot`: per-day `query × page × device × country` rows, finalized data, reconciled daily. Currently 2026-05-17 → 2026-07-13 (site is new; only 53 rows, 3 pages so far).
- `keyword-registry.csv`: keyword → target URL mapping with `published_at`, `baseline_date`, `priority`, `status`, `why_opportunity` — this is the existing "what was set out" record.
- `page_baseline`: pre-launch 28-day window per target URL.
- `opportunityDigest()` in `storage.ts`: already classifies striking-distance, CTR, new-demand, cannibalization, and launch-readout signals — this *is* the answer to question 3, it just has no non-TUI exit besides `weekly-digest.json`.
- `targetPerformance()` / `registryTargetProgress()`: per-page 28-day series and progress states.

## Data gaps to close

### 1. True daily totals (new tables: `site_daily`, `page_daily`)

Google anonymizes rare queries: rows grouped by `query` undercount real clicks/impressions (commonly by tens of percent). Aggregates *without* the query dimension include that anonymized traffic. Today every view sums `search_snapshot`, so "which pages performed well" is computed on undercounted numbers.

Fix: during each sync, issue two extra cheap requests per day and store:

- `site_daily (date, clicks, impressions, ctr, position)` — dimensions `[]` (date range = single day).
- `page_daily (date, page, clicks, impressions, ctr, position)` — dimensions `["page"]`.

Page-level performance answers then come from `page_daily` (true totals); `search_snapshot` remains the source for query-level analysis, brand filtering, and cannibalization. The delta between the two is itself a useful signal (anonymized long-tail share).

Caveat: brand exclusion (`query not like '%sleevy%'`) is impossible on `page_daily` because it has no query dimension. Page reports should surface both numbers: `total` (true, from `page_daily`) and `nonBrandKnown` (from `search_snapshot`).

### 2. Historical backfill (`backfill` command)

The API serves 16 months of history; the local ledger only starts 28 days before first sync. A one-time `backfill` command walks day-by-day from `max(siteLaunch, today − 16 months)` to the current tracking start, reusing `fetchSearchConsoleSnapshots` + the new daily-totals fetches. Quota is a non-issue (~490 days × ≤3 requests, limits are 1,200 QPM). Add `startRow` pagination to `fetchSearchConsoleSnapshots` while at it — the current single request silently truncates at 25,000 rows/day (irrelevant today, correct forever after).

### 3. Action log (new table: `action_log`)

`published_at` in the registry covers launches, but not the interventions the opportunity signals recommend (title rewrite, content update, internal links, consolidation). Without a record of *when* something was done, no one — human or agent — can read out whether it worked.

- `action_log (id, date, path, kind, note, created_at)`; `kind ∈ publish | content-update | title-change | internal-links | consolidation | note`.
- Written via CLI (`log add`), read via `log list` and embedded in `page <path>` output so before/after windows can be compared around each action.
- Launch-readout-style milestones (28/56/84 days after an action) generalize from `publishedAt` to any logged action.

### 4. Registry writes

Agents acting on "new-demand" signals need to add mappings. `registry add` appends a validated row to `keyword-registry.csv` (same column checks as `loadRegistry`); `registry update` sets `published_at` / `status` for a target. CSV stays the source of truth — human-diffable, already the pattern.

## Command surface

New entry point `src/cli.ts` (main.ts dispatches: no args → TUI, args → CLI). Every command prints a single JSON document on stdout; errors go to stderr with a non-zero exit code. Read commands never call Google and never open OAuth (`--sync` opts in; a missing/expired token fails with a message telling the human to run the TUI once). Every response embeds `latestDate` and the window boundaries used, so the agent knows data freshness.

| Command | Answers | Source |
| --- | --- | --- |
| `status` | data range, rows, last sync, registry/sitemap coverage, unmapped pages | `synced_day`, registry, sitemap cache |
| `pages [--window N] [--sort field]` | per-page metrics for current window **and** previous window with deltas → "performed well" (top Δclicks) and "needs optimization" (high impressions + low CTR / position 4–20) | `page_daily` + `search_snapshot` |
| `page <path>` | daily series, top queries, mapped keywords + rationale, baseline, launch readout, action history | all tables |
| `queries [--page P] [--min-impressions N] [--no-brand]` | top/rising queries | `search_snapshot` |
| `opportunities` | the full `opportunityDigest` signals as JSON → "what to make or improve" | existing classifier |
| `registry list \| add \| update` | what is set out, when, why; write new mappings | CSV |
| `log add \| list` | record and review interventions | `action_log` |
| `sync` / `backfill` | fill data | Google API |

## Non-goals / deferred

- **MCP server**: not needed — a JSON CLI is directly usable from a skill via Bash, with no extra process to manage. Revisit only if multiple concurrent agents need shared long-lived access.
- Natural-language question answering lives in the future skill, not here; this layer only guarantees the data and deterministic JSON views the skill will reason over.

# Bing Webmaster support

Add Bing Webmaster Tools clicks/impressions alongside Google Search Console, as a
clearly-labelled second engine. Bing is **decoration, never analysis**: it does not
feed `Verdict`, `Phase`, or any `Opportunity` kind.

Status: planned. Empirical findings below were measured against the live API on
2026-07-26 with a real key, not taken from documentation.

## Locked decisions

1. **Bing never feeds the analysis engine.** Verdicts, phases, opportunities,
   baselines and striking-distance stay 100% Google-derived.
2. **The axis is `engine`**, values `google` | `bing`. Not `source` (already means
   traffic source in SEO), not `provider` (reads as auth).
3. **"True totals" stays defined as Google's.** Bing's site totals get their own
   glossary entry, `Bing totals`, with its caveats stated.
4. **`siteUrl` is derived from each site's existing `origin`.** No new per-site
   config. Bing normalises `www`/protocol/trailing slash, and a foreign domain
   fails loudly with `400 NotAuthorized`.
5. **`BING_API_KEY`** fills the currently-vacant `Redacted<string>` slot that
   `config/config.ts:1-3` already documents. Absent ⇒ Bing silently off.
6. **Both sites enabled**, including sleevy, which has near-zero Bing traffic.
   Justification is the 8-day lookback: not collecting now is permanent data loss.
7. **Windows are 28d and 7d.** Not 30 — 28 is what every existing aggregation and
   `CONTEXT.md` uses, and it divides by 7 so weekday seasonality cancels.
8. **No page-level Bing traffic.** It does not exist (see below). The registry
   detail pane joins Bing on the **keyword ↔ query string**, an exact match with no
   inference.

## Measured facts about the API

| Fact | Value |
|---|---|
| Endpoint | `https://ssl.bing.com/webmaster/api.svc/json/<Method>?apikey=…` |
| Auth | one API key per **user**, valid for all verified sites |
| Site lookback | **8 days.** `GetRankAndTrafficStats` returned 8 daily rows |
| Query lookback | rolling ~5–7 day aggregate, **one flat row per query** |
| Date range params | **none exist** on any traffic endpoint |
| Freshness lag | ~2 days |
| CTR | **no field anywhere** — derive `clicks / impressions` |
| Site-level position | **does not exist** |
| Query position | `AvgImpressionPosition`, **integer** |
| `AvgClickPosition` | **always `-1`** — dead field, ignore |
| Top-N cap | not hit; 31 of 66 queries had a single impression |
| Page dimension | **entirely unavailable** (see below) |

Verified numbers at time of writing — missingmounts, 8 days: 34 clicks / 557
impressions across 66 queries. Sleevy, 8 days: 0 clicks / 1 impression. For
missingmounts that is **~12% of Google's clicks**.

### The page dimension is dead

All seven page-capable endpoints return nothing for a site with real traffic:

```
GetPageStats             200, 0 rows
GetPageQueryStats        200, 0 rows   (quoted and unquoted page param)
GetQueryPageStats        200, 0 rows
GetQueryPageDetailStats  200, 0 rows
GetUrlTrafficInfo        400 "information cannot be retreived"
GetChildrenUrlTrafficInfo 400 same
GetUrlCount              404 (not in the WSDL)
```

The WSDL has 64 operations; those are the only page-traffic ones. This is
Microsoft's known unfixed bug rather than absent data — the web UI has a Pages tab
— but it will not be fixed on our schedule. Build as if it never will; keep the
seam so `GetPageStats` can be lit up if it ever returns rows.

`GetUrlInfo` **does** work per-URL, returning crawl/index facts (not traffic):
`DiscoveryDate`, `LastCrawledDate`, `AnchorCount`, `DocumentSize`.

### Traps to encode

- Errors are `400` with `{"ErrorCode":n,"Message":"ERROR!!! …"}`. Match on
  **`ErrorCode`**, never the message — the docs omit the `ERROR!!!` prefix.
  Observed: `2` cannot-retrieve, `3` InvalidApiKey, `7` InvalidUrl, `14` NotAuthorized.
- Dates are .NET `"/Date(1784876400000-0700)/"`. Parse the ms as epoch UTC; the
  offset is informational and already applied. (`GetCrawlStats` inconsistently uses
  plain ISO strings — not used by this plan, but don't assume one parser.)
- Every response is wrapped in `"d"`; every object carries `"__type"`.
- `siteUrl` must be a **bare origin**. A path returns `200` with 0 rows.
- `GetUrlInfo` on a URL not in the index returns `200` with `IsPage: true` and
  sentinels: `DocumentSize: 0`, `DiscoveryDate: 0001-01-01`. Detect the sentinel —
  not an error, and not `IsPage`. `HttpStatus` is `0` on every URL; useless.
- **Never sum `bing_query_window` across `captured_date`** — consecutive captures
  overlap by ~6 days.
- `GetQueryStats` and `GetQueryTrafficStats` disagree for the same query (20 vs 25
  impressions observed). `GetQueryStats` is canonical: one call, all queries.

## Storage

Three new tables, all additive `create table if not exists` in
`packages/domain/src/storage/storage.ts`. Nothing existing is altered, so the
absence of a migration mechanism is not a problem.

```sql
create table if not exists bing_site_daily (
  date text primary key,
  clicks integer not null,
  impressions integer not null,
  collected_at text not null default current_timestamp
);

create table if not exists bing_query_window (
  captured_date text not null,
  query text not null,
  clicks integer not null,
  impressions integer not null,
  position integer not null,          -- AvgImpressionPosition, integer
  collected_at text not null default current_timestamp,
  primary key (captured_date, query)
);

create table if not exists bing_url_info (
  target_url text primary key,
  discovered_at text,                 -- null when not in index
  last_crawled_at text,               -- null when not in index
  anchor_count integer not null,
  document_size integer not null,
  in_index integer not null,          -- 0/1, derived from the sentinel
  inspected_at text not null default current_timestamp
);
```

No `ctr` column — Bing has no CTR field, and it is derived at read time exactly as
the existing aggregations already do.

Each sync **re-upserts the full 8-day window** into `bing_site_daily`, which
absorbs Bing's revisions for free. Provisional-ness is computed at read time (the
newest ~2 dates), matching how `site_daily` already handles it rather than storing
a flag.

## Ingestion

New service `packages/domain/src/bing-webmaster/`, mirroring the shape of
`search-console/`:

- `fetchSiteDailyTotals(siteUrl)` → `GetRankAndTrafficStats`
- `fetchQueryWindow(siteUrl)` → `GetQueryStats`
- `fetchUrlInfo(siteUrl, urls)` → `GetUrlInfo` per URL, concurrency 8, 24h TTL,
  individual failures counted not fatal — same pattern as `fetchPageIndexStatuses`
- Errors `BingAuthError` / `BingHttpError` / `BingDecodeError`, keyed on `ErrorCode`
- Reuse the existing transient retry shape (429/5xx, exponential 500ms, jittered,
  `upTo 5`)
- A `Schema` transform for the .NET date, and `.d` unwrapping, in one place

## Sync

Bing steps append to the existing job in `packages/domain/src/sync/sync.ts`, inside
the same single-job semaphore, **wrapped so a Bing failure can never fail the Google
sync**. Non-negotiable given the 200-with-empty bugs and the undocumented rate
limit. Three calls per site per day plus one `GetUrlInfo` per target URL at 24h TTL.

No backfill path — there is nothing to backfill.

The existing daily Coolify cron is sufficient: because every run re-upserts the full
8-day window, the schedule can fail for **seven consecutive days** without losing
data. Verified 2026-07-26 that production is current for both sites (`lastDate`
2026-07-23, exactly Google's today−3 cutoff). No alerting needed — but `status`
should gain a Bing gap/staleness field beside the existing `missingSnapshotDates`
and `syncedWithinHours`, because Bing is the one dataset with no repair path.

Bing's own lag is ~2 days, so Bing data will typically be one day *fresher* than
Google's finalized cutoff.

## Reports and UI

`reports/schema.ts` is a `FROZEN CONTRACT` file; additions ripple to the HTTP DTOs,
the TUI's structurally-derived types, and the native text grammar.

**Home cards — a new TUI card strip.** This is the visible headline of the feature
and it lands in the **TUI**, not the native app. (`apps/desktop` is a placeholder;
the real native client is `sleevy-native-proto`, out-of-repo. The TUI currently has
**no** KPI cards at all — `siteKpis` in `native-feed.ts:161-174` emits four `meta`
lines that only the native client renders.)

Three cards, each one metric, each carrying both windows and both engines:

```
┌ IMPRESSIONS ────────┐  ┌ CLICKS ─────────────┐  ┌ CTR ────────────────┐
│ 28d   368 G ·  70 B │  │ 28d    36 G ·   4 B │  │ 28d  9.8% G · 6.1% B│
│  7d    92 G ·  18 B │  │  7d     9 G ·   1 B │  │  7d  9.8% G · 5.6% B│
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘
```

Twelve numbers (3 metrics × 2 windows × 2 engines) in ~5 lines. **Six cards across
is not viable**: at 80 columns that is 12 columns per card, too narrow for the word
"Impressions" plus two figures. Three across gives ~25 columns each.

- A full-width box inserted between `nav` and `split` in `tui.ts:184-225`.
- **Home view only** — Registry/History/Log keep their full table height, and it
  matches `siteKpis` being used solely in `homeFeed`. Home's master list is six
  categories, so it has the room.
- **`visibleRows` must be updated.** `tui.ts:231` hardcodes
  `limit = renderer.height - 12`; the strip's height and gap have to be subtracted
  too, or the master table silently loses rows off the bottom. This is the same
  class of bug commit `d13ced8` ("Fix clipped index state in TUI") already fixed.
- **Collapse to a single line below ~30 rows** of terminal height, following the
  responsive precedent of `detailSummaryHeight(false, renderer.width)`. On a 24-row
  terminal a 5-line strip would take the table from ~12 visible rows to ~6.
- No site-level position card: Bing has none. The existing Google-only
  `Avg position` KPI stays where it is in the native feed.
- While Bing has fewer than 28 days collected, the 28d row states the count
  (`28d · 12d`). First sync yields 8 days free, so 28d completes 22 days after
  enabling.

**Queries view** — a sixth TUI view (key `5`) plus a `queriesFeed` twin in
`apps/server/src/native-feed.ts`, the `FeedView` union, and `packages/api-client`
wiring. Google is aggregated to **7d to match Bing's window** rather than labelling
a mismatch. Google's rows carry a `page` and Bing's do not, so that column is
Google-only.

**Registry detail** — the existing `KEYWORDS · N` list gains Google-7d and Bing-7d
numbers per keyword, joined on exact query string. A `Bing: crawled <date> ·
discovered <date>` line joins the existing `Google index:` line. Inventory-only
pages honestly show no Bing data.

**MCP** — `QueriesReport`, `status` and `history` gain Bing blocks. The
`rankstas-paradise` skill doc lives outside this repo and needs updating separately.

## Open

**Does the History view get a Bing series?** Not settled. The confirmed scope is
Home cards, the Queries view, and the Registry detail pane. If History is included:
its table is `DATE | IMPRESSIONS | CHANGE | CLICKS | CTR | AVG. POSITION` and its
`28-DAY IMPRESSION CHART` is a single ASCII series, so Bing needs either extra
columns or a second chart line — and because missingmounts has 494 days of Google
history against Bing's 8, the chart must render pre-collection days as *absent*,
not as zero, or it will show a fake cliff.

## Phases

1. Config + ingestion + storage, no UI. Verify against both live sites.
2. TUI Home card strip — the smallest visible win, site-level only. Includes the
   `visibleRows` height fix and the short-terminal collapse.
3. Registry detail: keyword-level Bing numbers and the crawl line.
4. Queries view: TUI (a sixth view), native feed, api-client. Largest single piece —
   roughly as much work as phases 1–3 combined.
5. `CONTEXT.md` glossary (`engine`, `Bing totals`) and docs.

`sleevy-native-proto` (out-of-repo) is untouched by this plan. If the native app
should show the cards too, that needs a `card` line kind added to the feed grammar
and a matching change in that repo — deliberately deferred.

Tests use `bun:test` with a fake Bing layer, mirroring `storage.test.ts`.

## Not building

- Page-level Bing traffic (impossible)
- Bing-derived verdicts, phases, opportunities, baselines
- Registry-attributed page-level Bing estimates (would look measured but be inferred)
- `AvgClickPosition` (always `-1`)
- Backfill (no date-range parameter exists)
- Bing country/device dimensions (not in the API)
- `GetCrawlStats` ingestion — useful, but out of scope; see the note below

## Follow-ups spotted, out of scope

- missingmounts' Bing `InIndex` is falling: 2019 → 2004 → 1988 over three days,
  with `AllOtherCodes: 3309` against `Code2xx: 21712`. Worth its own look.
- sleevy ranks **7th for its own brand name** in Bing, and has 4 clicks / 115
  impressions lifetime in Google across 5 distinct queries. A content problem.
- The API key used for research is in a chat transcript and carries write scope
  (`webmaster.manage`). **Regenerate it.**
- `brandPattern` in `storage.ts:183` uses only `brandTerms[0]` while
  `isBrandQuery` in `reports.ts:901` checks all terms. Pre-existing inconsistency.

# HTTP API

`bun run server` starts a local-only HTTP API (`127.0.0.1`, port `SEO_PORT` or 8790) over the same service layer ([src/service.ts](../src/service.ts)) the CLI and TUI use. Payloads match the CLI's JSON documents; every response carries `generatedAt` and `mode` (`live`/`debug`).

## Read endpoints (local data only, never call Google)

| Endpoint | CLI equivalent |
|---|---|
| `GET /api/status` | `status` |
| `GET /api/pages?window=N` | `pages --window N` |
| `GET /api/page?path=/x` | `page /x` |
| `GET /api/queries?page=&window=&min-impressions=&include-brand=true&limit=` | `queries …` |
| `GET /api/opportunities?kind=` | `opportunities --kind` |
| `GET /api/registry` | `registry` |
| `GET /api/log?path=` | `log list` |
| `GET /api/history?limit=N` | — (TUI history view) |

## Write endpoints

- `POST /api/registry` — body: `RegistryAddInput` (`target`, optional `keyword`/`cluster`/`intent`/`priority`/`country`/`why`/`publishedAt`/`baselineDate`/`status`). Keyword rows require cluster, intent, and priority.
- `PATCH /api/registry` — body: `{ target, keyword?, patch: RegistryPatch }`.
- `POST /api/log` — body: `{ path, kind, date?, note? }`.

## Jobs (Google-touching, asynchronous)

- `POST /api/jobs/sync` → `202` with the job record, or `409` if a job is already running. One job at a time — syncs use delete-then-insert transactions that must not interleave.
- `POST /api/jobs/backfill` — body: `{ months? }` (default 16).
- `GET /api/jobs` — job history for this server process (in-memory).

## Native app format

`GET /pages.txt?window=N` — pipe-delimited lines for the Native SDK frontend (its app-core subset has no JSON parser):

```
latest=2026-07-14|window=2026-06-17..2026-07-14
/|1|22|4.5%|4.5
/docs|0|4|0.0%|25.3
```

Metrics prefer `trueTotals` and fall back to `allQueries` (current window). The native app lives at `~/Documents/sleevy-native-proto`.

`GET /tui/home.txt`, `/tui/opportunities.txt`, `/tui/history.txt`, `/tui/registry.txt` — full TUI-mirroring view feeds ([src/native-feed.ts](../src/native-feed.ts)), tab-separated:

```
header <TAB> <one header line>
head   <TAB> c0..c5 column titles
row    <TAB> id <TAB> c0..c5 <TAB> url   (url empty when not openable)
detail <TAB> id <TAB> <one detail line>  (repeated, ordered)
```

All report formatting happens server-side; the native app only splits bytes, routes row selection to the matching detail lines, and charts history impressions.

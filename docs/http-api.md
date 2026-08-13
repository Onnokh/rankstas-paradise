# HTTP API

`bun run apps/server/src/main.ts` (or `bun --cwd apps/server run serve`) starts the HttpApi server. It binds `0.0.0.0` on port `SEO_PORT` (default 8790) and is bearer-gated: every request needs `Authorization: Bearer <RP_TOKEN>`. It is built on the `packages/domain` Effect services; payloads match the CLI's JSON documents, and every response carries `generatedAt` and `mode` (`live`/`debug`). Add `--debug` to serve the isolated fake fixture.

## Read endpoints (local data only, never call Google)

| Endpoint | CLI equivalent |
|---|---|
| `GET /api/sites` | — (configured site catalog) |
| `GET /api/status` | `status` |
| `GET /api/pages?window=N` | `pages --window N` |
| `GET /api/page?path=/x` | `page /x` |
| `GET /api/queries?page=&window=&min-impressions=&include-brand=true&limit=` | dual-engine `queries` report (Google 7d + Bing rolling window; `window` is ignored) |
| `GET /api/opportunities?kind=` | `opportunities --kind` |
| `GET /api/registry` | `registry` |
| `GET /api/log?path=` | `log list` |
| `GET /api/history?limit=N` | — (TUI history view) |

All site-scoped endpoints accept `?site=<id>`. The default is the first configured site. For example:

```text
GET /api/pages?site=<id>&window=28
GET /api/opportunities?site=<id>
GET /tui/home.txt?site=<id>
```

The site catalog is configured in `config.json` under `sites`. Each site gets isolated SQLite, registry, and sitemap state under `sites/<id>/` in the app home. On the server, each site is served by its own cached `ManagedRuntime` with the active site bound as `CurrentSite` (see [adr/0002-effect-v4-monorepo.md](adr/0002-effect-v4-monorepo.md)).

## Write endpoints

- `POST /api/registry` — body: `RegistryAddInput` (`target`, optional `keyword`/`cluster`/`intent`/`priority`/`country`/`why`/`publishedAt`/`baselineDate`/`status`). Keyword rows require cluster, intent, and priority.
- `PATCH /api/registry` — body: `{ target, keyword?, patch: RegistryPatch }`.
- `POST /api/log` — body: `{ path, kind, date?, note? }`.

## Jobs (Google-touching, asynchronous)

- `POST /api/jobs/sync?site=<id>` → `202` with the job record, or `409` if a job is already running. One job at a time — syncs use delete-then-insert transactions that must not interleave.
- `POST /api/jobs/backfill?site=<id>` — body: `{ months? }` (default 16).
- `GET /api/jobs?site=<id>` — job history for this server process (in-memory). `site` is optional here, unlike the other site-scoped routes: omitting it falls back to the first configured site.

## Native app format

The server also renders plain-text feeds for the native desktop client, whose
app-core subset has no JSON parser:

- `GET /sites.txt` — the site catalog.
- `GET /pages.txt?site=<id>&window=N` — pipe-delimited page lines.
- `GET /tui/{home,opportunities,history,registry,log,queries}.txt?site=<id>` — the full
  TUI-mirroring view feeds (tab-separated, typed detail nodes).

These come from [apps/server/src/native-feed.ts](../apps/server/src/native-feed.ts). The complete wire grammar (line kinds, tones, slots) is documented in [native-app-contract.md](native-app-contract.md). All report formatting happens server-side; the native app only splits bytes.

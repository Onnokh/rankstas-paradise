# Web analytics enters through one port, in one canonical form

## Status

accepted. Adds a second data source beside Search Console; nothing in
[0001](0001-rp-as-hosted-service.md)–[0003](0003-service-account-auth.md)
changes.

## Context

Ranksta's Paradise measures how a site is *found*: Search Console clicks,
impressions, queries, positions. It says nothing about what happens once
people arrive. The sites it tracks already run a web-analytics product
(Rybbit today, self-hosted), and the numbers that matter for judging an SEO
page — visits from all channels beside organic clicks, and conversions such as
`purchase` — live there.

Pulling that in raises one design question: how to add Rybbit without
committing the codebase to Rybbit. The next site may run Umami or GA4, Rybbit's
API is marked beta, and a self-hosted instance can be replaced. Two shapes were
on the table:

1. **Vendor-shaped.** A `rybbit` module, `rybbit_*` tables, `rybbit` fields on
   the reports. Fast to write, and every later vendor means new tables, new
   report keys, and a migration of every client.
2. **Port and canonical schema.** Decide once what Ranksta wants to know,
   store that, and make each vendor an adapter that produces it.

## Decision

**Shape 2.** The domain gains an `analytics` module whose schema is the
contract, and the vendors live behind it.

### The canonical schema is the intersection, not the union

`packages/domain/src/analytics/schema.ts` defines three series and nothing
else:

- **site visits per day** — pageviews, visits, visitors;
- **page visits per day** — pageviews and visits per *path*;
- **event counts per day** — how often each named custom event fired.

These are what Rybbit, Umami and GA4 can all answer. Bounce rate and time on
page are deliberately absent: every vendor defines them differently, so they
would not survive a change of provider. Funnels, replays, journeys and the
like are out of scope for the same reason — Ranksta is not a second analytics
dashboard, it joins two ledgers by page and day.

`page` is a **path** (`/pricing`), unlike Search Console's full-URL `page`,
because that is what analytics vendors report and what the registry keys
targets by. Reports bridge the two with the existing `pathOf` helper.

### One provider per site, chosen in config

A site's `config.json` entry may carry
`analytics: { provider, siteId, baseUrl?, timeZone? }`. `provider` is a plain
string naming an adapter; `siteId` is the vendor's own id for the site;
`baseUrl` points a self-hosted instance; `timeZone` (default `UTC`) is the
zone the vendor is asked to bucket days in. The API key is **not** in config:
like `AHREFS_API_KEY`, it is an environment variable the adapter reads
(`<PROVIDER>_API_KEY`), redacted, and a blank value counts as absent.

Sites without the block have no analytics. Everything downstream treats that
as the ordinary case, not an error.

### The port and the registry

`Analytics` is a site-scoped service with two methods: `status()` — which
provider is configured and whether this deployment can read it — and
`fetchVisits(dates)` — canonical rows for a list of dates. It builds the
adapter once, at layer acquisition, from a registry
(`analytics/providers.ts`) that maps provider names to factories. **That
registry is the only file in the domain that knows which vendors exist.**
Adding a vendor is one adapter module plus one entry there.

The port takes a *list of dates*, never a single day or a range, so the
adapter decides how to batch: Rybbit and Umami need one call per day for the
per-page breakdown, GA4 answers a whole range in one report.

A provider that is named but has no adapter, or whose adapter cannot be built
(no key), does **not** fail the site's runtime. The site is *configured but
not ready*: `status()` says why, only `fetchVisits` fails.

### Storage is vendor-neutral

Four tables in the same per-site SQLite: `analytics_site_daily`,
`analytics_page_daily`, `analytics_event_daily`, and `analytics_synced_day`
(the visits twin of `synced_day`). No table or column is named after a
product. Each row carries a `source` column with the provider name — kept so
a change of provider halfway through a series stays visible, never queried
by. Raw vendor payloads are not stored: keeping them "just in case" is a
commitment to parsing that vendor's shape forever.

### Sync rides along, like Domain Rating

The daily sync forks the visits refresh beside the Search Console work. It
fetches the missing days of the tracked range plus the stale part of a
two-day reconcile window (visits have no finalization lag — a day is complete
at its midnight, so the newest whole day is yesterday). Failure is swallowed
so a vendor outage or a wrong key can never cost a site its Search Console
refresh — but unlike the rating it is **logged**, because otherwise a bad key
shows only as visits that quietly stop moving.

### Reports carry visits as optional keys

`status.analytics`, `pages[].visits`, `page.visits`, `history.days[].visits`,
and the dashboard's `analytics` / `visitsHistory` / `events` are all
`Schema.optional`. The TUI and the Mac app decode against these schemas but
run against whatever server is deployed; a required key would break every
client until it was updated in lockstep (the same reasoning as
`DashboardSnapshot.domainRating`). Windows are anchored on the Search Console
latest date so clicks and visits describe the same days.

## Consequences

- The first adapter is Rybbit (`analytics/rybbit.ts`, key `RYBBIT_API_KEY`).
  It needed nothing outside its own file and one registry line, which is the
  test the port had to pass. Every later adapter must clear the same bar; if
  one cannot, the port is wrong and gets fixed first.
- Rybbit's metric endpoint sums over its range and has no day dimension, so the
  per-page and per-event series cost one call per day each. Self-hosted
  instances are not rate limited; the cloud allows a burst of 50 and 5/s, which
  the adapter's default of four days in flight stays under.
- The glossary gains Analytics provider, Pageview, Visit, Visitor and Event
  (see CONTEXT.md). "Traffic" stays loose; a number is clicks or visits.
- Search Console reports days in Pacific time and the provider in the site's
  configured zone, so the two ledgers never share a midnight exactly. Accepted:
  one fixed zone per site keeps the offset constant, and the join is by day.
- Backfilling visits history is not wired yet; the first sync takes the last
  28 days and later syncs fill gaps forward. A provider that keeps long
  history can be backfilled through the same port later.

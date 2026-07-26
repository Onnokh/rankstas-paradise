# Spec — Bing Webmaster support

## Problem Statement

I track how my sites perform in Google, in detail: true totals, non-brand
performance per keyword target, verdicts, and opportunities. I have no idea how the
same sites perform in Bing. I assumed the answer was "irrelevantly little", so I
never looked.

That assumption is wrong. For one of my two sites Bing delivers roughly **12% of the
clicks Google does**. That is a meaningful slice of demand I currently cannot see at
all, cannot compare, and cannot notice changing. I also cannot tell whether a query
I have written off as dead in Google is quietly working in Bing.

Separately, Bing's data has a property Google's does not: it evaporates. Bing serves
only a rolling handful of days and offers no way to ask for a date range. Every day
I do not collect is a day I can never recover. So the cost of continuing to ignore
it compounds.

## Solution

Bing appears throughout the app as a clearly-labelled **second engine**, sitting
beside Google, never blended into it.

On Home, a strip of cards shows impressions, clicks and CTR for both engines over
both a 28-day and a 7-day window, so the comparison is the first thing I see. A
Queries view lists observed queries with both engines side by side over a matched
window. On a registry row, each keyword shows what it earned in Bing as well as
Google, and Bing's crawl status sits beside Google's index status.

Bing is **decoration, not judgement**. Verdicts, phases, opportunities and baselines
remain entirely Google-derived, and true totals keep their existing meaning as
Google's query-less daily totals. I am never shown a number that silently mixes the
two, because the two are not the same unit — Bing counts impressions from chat and
image surfaces that Google's web-type data excludes.

Collection runs on the existing daily sync. Because each run re-fetches Bing's whole
available window, the schedule can miss up to a week without losing anything.

## User Stories

1. As an operator, I want Bing impressions and clicks shown beside Google's on Home, so that I can see at a glance how much demand I am not measuring.
2. As an operator, I want impressions, clicks and CTR each shown for both engines, so that I can compare the engines on the metrics I actually act on.
3. As an operator, I want both a 28-day and a 7-day figure for each metric, so that I can separate a trend from a blip.
4. As an operator, I want the 28-day window to mean the same 28 days it means everywhere else in the app, so that the cards agree with the history view and with verdicts.
5. As an operator, I want Bing's CTR derived from its own clicks and impressions, so that a missing field in the source does not become a missing card.
6. As an operator, I want the cards to tell me how many days of Bing data actually exist when it is fewer than the window, so that I do not read a partial figure as a decline.
7. As an operator, I want the card strip to shrink to a single line on a short terminal, so that it never eats the table underneath it.
8. As an operator, I want the cards only on Home, so that the registry, history and log views keep their full height.
9. As an operator, I want a site with no Bing traffic to show zero rather than an error or a blank, so that "no demand" is distinguishable from "broken".
10. As an operator, I want a Queries view listing observed queries with both engines' clicks, impressions and position, so that I can find queries that behave differently across engines.
11. As an operator, I want Google's figures in that view aggregated to the same window Bing offers, so that I am comparing like with like rather than reading a 28-day number against a 7-day one.
12. As an operator, I want the page that ranked shown for Google queries even though Bing cannot provide one, so that I do not lose Google capability for the sake of symmetry.
13. As an operator, I want brand queries filtered out of the Queries view by default for both engines, so that the view behaves consistently with the rest of the app.
14. As an operator, I want each keyword on a registry row to show what it earned in Bing, so that I can judge a keyword target on both engines.
15. As an operator, I want that keyword-to-Bing match to be an exact match on the search term, so that I am reading a measurement and not an estimate.
16. As an operator, I want Bing's crawl and discovery status for a target URL beside Google's index status, so that I can see if Bing simply has not found the page.
17. As an operator, I want a target URL that Bing has never indexed to be reported as not indexed rather than as freshly crawled, so that a sentinel value in the source does not read as good news.
18. As an operator, I want inventory-only pages to state plainly that no Bing data exists for them, so that I am not left wondering whether collection failed.
19. As an operator, I want to enable Bing by setting a single credential, so that turning it on requires no code change or per-site configuration.
20. As an operator, I want the app to work exactly as it does today when no Bing credential is present, so that adding this feature cannot break my existing setup.
21. As an operator, I want each site's Bing property resolved from the site's existing origin, so that I do not maintain a second URL per site.
22. As an operator, I want an unrecognised or unverified property to fail loudly, so that I never stare at an empty column that is actually a configuration error.
23. As an operator, I want a Bing failure to leave the Google sync untouched, so that an outage in a decorative data source cannot cost me my primary data.
24. As an operator, I want Bing collected on the existing daily schedule, so that no new scheduling or infrastructure is involved.
25. As an operator, I want each sync to re-fetch Bing's full available window, so that Bing's later revisions land automatically and a missed day self-heals.
26. As an operator, I want the status readout to surface a gap or staleness in Bing collection, so that I learn about a silent multi-day outage while it is still recoverable.
27. As an operator, I want Bing collected for a site with almost no traffic, so that history exists if that site later gains traction — because it can never be backfilled.
28. As an operator, I want to keep seeing Google's average position on Home even though Bing has no equivalent, so that adding an engine does not cost me an existing metric.
29. As an operator, I want never to see a verdict, phase, opportunity or baseline influenced by Bing, so that the judgements I trust keep the meaning they have today.
30. As an operator, I want true totals to keep meaning Google's query-less daily totals, so that the honest headline number stays the number my analysis runs on.
31. As an operator, I want the difference in what the two engines count to be stated where I might otherwise compare them naively, so that I do not read a ratio as more precise than it is.
32. As an agent, I want Bing metrics available through the same reports I already read, so that I can answer questions about engine performance without a new integration.
33. As an agent, I want every metric to declare which engine it came from, so that I never present a blended figure as a single source.
34. As an agent, I want to know which dimensions Bing cannot answer, so that I say "Bing cannot report this" instead of inventing a number.

## Implementation Decisions

**A new Bing Webmaster client service** joins the domain package alongside the
existing Search Console service, and mirrors its shape: a service interface with
typed errors, a self-contained transport, and retries on transient failures. It
exposes three reads — daily site totals, the query window, and per-URL crawl info.
It is the only module that knows Bing exists at the wire level.

**Authentication is a single API key**, not a service account. Bing issues one key
per *user*, valid across every verified property, so it is configured once at the
top level rather than per site. It resolves through the existing configuration
service, which already layers environment over file with environment winning, and it
occupies the redacted-secret slot that service already documents. When the key is
absent, Bing is off and nothing else changes.

**A site's Bing property is derived from the site's existing origin.** No new
per-site setting. Bing normalises protocol, `www` and trailing slash, and rejects an
unverified property outright, so derivation is safe and misconfiguration is loud.
The value passed must be a bare origin: a path is accepted but returns nothing.

**Three new tables**, all additive. Nothing existing is altered, so the absence of a
migration mechanism is not a blocker. The keys encode decisions that prose states
less precisely:

- Site totals keyed by **date** — a genuine daily series, safe to sum.
- The query window keyed by **(capture date, query)** — each row is a *rolling
  aggregate*, not a day. Consecutive captures overlap heavily, so these rows must
  never be summed across capture dates; only the newest capture is read.
- Per-URL crawl info keyed by **target URL**, refreshed on a TTL, mirroring how
  Google's index status is already stored.

No stored CTR column: Bing publishes no CTR field, and deriving it at read time is
what the existing aggregations already do.

**Position** is stored from Bing's impression-weighted average only. Bing's
click-position field is unusable — it reports a sentinel on every row, including
rows with clicks. Bing's positions are integers, so they cannot reproduce the
decimal precision of Google's.

**Sync** gains Bing steps inside the existing job and the existing single-job lock.
They are wrapped so that no Bing outcome can fail the Google sync — non-negotiable,
because Bing has endpoints that return success with an empty payload and an
undocumented rate limit. There is no backfill path, because no date-range parameter
exists to backfill with. Each run re-writes Bing's whole available window, which
absorbs revisions without extra logic.

**Reports** gains per-engine blocks on the existing site, query and registry
readouts rather than new report types. Because the Google data is stored daily, it
is aggregated down to whatever window Bing offers so the two are compared over
matched windows — the alternative, labelling a mismatch, was rejected.

**The TUI gains a Home card strip and a Queries view.** The card strip is three
cards — one per metric — each carrying both windows and both engines, laid out full
width above the master/detail split. Three cards, not six: at the app's minimum
width six cards leave too little room for a label and two figures. The strip is
Home-only, and it collapses to one line on a short terminal. The row-limit
calculation that sizes the master table must account for the strip's height, or rows
clip silently — a bug of exactly this kind has already shipped once.

The Queries view is a sixth view with its own master table and detail pane. It is
the largest single piece of work in this spec, roughly equal to everything else
combined, and it is the one part the operator has demonstrably lived without.

**The native app feed is unchanged.** Its cards are rendered by an out-of-repo
client from a line grammar whose card line carries a single value, so showing two
engines there needs a grammar addition and a coordinated change in that repository.
Deliberately deferred.

**The MCP surface** gains the same per-engine blocks as the reports it wraps. The
skill document that describes those tools lives outside this repository and needs
updating separately.

## Testing Decisions

A good test here asserts **external behaviour at the highest seam that can observe
it**: the numbers a report returns, the rows a sync leaves behind, the error a bad
credential produces. It does not assert how a client builds a URL, how many
statements a repository runs, or the internal order of a job's steps. Every seam
below already exists in this codebase — this feature introduces no new kind of test.

**The Bing client, behind a fake HTTP layer.** Prior art: the Search Console client
tests, which serve canned responses from a URL-keyed handler with no network. This
is where the source's quirks are pinned, because it is the only seam that can see
them: the .NET-style date encoding with a trailing offset, the response envelope and
type annotations, the sentinel values that mean "never indexed" behind a success
response, and error classification keyed on the numeric error code rather than the
message text.

**Sync behaviour, behind a mocked Bing service.** Prior art: the sync tests, which
mock the Search Console service to record what it was asked for. Covers that a run
re-writes the full available window so revisions land, and — the most important test
in this spec — that a Bing service which fails still leaves the Google sync
successful and its data written.

**Everything read-side, through the reports service over a seeded database.** Prior
art: the existing reports tests. Covers the per-engine figures at both windows,
derived CTR, the exact keyword-to-query join, the collected-day count when the
window is not yet full, and the invariant that overlapping query captures are never
summed. Deliberately no separate storage-level tests: any rule observable at reports
is tested there instead.

**Card formatting and sizing, through the existing pure presentation helpers.**
Prior art: the presentation tests. Justified specifically by the height arithmetic —
the class of clipping bug it prevents has already shipped once.

## Out of Scope

- **Bing traffic per page.** Every page-dimension traffic endpoint returns success
  with no rows for a site that demonstrably has traffic. This is a defect in the
  source, not a gap in our implementation, and it is not ours to fix. The
  keyword-to-query join is the substitute.
- **Estimating page-level Bing figures** by attributing matched keywords to their
  target URLs. It would look measured while being inferred, and would miss the
  majority of impressions that the source withholds as long tail.
- **Bing influencing any judgement** — verdicts, phases, opportunities,
  striking-distance, baselines, or true totals.
- **Historical backfill.** No date-range parameter exists.
- **Bing's click-position metric.** Unusable; sentinel on every row.
- **Country and device dimensions.** Absent from the source API.
- **Crawl statistics ingestion** (indexed-page counts, crawl error codes). Available
  and interesting, but a separate feature.
- **Cards in the native desktop app.** Needs a feed-grammar addition and an
  out-of-repo change.
- **A Bing series in the history view.** Open question, deliberately unresolved: one
  site has hundreds of days of Google history against Bing's handful, so the chart
  would need to render pre-collection days as absent rather than zero, and the value
  is low until Bing has months banked.

## Further Notes

Every claim about the source API in this spec was measured against it directly with
a live credential, not taken from documentation — the documentation is stale and in
places wrong. The material findings: the site-level window is around a week rather
than the months the vendor's own UI advertises; there is no date-range parameter on
any traffic endpoint; the query endpoint returns one flat aggregate per query rather
than a series; two endpoints report materially different figures for the same query,
so one must be chosen as canonical; and the data lags roughly two days.

Impression counts are not comparable between engines: Bing's include chat and image
surfaces that the Google data deliberately excludes. Click counts are the more
honest basis for comparison, and even they should be read as an order of magnitude.

Two observations surfaced while measuring, both out of scope but worth their own
tickets: one site's Bing indexed-page count is falling day over day while a
substantial share of crawl responses are non-success; and the other site ranks
several positions down for its own brand name.

The credential used for measurement was exposed during research and carries write
scope. It must be regenerated.

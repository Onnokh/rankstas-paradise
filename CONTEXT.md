# Ranksta's Paradise

The vocabulary of a local-only tool that tracks Google Search Console performance for one or more sites, maps intended keywords to URLs, and classifies where there are opportunities to win or recover traffic. This glossary describes the *application's* domain language — not SEO content itself. Terms are anchored in standard SEO / Search Console usage; where the app bends a term, that is noted.

## Language

### Sites & pages

**Site**:
A tracked web property (e.g. Sleevy, Missingmounts). Each site has isolated Search Console history, registry, and sitemap state.

**Page**:
A URL on a site — the Search Console "Page" dimension, and the unit measured by true totals.
_Avoid_: "target" as a synonym (a target URL is a narrower idea; see below).

**Target URL**:
The page a keyword is assigned to rank on. Shorthand: "target". Not a first-class entity — just a page a keyword points at. One page can be the target URL for many keywords.

**Inventory-only page**:
A sitemap URL tracked with a blank keyword: it collects page-level performance without being a keyword target, and is judged on all-queries. Its opposite is a keyword target.
_Avoid_: "PAGE row".

### Keywords & planning (the registry)

**Registry**:
The SEO plan: the CSV mapping of keywords to target URLs, with each row's intent, priority, rationale, and phase.
_Avoid_: "SEO plan" as a competing noun.

**Keyword**:
A *target keyword* — the search term you intend a page to rank for. Planned, lives in the registry.
_Avoid_: using "query" for a planned term.

**Cluster**:
A group of related keywords sharing a target URL and theme (a topic cluster).

**Intent**:
The search intent behind a keyword.

**Priority**:
The planned importance of a keyword target.

**Rationale**:
The recorded reason a cluster is worth targeting (the `why_opportunity` column).

### Queries & measurement

**Query**:
The actual search term a user typed, as reported by Google Search Console. Observed, not planned.
_Avoid_: using "keyword" for an observed term.

**Brand query**:
A query containing the site's brand name (e.g. `sleevy`). Its complement is **non-brand**.

**All-queries**:
Metrics summed from stored per-query rows, brand *included*. Inventory-only pages are judged on this.

**Non-brand**:
The all-queries metrics with brand queries filtered out. Keyword targets are judged on this.

**True totals**:
Clicks and impressions from Google's query-*less* daily totals — the honest headline numbers, including the long-tail traffic Google withholds from per-query rows.

**Window**:
A rolling N-day period (default 28). Reports compare the current window against the previous one.

**Baseline**:
A target URL's pre-launch 28-day window — the reference point for measuring lift after launch.

### Analysis & status

**Opportunity**:
A detected chance to win or recover traffic on a page or query, classified into one of four kinds below.
_Avoid_: "signal".

**Striking-distance**:
An opportunity kind: a query ranking just outside the results that pay off (roughly positions 11–20), close enough to push onto page one.

**CTR**:
An opportunity kind: a page or query earning far fewer clicks than its impressions and position should yield.

**New-demand**:
An opportunity kind: a newly appearing query with no keyword target mapped to it yet.

**Cannibalization**:
An opportunity kind: multiple pages competing for the same query, splitting its performance.

**Verdict** (app-specific):
The application's per-page judgment of performance — one of `improving`, `declining`, `needs-optimization`, `needs-attention`, `new-visibility`, `no-visibility`, `steady`, or `awaiting-launch`.

**Phase** (app-specific):
The launch stage of a keyword target: **PRE** (its published/baseline date is still ahead of the available data), **LIVE** (it has impressions), **NONE** (measured but no impressions yet), **UNMAPPED** (a page with no target). Distinct from Verdict — Phase is about launch timing, Verdict is about performance.

**Indexed**:
Whether Google's URL Inspection reports a target URL as in its index. Un-indexed targets are dimmed in the interface.

### Work record

**Log**:
The chronological record of Actions and Notes for a site (the `action_log` table). Each entry is attached to a **Target URL / Page** by its path — never to an individual keyword row, so many keyword rows sharing one target share one log. Surfaced site-wide, on a page's detail, and as a recent-activity glance on Home.

**Action**:
A concrete change made to a page to influence its ranking, recorded so before/after windows can be compared — one of `publish`, `content-update`, `title-change`, `internal-links`, or `consolidation`.
_Avoid_: "intervention".

**Note**:
A free-form annotation recorded in the same log as actions, but *not* a change to the page. Separate from an Action.

### Data operations

**Sync**:
The daily refresh — fetch missing finalized days and reconcile the newest few.

**Backfill**:
A one-time historical fetch (Google retains roughly 16 months).

**Reconcile**:
Re-fetch the newest finalized days as a complete unit, to absorb Google's late processing.

**Finalized**:
A date whose Google data is settled enough to store.

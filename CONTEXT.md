# Ranksta's Paradise

The vocabulary of a local-only tool that tracks Google Search Console performance for one or more sites, maps intended keywords to URLs, and classifies where there are opportunities to win or recover traffic. This glossary describes the *application's* domain language — not SEO content itself. Terms are anchored in standard SEO / Search Console usage; where the app bends a term, that is noted.

## Language

### Sites & pages

**Site**:
A tracked web property. Each site has isolated Search Console history, registry, and sitemap state.

**Catalog**:
The stored list of sites and their settings, in the app-level database. The server reads it on every request and the settings routes write it. A legacy `config.json` is imported into it once.
_Avoid_: "config" for the list of sites.

**Site settings**:
Everything a catalog entry holds except its id: the Search Console property, name, origin, sitemap URL, brand terms, and the analytics and revenue provider blocks. Never a vendor key.

**Vendor key**:
The API key a provider (Polar, Rybbit, Ahrefs) is read with. Stored encrypted in the vault, addressed by scope (a site, or the app) and purpose (the provider name), and handed to the provider's adapter under the environment variable it reads. The environment variable is the fallback. Never part of Site settings.
_Avoid_: "secret" for the concept in prose (the code's name for the vault entry); "credential".

**Client**:
One program that talks to the server with its own bearer token: a Mac, a TUI, an agent. A client's token is shown once when the client is created; the server keeps its hash, and revoking the client ends the token. The shared `RP_TOKEN` is the bootstrap and break-glass token beside them.

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
A query containing the site's brand name. Its complement is **non-brand**.

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
The launch stage of a keyword target, in lifecycle order: **NEW** (the site has no query data at all yet), **PRE** (the synced data has not yet passed its published/baseline date, or no date is set), **NONE** (measured past the baseline, no impressions yet), **LIVE** (it has impressions). Two more cover non-targets: **PAGE** (an inventory-only row — tracked, but with no keyword to launch) and **UNMAPPED** (a page with no registry row at all). Distinct from Verdict — Phase is about launch timing, Verdict is about performance.

**Indexed**:
Whether Google's URL Inspection reports a target URL as in its index. Un-indexed targets are dimmed in the interface.

### Visits (analytics)

The second ledger. Search Console says how a site is *found*; the analytics provider says what happens once people *arrive*. Both series are keyed by page and day so a report can set them side by side.

**Analytics provider**:
The web-analytics product a site sends its visits to — Rybbit, Umami, GA4, or another. One per site, named in the site's config; Ranksta only reads from it. Every provider's data is stored in the same canonical form, so a site can change provider and keep its history.
_Avoid_: naming the product where the concept is meant ("the Rybbit numbers").

**Pageview**:
One load of a page, as the analytics provider counts it.

**Visit**:
One session on the site, as the analytics provider counts it. Counts sum across days.
_Avoid_: "session".

**Visitor**:
One distinct person on one day, as the analytics provider counts it. Does not sum across days, so it is only shown per day.

**Event**:
A named custom action the site reports to its analytics provider (`purchase`, `download_shader`), counted per day. Observed, like a Query. Not an Action — an Action is a change *we* made to a page; an Event is something a *visitor* did.

**Live visitors**:
The distinct people active on the site in the last thirty minutes, as the analytics provider counts them, with one count per minute of that window. Asked on demand and shown at most thirty seconds old; never stored, never on the dashboard.

**Online**:
The distinct people active on the site in the last five minutes: the ones there right now. The figure beside a site's name. The five minutes are what Rybbit and Umami call online; Live visitors is the wider window the realtime bars cover.

**Today**:
The provider's current calendar day in the site's time zone, so far: totals, one row per hour, pages and events. Stored in the ledger like every other day and re-fetched from the provider every five minutes until the day ends; the daily sync fetches the finished day once more. Search Console lags days, so Today has no Search Console figures.

**Traffic**:
Loosely, both. When a number is meant, say which: clicks (Search Console) or visits (analytics).

### Revenue (commerce)

The third ledger. Search Console says how a site is *found*, the analytics provider what people *do* there, the commerce provider what they *buy*. Keyed by day like the other two.

**Commerce provider**:
The product a site sells through — Polar, Stripe, Lemon Squeezy, or another. One per site, named in the site's config; Ranksta only reads from it, in the same canonical form whichever vendor it is. Its key is per account, so each site names the environment variable that holds it.
_Avoid_: naming the product where the concept is meant ("the Polar numbers").

**Order**:
One completed purchase, as the commerce provider counts it, on the day it was paid in the site's zone. Counts sum across days.
_Avoid_: "sale", "transaction".

**Revenue**:
What customers paid, summed over a day or a window, in the currency's minor unit (cents) on the wire and shown in the currency. Refunds do not reduce it.
_Avoid_: "gross".

**Net revenue**:
What reached the seller: revenue less refunds and less the commerce provider's fees, as that provider defines them. Compare it within one provider only; Revenue is the headline. Shorthand: "net".

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

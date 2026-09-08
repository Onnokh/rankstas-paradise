# Revenue enters through a second port of the same shape

## Status

accepted. Adds a third data source beside Search Console and web analytics;
nothing in [0004](0004-analytics-provider-port.md) changes.

## Context

With visits in the ledger, the next number that judges an SEO page is what the
visitors bought. The sites Ranksta tracks sell through Polar today; the next
one may sell through Stripe or Lemon Squeezy. The question and its answer are
the ones 0004 settled for analytics, so this record is short: it says what is
the same, what differs, and why.

## Decision

A `revenue` module beside `analytics`, built to the same pattern: a canonical
schema, a provider port, a registry that is the only vendor-aware file, an
adapter per vendor, vendor-neutral tables, a sync that rides along, and reports
that carry the series as optional keys.

### The canonical schema is one series

`packages/domain/src/revenue/schema.ts` defines one row: **orders, revenue and
net revenue per day**, with a currency code. That is what Polar, Stripe and
Lemon Squeezy can all answer per day. Amounts are in the currency's minor unit,
as every vendor reports them, so they add without rounding. Revenue is what
customers paid and is the figure that compares across providers. Net is the
provider's own net — revenue less refunds and less its fees, which each vendor
defines differently — so it is carried for the tooltip and compared within one
provider only. Per-product breakdowns,
subscriptions, MRR and churn are out of scope: Ranksta is not a second billing
dashboard.

### The key is per account, so the variable is per site

An analytics key is per organisation and one variable serves every site on the
instance. A commerce token is per seller account: Polar issues one per
organisation, and two sites sold through two organisations need two tokens.
The config block therefore gains `keyVariable`, the environment variable the
adapter reads, defaulting to `<PROVIDER>_API_KEY`. The token itself stays out
of config, as before. `accountId` is optional, because such a token is already
scoped to its account.

### The day is the analytics day

`timeZone` defaults to the site's analytics zone when it has one, so an order
and the visit that placed it land on the same calendar day and the three
ledgers can be read side by side.

### A year on the first run

Polar's metrics endpoint answers up to 366 days in one call, where an
analytics API needs one call per day for its page breakdown. The first run
therefore fetches a year of history — enough to compare the app's longest
period with the one before it — and the reconcile window is a week, because a
refund lands on the day of its order, days later. The today sync refreshes
today's row beside today's visits; the daily sync fetches it once more when
the day is whole.

### Reports

`GET /api/revenue?window=N` (and the `revenue` MCP tool) answers the current
window's synced days, oldest first, with the totals of that window and the
one before and their deltas, anchored on the newest whole day like the events
report. `GET /api/status` gains a `revenue` key beside `analytics`. Both are
optional on the wire for the reason 0004 gives.

## Consequences

- The first adapter is Polar (`revenue/polar.ts`). It needed nothing outside
  its own file and one registry line, which is the test the port had to pass.
- Two sites on Polar mean two variables in the server environment, named in
  each site's `revenue.keyVariable`. A missing one shows as `ready: false` on
  the status report and never fails a sync.
- Polar reports its metrics in US dollars and carries no currency field; the
  adapter writes `USD` on every row. A vendor that settles in several
  currencies would need to answer per currency, which the row shape allows and
  the report does not yet sum across.
- The glossary gains Commerce provider, Order, Revenue and Net revenue (see
  CONTEXT.md).

// Frozen data shapes for the Reports domain — the DTOs the CLI, HTTP server,
// and TUI render. These mirror the exact return shapes of the legacy service.ts
// and are the contract downstream frontends and the HTTP server code against.
import { Schema } from "effect"

import {
  AnalyticsStatus,
  LiveEvents,
  LiveVisitors,
  TodayVisits,
  SiteVisitsDay,
} from "../analytics/schema.ts"
import { DomainRating, DomainRatingDay } from "../domain-rating/schema.ts"
import { RevenueDay, RevenueStatus } from "../revenue/schema.ts"

import {
  EventWindowRow,
  HistoryDay,
  IndexStatus,
  LogEntry,
  Metrics,
  OpportunityDigest,
  OpportunityKind,
  ProgressState,
  RegistryPerformance,
  RegistryTargetProgress,
  Visits,
} from "../storage/schema.ts"
import { KeywordProposal } from "../keyword-discovery/schema.ts"
import { RegistryEntry, RegistryPatch } from "../registry/schema.ts"
import { SitemapPage } from "../sitemap/schema.ts"

// Metrics after `tidy()`: ctr/position rounded for display. Same shape as Metrics.
export const TidyMetrics = Schema.Struct({
  impressions: Schema.Number,
  clicks: Schema.Number,
  ctr: Schema.Number,
  position: Schema.Number,
}).annotate({ identifier: "TidyMetrics" })
export interface TidyMetrics extends Schema.Schema.Type<typeof TidyMetrics> {}

// A current-vs-previous window with the impression/click deltas (tidyWindow()).
export const TidyWindow = Schema.Struct({
  current: TidyMetrics,
  previous: TidyMetrics,
  deltaImpressions: Schema.Number,
  deltaClicks: Schema.Number,
}).annotate({ identifier: "TidyWindow" })
export interface TidyWindow extends Schema.Schema.Type<typeof TidyWindow> {}

// A current-vs-previous window of visits with its deltas: the visits twin of
// TidyWindow. Counts are whole numbers already, so there is nothing to round.
export const VisitsWindowReport = Schema.Struct({
  current: Visits,
  previous: Visits,
  deltaPageviews: Schema.Number,
  deltaVisits: Schema.Number,
}).annotate({ identifier: "VisitsWindowReport" })
export interface VisitsWindowReport
  extends Schema.Schema.Type<typeof VisitsWindowReport> {}

// One day of site visits for the history report: the analytics twin of the
// Search Console day it sits beside.
export const VisitsDayReport = Schema.Struct({
  pageviews: Schema.Number,
  visits: Schema.Number,
  visitors: Schema.Number,
}).annotate({ identifier: "VisitsDayReport" })
export interface VisitsDayReport
  extends Schema.Schema.Type<typeof VisitsDayReport> {}

// A registry entry summarized for display (entrySummary()).
export const EntrySummary = Schema.Struct({
  keyword: Schema.String,
  cluster: Schema.String,
  intent: Schema.String,
  priority: Schema.String,
  publishedAt: Schema.NullOr(Schema.String),
  baselineDate: Schema.NullOr(Schema.String),
  status: Schema.String,
  whyOpportunity: Schema.String,
}).annotate({ identifier: "EntrySummary" })
export interface EntrySummary extends Schema.Schema.Type<typeof EntrySummary> {}

// An opportunity signal summarized for display (signalSummary()).
export const SignalSummary = Schema.Struct({
  kind: OpportunityKind,
  query: Schema.NullOr(Schema.String),
  page: Schema.String,
  pages: Schema.Array(Schema.String),
  mapped: Schema.Boolean,
  current: TidyMetrics,
  previous: Schema.NullOr(TidyMetrics),
  recommendation: Schema.String,
  score: Schema.Number,
  // The Keyword metric behind the signal, when the vendor has one for the
  // query in the Site's Market. Absent means no answer is stored — not that
  // the term has no demand. `searchVolume` is what ranks the signal for three
  // of the four kinds; `difficulty` is reported and never scored, so a reader
  // weighs it against the site's Domain Rating themselves.
  demand: Schema.optional(
    Schema.Struct({
      searchVolume: Schema.NullOr(Schema.Number),
      difficulty: Schema.NullOr(Schema.Number),
      intent: Schema.NullOr(Schema.String),
    }),
  ),
  launch: Schema.optional(
    Schema.Struct({
      daysSinceLaunch: Schema.Number,
      day28: TidyMetrics,
      day56: TidyMetrics,
      day84: TidyMetrics,
    }),
  ),
}).annotate({ identifier: "SignalSummary" })
export interface SignalSummary
  extends Schema.Schema.Type<typeof SignalSummary> {}

// --- FROZEN named types called out by the ticket ---

export const verdictKinds = [
  "awaiting-launch",
  "no-visibility",
  "needs-optimization",
  "needs-attention",
  "new-visibility",
  "improving",
  "declining",
  "steady",
] as const
export const Verdict = Schema.Struct({
  verdict: Schema.Literals(verdictKinds),
  reasons: Schema.Array(Schema.String),
}).annotate({ identifier: "Verdict" })
export interface Verdict extends Schema.Schema.Type<typeof Verdict> {}

// A log entry's before/after readout: "none" for Notes, "window" for Actions on
// a mapped target with data, "unavailable" otherwise.
export const LogReadout = Schema.Union([
  Schema.Struct({ state: Schema.Literal("none") }),
  Schema.Struct({ state: Schema.Literal("unavailable") }),
  Schema.Struct({
    state: Schema.Literal("window"),
    scope: Schema.Literals(["non-brand", "all-queries"]),
    before: Metrics,
    after: Metrics,
    afterComplete: Schema.Boolean,
  }),
]).annotate({ identifier: "LogReadout" })
export type LogReadout = Schema.Schema.Type<typeof LogReadout>

export const LogFeedEntry = Schema.Struct({
  ...LogEntry.fields,
  isAction: Schema.Boolean,
  readout: LogReadout,
}).annotate({ identifier: "LogFeedEntry" })
export interface LogFeedEntry
  extends Schema.Schema.Type<typeof LogFeedEntry> {}

export const QueriesOptions = Schema.Struct({
  page: Schema.optional(Schema.String),
  windowDays: Schema.optional(Schema.Number),
  minImpressions: Schema.optional(Schema.Number),
  includeBrand: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Number),
}).annotate({ identifier: "QueriesOptions" })
export interface QueriesOptions
  extends Schema.Schema.Type<typeof QueriesOptions> {}

export const RegistryAddInput = Schema.Struct({
  target: Schema.String,
  keyword: Schema.optional(Schema.String),
  cluster: Schema.optional(Schema.String),
  intent: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.String),
  why: Schema.optional(Schema.String),
  publishedAt: Schema.optional(Schema.String),
  baselineDate: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
}).annotate({ identifier: "RegistryAddInput" })
export interface RegistryAddInput
  extends Schema.Schema.Type<typeof RegistryAddInput> {}

export const LogAddInput = Schema.Struct({
  path: Schema.String,
  // Validated against the LogKind set at runtime; loose string at the boundary.
  kind: Schema.String,
  date: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
}).annotate({ identifier: "LogAddInput" })
export interface LogAddInput extends Schema.Schema.Type<typeof LogAddInput> {}

export const DashboardSnapshot = Schema.Struct({
  summary: Schema.Struct({ rows: Schema.Number, dates: Schema.Number }),
  registry: Schema.Array(RegistryEntry),
  sitemapGaps: Schema.Array(SitemapPage),
  sitemapPageCount: Schema.Number,
  digest: OpportunityDigest,
  registryTargets: Schema.Array(RegistryTargetProgress),
  logEntries: Schema.Array(LogFeedEntry),
  history: Schema.Array(HistoryDay),
  recentActions: Schema.Array(LogEntry),
  performances: Schema.Array(
    Schema.Struct({
      targetUrl: Schema.String,
      performance: RegistryPerformance,
    }),
  ),
  // Ahrefs' backlink-strength score, or null when the deployment has no Ahrefs
  // key or the site has not been synced since one was added. It rides on the
  // snapshot rather than its own read so both front-ends get it for free, and it
  // is served from the volume — a dashboard never waits on Ahrefs.
  //
  // The KEY is optional, not just the value. The clients decode against this
  // schema but run against whatever server is deployed, so a required key would
  // make every TUI read fail until the server was updated in lockstep. An older
  // server simply omits it and the front-ends show no rating.
  domainRating: Schema.optional(Schema.NullOr(DomainRating)),
  // The accumulated series behind that reading, oldest first, so a client can
  // show the move over whichever period it is displaying. Ahrefs sells only the
  // present value on the free tier, so this starts empty and grows one day per
  // sync — it can never be backfilled.
  domainRatingHistory: Schema.optional(Schema.Array(DomainRatingDay)),
  // The site's analytics provider (null when it has none), its daily site
  // visits, and its event counts over the window — all served from the ledger,
  // never from the provider. Optional keys for the same reason as domainRating.
  analytics: Schema.optional(Schema.NullOr(AnalyticsStatus)),
  visitsHistory: Schema.optional(Schema.Array(SiteVisitsDay)),
  events: Schema.optional(Schema.Array(EventWindowRow)),
}).annotate({ identifier: "DashboardSnapshot" })
export interface DashboardSnapshot
  extends Schema.Schema.Type<typeof DashboardSnapshot> {}

// --- report return shapes ---

export const StatusReport = Schema.Struct({
  data: Schema.Struct({
    firstDate: Schema.NullOr(Schema.String),
    lastDate: Schema.NullOr(Schema.String),
    syncedDays: Schema.Number,
    snapshotRows: Schema.Number,
    dailyTotalsDays: Schema.Number,
    // When Search Console data last arrived for this site (the newest sync), as
    // an ISO 8601 instant; null until the site is synced once. Not the same as
    // the envelope's generatedAt, which is when this response was serialized.
    lastSyncedAt: Schema.NullOr(Schema.String),
    // When Ranksta last ASKED Google for this site — the instant a sync run last
    // completed — as an ISO 8601 instant; null until one has. Kept separate from
    // lastSyncedAt because the two answer different questions and collapsing them
    // loses the distinction that matters: lastSyncedAt is when the DATA CHANGED,
    // and it cannot move on a run that correctly found nothing new. A
    // lastCheckedAt just now over a lastSyncedAt from yesterday is a healthy
    // site; a lastCheckedAt that will not move is a sync that is failing or
    // never being asked for, and the reason for a failure is on the error log.
    lastCheckedAt: Schema.NullOr(Schema.String),
    note: Schema.String,
  }),
  registry: Schema.Struct({
    targets: Schema.Number,
    keywords: Schema.Number,
    clusters: Schema.Number,
  }),
  sitemap: Schema.Struct({
    pages: Schema.Number,
    unmapped: Schema.Array(Schema.String),
  }),
  actions: Schema.Number,
  // The site's analytics provider and how much of its visits series is in the
  // ledger; null when the site has none. `ready: false` with a `reason` means a
  // provider is configured that this deployment cannot read — a missing adapter
  // or key — which is why visits stop moving. Optional key: older servers omit
  // it, and the clients must keep decoding.
  analytics: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        ...AnalyticsStatus.fields,
        days: Schema.Number,
        firstDate: Schema.NullOr(Schema.String),
        lastDate: Schema.NullOr(Schema.String),
        lastSyncedAt: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  // The site's commerce provider and how much of its revenue series is in the
  // ledger, on the same terms as `analytics`.
  revenue: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        ...RevenueStatus.fields,
        days: Schema.Number,
        firstDate: Schema.NullOr(Schema.String),
        lastDate: Schema.NullOr(Schema.String),
        lastSyncedAt: Schema.NullOr(Schema.String),
      }),
    ),
  ),
}).annotate({ identifier: "StatusReport" })
export interface StatusReport extends Schema.Schema.Type<typeof StatusReport> {}

const ReportWindow = Schema.Struct({
  currentStart: Schema.NullOr(Schema.String),
  currentEnd: Schema.NullOr(Schema.String),
  previousStart: Schema.NullOr(Schema.String),
  previousEnd: Schema.NullOr(Schema.String),
})

export const PageReportRow = Schema.Struct({
  path: Schema.String,
  mapped: Schema.Boolean,
  phase: Schema.String,
  priority: Schema.NullOr(Schema.String),
  intent: Schema.NullOr(Schema.String),
  clusters: Schema.Array(Schema.String),
  keywords: Schema.Array(Schema.String),
  publishedAt: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  indexed: IndexStatus,
  whyOpportunity: Schema.NullOr(Schema.String),
  nonBrand: Schema.NullOr(TidyWindow),
  allQueries: Schema.NullOr(TidyWindow),
  trueTotals: Schema.NullOr(TidyWindow),
  baseline: Schema.NullOr(TidyMetrics),
  signals: Schema.Array(OpportunityKind),
  verdict: Verdict.fields.verdict,
  reasons: Verdict.fields.reasons,
  // Pageviews and visits from the site's analytics provider over the same two
  // windows as the Search Console numbers above; null when the site has no
  // provider or no visits synced yet. Beside trueTotals.clicks this says how
  // much of a page's traffic is organic search.
  visits: Schema.optional(Schema.NullOr(VisitsWindowReport)),
}).annotate({ identifier: "PageReportRow" })
export interface PageReportRow
  extends Schema.Schema.Type<typeof PageReportRow> {}

export const PagesReport = Schema.Struct({
  window: Schema.Struct({
    days: Schema.Number,
    currentStart: Schema.NullOr(Schema.String),
    currentEnd: Schema.NullOr(Schema.String),
    previousStart: Schema.NullOr(Schema.String),
    previousEnd: Schema.NullOr(Schema.String),
  }),
  note: Schema.String,
  pages: Schema.Array(PageReportRow),
}).annotate({ identifier: "PagesReport" })
export interface PagesReport extends Schema.Schema.Type<typeof PagesReport> {}

export const PageReport = Schema.Struct({
  path: Schema.String,
  mapped: Schema.Boolean,
  phase: Schema.String,
  state: Schema.NullOr(ProgressState),
  indexed: IndexStatus,
  coverageState: Schema.NullOr(Schema.String),
  inspectedAt: Schema.NullOr(Schema.String),
  measuredFrom: Schema.NullOr(Schema.String),
  plan: Schema.Array(EntrySummary),
  verdict: Verdict.fields.verdict,
  reasons: Verdict.fields.reasons,
  performance: Schema.Struct({
    windowStart: Schema.NullOr(Schema.String),
    windowEnd: Schema.NullOr(Schema.String),
    scope: Schema.Literals(["all-queries", "non-brand"]),
    total: TidyMetrics,
    last7: TidyMetrics,
    previous7: TidyMetrics,
    days: Schema.Array(
      Schema.Struct({
        date: Schema.String,
        impressions: Schema.Number,
        clicks: Schema.Number,
        ctr: Schema.Number,
        position: Schema.Number,
      }),
    ),
  }),
  trueTotals: Schema.NullOr(TidyWindow),
  baseline: Schema.NullOr(TidyMetrics),
  topQueries: Schema.Array(
    Schema.Struct({
      query: Schema.String,
      brand: Schema.Boolean,
      mapped: Schema.Boolean,
      current: TidyMetrics,
      previous: Schema.NullOr(TidyMetrics),
    }),
  ),
  signals: Schema.Array(SignalSummary),
  actions: Schema.Array(LogEntry),
  // As on PageReportRow.
  visits: Schema.optional(Schema.NullOr(VisitsWindowReport)),
}).annotate({ identifier: "PageReport" })
export interface PageReport extends Schema.Schema.Type<typeof PageReport> {}

// What the vendor says about one Keyword or Query, as a report reports it.
// Absent on a row means no answer is stored for that term — not that the term
// has no demand. Every field is nullable for the reasons given on
// ../keyword-metrics/schema.ts: difficulty and intent do not exist for a
// Google-Ads Market, and a volume of null means the term is too rare for
// DataForSEO to report rather than that nobody searches it.
export const DemandReport = Schema.Struct({
  searchVolume: Schema.NullOr(Schema.Number),
  difficulty: Schema.NullOr(Schema.Number),
  costPerClick: Schema.NullOr(Schema.Number),
  competition: Schema.NullOr(Schema.Number),
  intent: Schema.NullOr(Schema.String),
  fetchedAt: Schema.String,
}).annotate({ identifier: "DemandReport" })
export interface DemandReport extends Schema.Schema.Type<typeof DemandReport> {}

// The Market a report's demand numbers describe. Carried on every report that
// holds them, because a search volume without its Market is ambiguous: the
// same keyword has a different number in every country.
export const MarketReport = Schema.Struct({
  locationCode: Schema.Number,
  languageCode: Schema.String,
  label: Schema.String,
  // "labs" or "google-ads". Says in advance whether `difficulty` and `intent`
  // can arrive at all, so a client can leave the columns out rather than
  // render them empty.
  provider: Schema.String,
}).annotate({ identifier: "MarketReport" })
export interface MarketReport extends Schema.Schema.Type<typeof MarketReport> {}

export const QueriesReport = Schema.Struct({
  window: Schema.Struct({
    currentStart: Schema.NullOr(Schema.String),
    currentEnd: Schema.NullOr(Schema.String),
    previousStart: Schema.NullOr(Schema.String),
    previousEnd: Schema.NullOr(Schema.String),
  }),
  queries: Schema.Array(
    Schema.Struct({
      query: Schema.String,
      page: Schema.String,
      brand: Schema.Boolean,
      mappedTarget: Schema.NullOr(Schema.String),
      current: TidyMetrics,
      previous: Schema.NullOr(TidyMetrics),
      // What the vendor says about this observed Query. Absent for a brand
      // query and for an operator query, which are never asked about, and for
      // any query no answer is stored for yet.
      demand: Schema.optional(DemandReport),
    }),
  ),
  // The Market every `demand` block above describes. Optional so an older
  // server's answer still decodes.
  market: Schema.optional(MarketReport),
}).annotate({ identifier: "QueriesReport" })
export interface QueriesReport
  extends Schema.Schema.Type<typeof QueriesReport> {}

export const OpportunitiesReport = Schema.Struct({
  window: ReportWindow,
  totalSignals: Schema.Number,
  signals: Schema.Array(
    Schema.Struct({
      ...SignalSummary.fields,
      registry: Schema.NullOr(
        Schema.Struct({
          targetUrl: Schema.String,
          priority: Schema.String,
          intent: Schema.String,
          cluster: Schema.String,
        }),
      ),
    }),
  ),
}).annotate({ identifier: "OpportunitiesReport" })
export interface OpportunitiesReport
  extends Schema.Schema.Type<typeof OpportunitiesReport> {}

// What the vendor says about one planned Keyword, reduced to the one thing the
// Registry cannot otherwise be checked against: whether anybody searches for it.
//
//   - "unmeasured": nobody has asked DataForSEO about it. No key configured, or
//     the sync has not reached it yet. Says nothing about the keyword.
//   - "unreported": asked, and the vendor has no volume — the term is too rare
//     for it to report. Not the same as nobody searching it, but close enough
//     to it that a page aimed here should not expect traffic.
//   - "no-demand": asked, and the vendor measured zero. The rows to act on.
//   - "has-demand": asked, and there is real demand behind the plan.
export const keywordHealthVerdicts = [
  // Deliberately never asked: the Keyword is the Site's own name. Its own
  // verdict rather than `unmeasured`, because the two lead opposite ways — an
  // unmeasured Keyword asks the reader to configure a key and sync, and this
  // one asks nothing of them ever. Volume on your own brand tells you nothing
  // you can act on, so the row is correct as it stands.
  "brand",
  "unmeasured",
  "unreported",
  "no-demand",
  "has-demand",
] as const
export const KeywordHealthVerdict = Schema.Literals(keywordHealthVerdicts)
export type KeywordHealthVerdict = typeof KeywordHealthVerdict.Type

// One planned Keyword, judged on demand.
export const KeywordHealth = Schema.Struct({
  keyword: Schema.String,
  targetUrl: Schema.String,
  cluster: Schema.String,
  priority: Schema.String,
  // The intent the plan claims for the keyword.
  intent: Schema.String,
  verdict: KeywordHealthVerdict,
  searchVolume: Schema.NullOr(Schema.Number),
  difficulty: Schema.NullOr(Schema.Number),
  // Difficulty minus the site's Domain Rating, when both are known. Positive
  // means the keyword scores harder than the site rates.
  //
  // Reported as a number and never as a verdict. The two are different scales
  // from different vendors measuring related but distinct things, so the gap is
  // a rough guide and not a threshold — turning it into "reachable" or "not"
  // would dress a rule of thumb up as a fact. The reader makes that call.
  difficultyGap: Schema.NullOr(Schema.Number),
  costPerClick: Schema.NullOr(Schema.Number),
  // The intent DataForSEO observed, which may disagree with the plan's.
  reportedIntent: Schema.NullOr(Schema.String),
  // The calendar month, 1-12, the keyword's demand peaks in — the one number
  // in this report that is a publishing date rather than a metric. Null when
  // the stored series holds fewer than two complete calendar years, because
  // one observation of a month is not an average.
  peakMonth: Schema.NullOr(Schema.Number),
  // How pronounced that peak is: the peak month's seasonal index, where 1.0 is
  // a month that carries exactly its even share of the year. 1.4 means the
  // peak month runs 40% above an average month.
  //
  // Reported beside `peakMonth` rather than folded into it, so a caller can
  // decide what counts as seasonal. Every term has a highest month; only some
  // of them have a season, and the difference is this number.
  seasonality: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "KeywordHealth" })
export interface KeywordHealth extends Schema.Schema.Type<typeof KeywordHealth> {}

// The Registry judged on demand: how much of the plan aims at searches that
// exist, and which rows do not.
export const RegistryHealthReport = Schema.Struct({
  // The Market every number below describes. Absent for a site with none.
  market: Schema.optional(MarketReport),
  // The site's Ahrefs Domain Rating, for reading `difficultyGap` against. Null
  // when no rating is stored.
  domainRating: Schema.NullOr(Schema.Number),
  totals: Schema.Struct({
    keywords: Schema.Number,
    // The five verdicts sum to `keywords`, so a reader can see that every
    // planned Keyword is accounted for.
    brand: Schema.Number,
    unmeasured: Schema.Number,
    unreported: Schema.Number,
    noDemand: Schema.Number,
    hasDemand: Schema.Number,
    // Monthly searches summed over the keywords that have demand — the size of
    // the plan's addressable market, as far as it has been measured. Not a
    // traffic forecast: it is every search, not the share a first-page ranking
    // would win.
    monthlyVolume: Schema.Number,
  }),
  // Keywords with demand first, strongest first, then everything the reader has
  // to decide about: measured-and-empty rows before unmeasured ones.
  keywords: Schema.Array(KeywordHealth),
}).annotate({ identifier: "RegistryHealthReport" })
export interface RegistryHealthReport
  extends Schema.Schema.Type<typeof RegistryHealthReport> {}

// Keyword Proposals waiting on a decision. Its own report rather than a field on
// RegistryHealthReport, because the two answer opposite questions: that one
// judges the plan the Site has, and this one offers keywords it does not.
export const KeywordProposalsReport = Schema.Struct({
  // The Market these were found in. Absent for a Site with none, which is also
  // a Site that can hold no proposals.
  market: Schema.optional(MarketReport),
  totals: Schema.Struct({
    proposals: Schema.Number,
    // Monthly searches summed over every proposal, which is the demand on offer
    // — the counterpart of RegistryHealthReport's `monthlyVolume` for the plan
    // the Site does not have yet.
    monthlyVolume: Schema.Number,
  }),
  proposals: Schema.Array(KeywordProposal),
}).annotate({ identifier: "KeywordProposalsReport" })
export interface KeywordProposalsReport
  extends Schema.Schema.Type<typeof KeywordProposalsReport> {}

export const KeywordDismissResult = Schema.Struct({
  // Rows that changed, not keywords named: a keyword already dismissed, or never
  // proposed, changes nothing.
  dismissed: Schema.Number,
}).annotate({ identifier: "KeywordDismissResult" })
export interface KeywordDismissResult
  extends Schema.Schema.Type<typeof KeywordDismissResult> {}

export const RegistryListReport = Schema.Struct({
  targets: Schema.Array(
    Schema.Struct({
      targetUrl: Schema.String,
      phase: Schema.String,
      state: ProgressState,
      indexed: IndexStatus,
      coverageState: Schema.NullOr(Schema.String),
      inspectedAt: Schema.NullOr(Schema.String),
      priority: Schema.NullOr(Schema.String),
      intent: Schema.String,
      publishedAt: Schema.NullOr(Schema.String),
      baselineDate: Schema.NullOr(Schema.String),
      status: Schema.String,
      whyOpportunity: Schema.NullOr(Schema.String),
      measuredFrom: Schema.NullOr(Schema.String),
      window: TidyMetrics,
      baseline: Schema.NullOr(TidyMetrics),
      // Pageviews and visits from the analytics provider over the same 28 days
      // as `window`, so a target's clicks and visits describe the same days.
      // Null when the site has no provider or nothing is synced yet; optional
      // key so an older server's answer still decodes.
      visits: Schema.optional(Schema.NullOr(VisitsWindowReport)),
      keywords: Schema.Array(
        Schema.Struct({
          keyword: Schema.String,
          cluster: Schema.String,
          intent: Schema.String,
          // What the vendor says about this planned Keyword. This is what
          // turns the Registry from a list of intentions into a checkable
          // plan: a keyword with no demand behind it is a page nobody will
          // find, whatever its priority says.
          demand: Schema.optional(DemandReport),
        }),
      ),
    }),
  ),
  // The Market every `demand` block above describes. Optional so an older
  // server's answer still decodes.
  market: Schema.optional(MarketReport),
}).annotate({ identifier: "RegistryListReport" })
export interface RegistryListReport
  extends Schema.Schema.Type<typeof RegistryListReport> {}

export const RegistryAddResult = Schema.Struct({
  added: EntrySummary,
  targetUrl: Schema.String,
}).annotate({ identifier: "RegistryAddResult" })
export interface RegistryAddResult
  extends Schema.Schema.Type<typeof RegistryAddResult> {}

export const RegistrySetResult = Schema.Struct({
  targetUrl: Schema.String,
  keyword: Schema.NullOr(Schema.String),
  updatedRows: Schema.Number,
  patch: RegistryPatch,
}).annotate({ identifier: "RegistrySetResult" })
export interface RegistrySetResult
  extends Schema.Schema.Type<typeof RegistrySetResult> {}

export const LogAddResult = Schema.Struct({
  logged: LogEntry,
}).annotate({ identifier: "LogAddResult" })
export interface LogAddResult
  extends Schema.Schema.Type<typeof LogAddResult> {}

export const LogListResult = Schema.Struct({
  actions: Schema.Array(LogEntry),
}).annotate({ identifier: "LogListResult" })
export interface LogListResult
  extends Schema.Schema.Type<typeof LogListResult> {}

export const HistoryReport = Schema.Struct({
  days: Schema.Array(
    Schema.Struct({
      date: Schema.String,
      // True daily total from site_daily. `provisional` marks a day Google is
      // still revising (within the finalization window), for UI dimming.
      provisional: Schema.Boolean,
      impressions: Schema.Number,
      clicks: Schema.Number,
      ctr: Schema.Number,
      position: Schema.Number,
      // The same day's site visits from the analytics provider, or null when
      // the site has none or that day is not synced yet.
      visits: Schema.optional(Schema.NullOr(VisitsDayReport)),
    }),
  ),
}).annotate({ identifier: "HistoryReport" })
export interface HistoryReport
  extends Schema.Schema.Type<typeof HistoryReport> {}

// The site's custom events over a window against the window before it,
// strongest first, from the analytics provider. Anchored on the Search Console
// latest date like every other window, so an event count and a clicks count
// over the same period describe the same days. `events` is empty, not null,
// when the site has no provider or nothing is synced yet: it is a list, and an
// empty list already says "nothing to show".
export const EventsReport = Schema.Struct({
  analytics: Schema.NullOr(AnalyticsStatus),
  windowDays: Schema.Number,
  window: Schema.Struct({
    currentStart: Schema.NullOr(Schema.String),
    currentEnd: Schema.NullOr(Schema.String),
    previousStart: Schema.NullOr(Schema.String),
    previousEnd: Schema.NullOr(Schema.String),
  }),
  events: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      current: Schema.Number,
      previous: Schema.Number,
      delta: Schema.Number,
    }),
  ),
}).annotate({ identifier: "EventsReport" })
export interface EventsReport extends Schema.Schema.Type<typeof EventsReport> {}

// Orders and takings over a window, summed. Amounts in the currency's minor
// unit, as the rows are; `net` is the provider's own net (after refunds and
// its fees), so it compares within one provider only.
export const RevenueTotals = Schema.Struct({
  orders: Schema.Number,
  revenue: Schema.Number,
  net: Schema.Number,
}).annotate({ identifier: "RevenueTotals" })
export interface RevenueTotals extends Schema.Schema.Type<typeof RevenueTotals> {}

// The site's sales over a window against the window before it, from its
// commerce provider, served from the ledger. Anchored like the events report on
// the newest finished day (yesterday once today has synced), so the freshest
// whole days are in it and today's partial day is not. `days` is the current
// window's synced days, oldest first — a chart's bars; a day never synced is
// absent, a day without sales is a zero row. `revenue` (the status) is null
// when the site has no commerce provider; then `days` is empty and every total
// zero. `currency` is null until a row exists.
export const RevenueReport = Schema.Struct({
  revenue: Schema.NullOr(RevenueStatus),
  windowDays: Schema.Number,
  window: Schema.Struct({
    currentStart: Schema.NullOr(Schema.String),
    currentEnd: Schema.NullOr(Schema.String),
    previousStart: Schema.NullOr(Schema.String),
    previousEnd: Schema.NullOr(Schema.String),
  }),
  currency: Schema.NullOr(Schema.String),
  days: Schema.Array(RevenueDay),
  current: RevenueTotals,
  previous: RevenueTotals,
  delta: RevenueTotals,
}).annotate({ identifier: "RevenueReport" })
export interface RevenueReport extends Schema.Schema.Type<typeof RevenueReport> {}

// The people on the site right now. The ONE report that reaches the provider
// on a read (cached 30 seconds in the Analytics service), which is why it is
// its own document with its own endpoint and never rides on the dashboard
// snapshot: a slow vendor must not stall a screen whose other numbers are on
// disk. `live` is null when the site has no provider; `analytics` says why
// when a provider is configured but not ready.
export const LiveReport = Schema.Struct({
  analytics: Schema.NullOr(AnalyticsStatus),
  live: Schema.NullOr(LiveVisitors),
}).annotate({ identifier: "LiveReport" })
export interface LiveReport extends Schema.Schema.Type<typeof LiveReport> {}

// The live feed: what visitors did in the last 30 minutes, the other read
// that reaches the provider (memoised a few seconds). `events` is null when the
// site has no provider; `analytics` says why when a provider is configured but
// not ready.
export const LiveEventsReport = Schema.Struct({
  analytics: Schema.NullOr(AnalyticsStatus),
  events: Schema.NullOr(LiveEvents),
}).annotate({ identifier: "LiveEventsReport" })
export interface LiveEventsReport
  extends Schema.Schema.Type<typeof LiveEventsReport> {}

// Today so far, the other report that reaches the provider (cached a minute).
// `today` is null when the site has no provider; `analytics` says why when a
// provider is configured but not ready.
export const TodayReport = Schema.Struct({
  analytics: Schema.NullOr(AnalyticsStatus),
  today: Schema.NullOr(TodayVisits),
}).annotate({ identifier: "TodayReport" })
export interface TodayReport extends Schema.Schema.Type<typeof TodayReport> {}

// Raised when a report cannot be produced (wraps an underlying Storage /
// Registry / Sitemap failure, or an invalid argument such as a bad path/kind).
export class ReportsError extends Schema.TaggedErrorClass<ReportsError>()(
  "ReportsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export * as ReportsSchema from "./schema"

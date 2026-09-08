// Frozen data shapes and errors for the Analytics domain — the boundary to a
// site's web-analytics provider (Rybbit, Umami, GA4, …).
//
// Everything here is the CANONICAL form. It is the intersection of what those
// products can all answer, not the union of what any one of them offers: visits
// and pageviews per page per day, site totals per day, and the count of each
// named event per day. Bounce rate and time on page are left out on purpose —
// every vendor defines them differently, so they would not survive a switch of
// provider. Nothing vendor-specific may appear in this file; an adapter reads a
// vendor's wire format and produces these rows, and the rest of the domain
// (Storage, Sync, Reports) never learns which vendor it was.
import { Schema } from "effect"

// The `analytics` block of a site's config entry. `provider` names the adapter
// (the registry in providers.ts decides which names this build can serve),
// `siteId` is the vendor's own identifier for the site — a Rybbit site number,
// an Umami website UUID, a GA4 property id. `baseUrl` points a self-hosted
// instance; the adapter supplies the vendor's cloud origin when it is absent.
export const ConfigAnalytics = Schema.Struct({
  provider: Schema.String,
  siteId: Schema.String,
  baseUrl: Schema.optional(Schema.String),
  // IANA zone the vendor is asked to bucket days in. Search Console reports its
  // days in Pacific time, so the two ledgers can never share a midnight exactly;
  // one zone per site, fixed here, keeps the offset constant at least.
  timeZone: Schema.optional(Schema.String),
}).annotate({ identifier: "ConfigAnalytics" })
export interface ConfigAnalytics
  extends Schema.Schema.Type<typeof ConfigAnalytics> {}

export const defaultTimeZone = "UTC"

// A site's resolved analytics source: ConfigAnalytics with its defaults filled
// (see Sites.normalize). What an adapter is built from.
export const AnalyticsSource = Schema.Struct({
  provider: Schema.String,
  siteId: Schema.String,
  baseUrl: Schema.NullOr(Schema.String),
  timeZone: Schema.String,
}).annotate({ identifier: "AnalyticsSource" })
export interface AnalyticsSource
  extends Schema.Schema.Type<typeof AnalyticsSource> {}

// Site-wide visit counts for one day. `visitors` is the vendor's distinct-person
// count for that day; it does not sum across days.
export const SiteVisitsDay = Schema.Struct({
  date: Schema.String,
  pageviews: Schema.Number,
  visits: Schema.Number,
  visitors: Schema.Number,
}).annotate({ identifier: "SiteVisitsDay" })
export interface SiteVisitsDay
  extends Schema.Schema.Type<typeof SiteVisitsDay> {}

// Visit counts for one page on one day. `page` is a PATH ("/pricing"), not a
// full URL: analytics vendors report paths, and the registry keys targets by
// path. Search Console rows carry full URLs; Reports bridges the two.
export const PageVisitsDay = Schema.Struct({
  date: Schema.String,
  page: Schema.String,
  pageviews: Schema.Number,
  visits: Schema.Number,
}).annotate({ identifier: "PageVisitsDay" })
export interface PageVisitsDay
  extends Schema.Schema.Type<typeof PageVisitsDay> {}

// How many times one named custom event fired on one day, site-wide.
export const EventCountDay = Schema.Struct({
  date: Schema.String,
  name: Schema.String,
  count: Schema.Number,
}).annotate({ identifier: "EventCountDay" })
export interface EventCountDay
  extends Schema.Schema.Type<typeof EventCountDay> {}

// One fetch's worth of canonical rows, all three series together, because a
// provider answers for a set of dates and Storage records those dates as fetched
// in one transaction.
export const VisitsDays = Schema.Struct({
  site: Schema.Array(SiteVisitsDay),
  pages: Schema.Array(PageVisitsDay),
  events: Schema.Array(EventCountDay),
}).annotate({ identifier: "VisitsDays" })
export interface VisitsDays extends Schema.Schema.Type<typeof VisitsDays> {}

export const emptyVisitsDays: VisitsDays = { site: [], pages: [], events: [] }

// What a report says about a site's analytics: which provider is configured,
// and whether this deployment can actually read it. `ready` is false when the
// provider name has no adapter in this build, or its adapter could not be set up
// (typically a missing API key); `reason` says which. A site with no analytics
// has no status at all — callers get null, not a status with an empty provider.
export const AnalyticsStatus = Schema.Struct({
  provider: Schema.String,
  siteId: Schema.String,
  ready: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
}).annotate({ identifier: "AnalyticsStatus" })
export interface AnalyticsStatus
  extends Schema.Schema.Type<typeof AnalyticsStatus> {}

// The people active on the site right now, as the provider counts them: one
// distinct visitor per person seen in the last `windowMinutes`, plus how many
// were seen in each of those minutes, plus the tighter "online" count. This is
// the one number in the domain that is NOT a ledger row — it is fetched on
// demand, briefly cached, and never stored, because it is stale the moment it
// lands.
export const liveWindowMinutes = 30
// "Online" is the last five minutes: what Rybbit and Umami both call online,
// and the shorter of GA4's two realtime windows. Long enough that a reader
// between two pages still counts, short enough to mean "right now".
export const onlineWindowMinutes = 5

export const LiveVisitors = Schema.Struct({
  visitors: Schema.Number,
  windowMinutes: Schema.Number,
  // Distinct people seen in the last `onlineWindowMinutes`: the ones on the
  // site right now, as opposed to `visitors`, which is the whole window.
  online: Schema.Number,
  onlineWindowMinutes: Schema.Number,
  // One count per minute of the window, oldest first, exactly `windowMinutes`
  // long with zeros for quiet minutes — the bars of a realtime card. Positions,
  // not timestamps: the last entry is the minute that just ended, and a client
  // derives the rest from `fetchedAt`. Optional on the wire so a client built
  // against this shape still decodes an older server's answer.
  series: Schema.optional(Schema.Array(Schema.Number)),
  // When the provider was asked, as an ISO 8601 instant, so a client can show
  // how old a cached answer is.
  fetchedAt: Schema.String,
}).annotate({ identifier: "LiveVisitors" })
export interface LiveVisitors
  extends Schema.Schema.Type<typeof LiveVisitors> {}

// One thing a visitor just did, as the provider recorded it: a page they
// loaded, or a named action they took. The rows of a live feed. Like
// LiveVisitors this is fetched on demand, briefly cached and never stored; the
// stored form of the same activity is the per-day counts above.
//
// The kinds are the intersection of what providers record as discrete events.
// `pageview` and `event` (a custom, named action) every vendor has; the rest are
// Rybbit's auto-captured interactions, which Umami and GA4 report under other
// names or not at all, so a client must treat an unknown kind as just "event".
export const liveEventKinds = [
  "pageview",
  "event",
  "outbound",
  "button_click",
  "copy",
  "form_submit",
  "input_change",
] as const
export type LiveEventKind = (typeof liveEventKinds)[number]

export const LiveEvent = Schema.Struct({
  // Stable within the window: the same row from two polls has the same id, so
  // a client can tell a new row from one it has drawn. Derived by the adapter
  // from the row's own fields, since vendors do not number events.
  id: Schema.String,
  // When it happened, as an ISO 8601 instant.
  at: Schema.String,
  kind: Schema.Literals(liveEventKinds),
  // The event's name for a custom event; null for a pageview. Auto-captured
  // kinds carry what the vendor names them by (the link's host, the button's
  // text) or null.
  name: Schema.NullOr(Schema.String),
  // The page it happened on: a PATH ("/pricing"), as PageVisitsDay.page is.
  page: Schema.String,
  // The event's properties, flattened to strings: what a client shows as the
  // row's data. Empty for a plain pageview.
  properties: Schema.Record(Schema.String, Schema.String),
  // An opaque token that is the same for every row of one person, so a client
  // can group or highlight a visitor's path. Never shown as such, and never a
  // name: the provider's anonymous visitor id.
  visitor: Schema.String,
  // Where and on what, as the provider records them; null when it does not
  // know. `country` is an ISO 3166-1 alpha-2 code.
  country: Schema.NullOr(Schema.String),
  browser: Schema.NullOr(Schema.String),
  operatingSystem: Schema.NullOr(Schema.String),
  // "desktop", "mobile" or "tablet" in the vendors' shared vocabulary; null
  // when unknown.
  device: Schema.NullOr(Schema.String),
  // The full referrer the visit came from, or null.
  referrer: Schema.NullOr(Schema.String),
}).annotate({ identifier: "LiveEvent" })
export interface LiveEvent extends Schema.Schema.Type<typeof LiveEvent> {}

// The live feed: every LiveEvent of the last `windowMinutes`, newest first,
// capped at `liveEventsLimit`. `since` echoes the client's cut-off when it gave
// one, so the rows are only those newer than it.
export const liveEventsLimit = 500

export const LiveEvents = Schema.Struct({
  windowMinutes: Schema.Number,
  since: Schema.NullOr(Schema.String),
  events: Schema.Array(LiveEvent),
  // When the provider was asked, as an ISO 8601 instant.
  fetchedAt: Schema.String,
}).annotate({ identifier: "LiveEvents" })
export interface LiveEvents extends Schema.Schema.Type<typeof LiveEvents> {}

// One hour of one day's site visits, in the site's zone. `hour` is 0–23.
export const SiteVisitsHour = Schema.Struct({
  hour: Schema.Number,
  pageviews: Schema.Number,
  visits: Schema.Number,
  visitors: Schema.Number,
}).annotate({ identifier: "SiteVisitsHour" })
export interface SiteVisitsHour
  extends Schema.Schema.Type<typeof SiteVisitsHour> {}

// Today so far, in the site's zone, read from the ledger like every other
// day. Search Console lags days and a day in progress changes by the minute,
// so the sync re-fetches today's rows from the provider every few minutes and
// writes them into the same daily tables (plus an hourly one); tomorrow the
// daily sync fetches the finished day once more. Reports never reach the
// provider for this: the provider is a data source, the ledger is the truth.
export const TodayVisits = Schema.Struct({
  // The provider's calendar day, YYYY-MM-DD in `timeZone`.
  date: Schema.String,
  timeZone: Schema.String,
  // How many hours of the day have begun (1–24): the bars a client draws.
  hoursElapsed: Schema.Number,
  // The day's totals so far, or null when the provider has no row for it yet.
  site: Schema.NullOr(SiteVisitsDay),
  // Exactly 24 entries, hour 0 first, zeros for hours still to come.
  hours: Schema.Array(SiteVisitsHour),
  pages: Schema.Array(PageVisitsDay),
  events: Schema.Array(EventCountDay),
  // When the sync last wrote today's rows, as an ISO 8601 instant; null when
  // it has not yet, in which case everything above is zero.
  syncedAt: Schema.NullOr(Schema.String),
}).annotate({ identifier: "TodayVisits" })
export interface TodayVisits
  extends Schema.Schema.Type<typeof TodayVisits> {}

// Raised when a provider cannot be used or a fetch fails. One class for the
// whole boundary: an adapter maps its vendor's auth, transport, and decode
// failures into this, with `message` saying which, so no vendor error type
// ever crosses into Sync.
export class AnalyticsError extends Schema.TaggedErrorClass<AnalyticsError>()(
  "AnalyticsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export * as AnalyticsSchema from "./schema"

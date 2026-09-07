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

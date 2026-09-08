// Frozen data shapes and errors for the Revenue domain — the boundary to a
// site's commerce provider (Polar, Stripe, Lemon Squeezy, …).
//
// Everything here is the CANONICAL form, the intersection of what those
// products can all answer: how many orders a site took on a day and what they
// were worth. Nothing vendor-specific may appear in this file; an adapter reads
// a vendor's wire format and produces these rows, and the rest of the domain
// (Storage, Sync, Reports) never learns which vendor it was — the same shape
// the analytics port takes (see ../analytics/schema.ts and ADR 0005).
import { Schema } from "effect"

// The `revenue` block of a site's config entry. `provider` names the adapter
// (the registry in providers.ts decides which names this build can serve).
// `accountId` is the vendor's own identifier for the seller — a Polar
// organisation id, a Stripe account — and is optional because a vendor token
// is often already scoped to one account. `keyVariable` names the environment
// variable the adapter reads its key from; it defaults to `<PROVIDER>_API_KEY`
// and exists because commerce keys are per account, so two sites on the same
// vendor need two variables. `baseUrl` points a sandbox or self-hosted instance.
export const ConfigRevenue = Schema.Struct({
  provider: Schema.String,
  accountId: Schema.optional(Schema.String),
  keyVariable: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  // IANA zone the vendor is asked to bucket days in. Defaults to the site's
  // analytics zone when it has one, so an order and the visit that placed it
  // fall on the same day.
  timeZone: Schema.optional(Schema.String),
}).annotate({ identifier: "ConfigRevenue" })
export interface ConfigRevenue extends Schema.Schema.Type<typeof ConfigRevenue> {}

// The environment variable an adapter reads when the config names none.
export const defaultKeyVariable = (provider: string) =>
  `${provider.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_API_KEY`

// A site's resolved revenue source: ConfigRevenue with its defaults filled
// (see Sites.normalize). What an adapter is built from.
export const RevenueSource = Schema.Struct({
  provider: Schema.String,
  accountId: Schema.NullOr(Schema.String),
  keyVariable: Schema.String,
  baseUrl: Schema.NullOr(Schema.String),
  timeZone: Schema.String,
}).annotate({ identifier: "RevenueSource" })
export interface RevenueSource extends Schema.Schema.Type<typeof RevenueSource> {}

// One day of a site's sales. Amounts are in the currency's MINOR unit (cents
// for USD and EUR), as every vendor reports them, so they add without rounding;
// a client divides by 100 to show them. `revenue` is what customers paid, the
// figure that compares across providers. `net` is what the provider calls net:
// revenue less refunds and less its own fees (Polar's net_revenue is after
// Polar's cut). Vendors define that differently, so net compares within one
// provider only; the headline is revenue. `currency` is an ISO 4217 code, one
// per row; a vendor that settles everything in one currency writes the same
// code on every row.
export const RevenueDay = Schema.Struct({
  date: Schema.String,
  orders: Schema.Number,
  revenue: Schema.Number,
  net: Schema.Number,
  currency: Schema.String,
}).annotate({ identifier: "RevenueDay" })
export interface RevenueDay extends Schema.Schema.Type<typeof RevenueDay> {}

// What a report says about a site's revenue source: which provider is
// configured, and whether this deployment can read it. `ready` is false when
// the provider name has no adapter in this build, or its adapter could not be
// set up (typically a missing key); `reason` says which. A site with no
// revenue block has no status at all — callers get null.
export const RevenueStatus = Schema.Struct({
  provider: Schema.String,
  accountId: Schema.NullOr(Schema.String),
  ready: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
}).annotate({ identifier: "RevenueStatus" })
export interface RevenueStatus extends Schema.Schema.Type<typeof RevenueStatus> {}

// Raised when a provider cannot be used or a fetch fails. One class for the
// whole boundary, so no vendor error type ever crosses into Sync.
export class RevenueError extends Schema.TaggedErrorClass<RevenueError>()(
  "RevenueError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export * as RevenueSchema from "./schema"

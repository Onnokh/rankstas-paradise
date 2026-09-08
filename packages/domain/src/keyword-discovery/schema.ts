// Keyword discovery — the shapes on the wire and in the store.
//
// A Proposal is a keyword nothing in this Site has yet: found by expanding a
// seed at DataForSEO, kept because it passed every filter, and waiting for a
// person to accept it into the Registry or dismiss it.
import { Schema } from "effect"

// Which DataForSEO expansion produced a Proposal. Recorded because the three
// answer different questions and a reader judges a row partly by which one
// found it: a `suggestions` row contains the seed, a `related` row need not,
// and a `google-ads` row carries no difficulty and no intent at all.
export const discoverySources = ["suggestions", "related", "google-ads"] as const
export type DiscoverySource = (typeof discoverySources)[number]
export const DiscoverySource = Schema.Literals(discoverySources)

// What a Proposal can be. There is no `accepted`: accepting a Proposal means
// adding a Registry row, and a keyword the Registry holds is no longer proposed
// — so acceptance is read off the Registry rather than written here. That keeps
// a keyword added by hand indistinguishable from one accepted from this list,
// which is the honest reading: both are in the plan.
export const proposalStatuses = ["proposed", "dismissed"] as const
export type ProposalStatus = (typeof proposalStatuses)[number]
export const ProposalStatus = Schema.Literals(proposalStatuses)

// One proposed Keyword, with the vendor's numbers as they read at the moment it
// was proposed. Frozen on purpose: KeywordMetrics re-asks after thirty days and
// overwrites, and a Proposal is a record of why this keyword looked worth the
// work then. A reader comparing a stale Proposal against a current metric is
// seeing something true, not a bug.
export const KeywordProposal = Schema.Struct({
  keyword: Schema.String,
  // The Keyword the expansion was asked about. Kept so a run can be undone as
  // a group and so a reader can see which of their terms opened which door.
  seed: Schema.String,
  source: DiscoverySource,
  locationCode: Schema.Number,
  languageCode: Schema.String,
  searchVolume: Schema.NullOr(Schema.Number),
  difficulty: Schema.NullOr(Schema.Number),
  costPerClick: Schema.NullOr(Schema.Number),
  competition: Schema.NullOr(Schema.Number),
  intent: Schema.NullOr(Schema.String),
  status: ProposalStatus,
  discoveredAt: Schema.String,
}).annotate({ identifier: "KeywordProposal" })
export interface KeywordProposal extends Schema.Schema.Type<typeof KeywordProposal> {}

// What a caller asks for. Everything but the seed is optional, and the two
// optional filters are absent by default on purpose:
//
//   - `maxDifficulty` is not defaulted from the Site's Domain Rating, tempting
//     as that is. A default ceiling would silently decide what "within reach"
//     means and hide every row above it, and the caller could not see the rule
//     it inherited. The difficulty is reported on every Proposal instead, and
//     the Planning screen bands it with a slider the reader can move.
//   - `intents` is absent because a Market served by Google Ads reports no
//     intent at all, so an intent filter there would drop everything.
//
// `minVolume` *is* defaulted, because it is not a rule of thumb: a keyword the
// vendor reports no searches for is not evidence of demand, and proposing it
// costs the reader attention.
export const DiscoveryRequest = Schema.Struct({
  seed: Schema.String,
  source: Schema.optional(Schema.Literals(["suggestions", "related"] as const)),
  limit: Schema.optional(Schema.Number),
  minVolume: Schema.optional(Schema.Number),
  maxDifficulty: Schema.optional(Schema.Number),
  intents: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "DiscoveryRequest" })
export interface DiscoveryRequest extends Schema.Schema.Type<typeof DiscoveryRequest> {}

// What one discovery run did. Every count is reported, because the interesting
// answer to "why did I get four rows" is usually one of the drops: `returned`
// is what was paid for, and the difference between it and `proposed` is what
// the filters removed and why.
export const DiscoveryResult = Schema.Struct({
  seed: Schema.String,
  source: DiscoverySource,
  // Rows DataForSEO answered with, which is what a Labs expansion bills for.
  // The seed's own row is not among them: the expansions are asked not to send
  // it, and one sent anyway is dropped on the wire rather than counted here.
  returned: Schema.Number,
  droppedKnown: Schema.Number,
  droppedBrandOrOperator: Schema.Number,
  droppedBelowVolume: Schema.Number,
  droppedAboveDifficulty: Schema.Number,
  droppedByIntent: Schema.Number,
  proposals: Schema.Array(KeywordProposal),
}).annotate({ identifier: "DiscoveryResult" })
export interface DiscoveryResult extends Schema.Schema.Type<typeof DiscoveryResult> {}

export class KeywordDiscoveryError extends Schema.TaggedErrorClass<KeywordDiscoveryError>()(
  "KeywordDiscoveryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export * as KeywordDiscoverySchema from "./schema"

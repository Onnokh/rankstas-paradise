// Keyword discovery — the shapes on the wire and in the store.
//
// A Proposal is a keyword nothing in this Site has yet: found by expanding a
// seed at DataForSEO, kept because it passed every filter *and* because a
// caller judged it to be about this Site's subject, and waiting for a person to
// accept it into the Registry or dismiss it.
//
// The two halves of that are two shapes and two calls, because they are two
// different judges. The filters are numeric and structural and live here; the
// relevance is not knowable here at all, and belongs to whoever asked for the
// run. So `discover` answers with DiscoveredKeywords and stores nothing, and
// `propose` turns the ones the caller kept into KeywordProposals.
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

// What the vendor said about one keyword an Expansion found. The numbers, and
// nothing about whether anybody wants the keyword: no Market, no status, no
// instant. Its own shape because it is what a caller hands back to
// `KeywordDiscovery.propose` — the rows of a run, unchanged, minus the ones the
// caller judged to be about something else. Naming only the numbers is what
// makes that safe: the caller cannot store a row into a Market the Site is not
// measured in, and cannot resurrect a keyword already dismissed, because
// neither is its to say.
export const ProposalInput = Schema.Struct({
  keyword: Schema.String,
  // The Keyword the expansion was asked about. Kept so a run can be undone as
  // a group and so a reader can see which of their terms opened which door.
  seed: Schema.String,
  source: DiscoverySource,
  searchVolume: Schema.NullOr(Schema.Number),
  difficulty: Schema.NullOr(Schema.Number),
  costPerClick: Schema.NullOr(Schema.Number),
  competition: Schema.NullOr(Schema.Number),
  intent: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ProposalInput" })
export interface ProposalInput extends Schema.Schema.Type<typeof ProposalInput> {}

// One keyword a discovery run offers, in the Market it was found in. Not yet a
// Proposal, and this is the distinction the whole feature turns on: every
// filter a run applies is numeric or structural, and none of them can tell
// whether a keyword is about this Site's subject at all. `big hero animation`
// reports 201,000 searches a month and passes every filter there is; it is
// about a Disney film. So a run answers with these, the caller judges them, and
// only what it judged relevant is stored.
export const DiscoveredKeyword = Schema.Struct({
  ...ProposalInput.fields,
  locationCode: Schema.Number,
  languageCode: Schema.String,
}).annotate({ identifier: "DiscoveredKeyword" })
export interface DiscoveredKeyword extends Schema.Schema.Type<typeof DiscoveredKeyword> {}

// One proposed Keyword, with the vendor's numbers as they read at the moment it
// was proposed. Frozen on purpose: KeywordMetrics re-asks after thirty days and
// overwrites, and a Proposal is a record of why this keyword looked worth the
// work then. A reader comparing a stale Proposal against a current metric is
// seeing something true, not a bug.
//
// A DiscoveredKeyword plus the two things storing it adds: the decision it is
// waiting on, and when it became one.
export const KeywordProposal = Schema.Struct({
  ...DiscoveredKeyword.fields,
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
// is what was paid for, and the difference between it and `keywords` is what
// the filters removed and why. The counts and the kept rows add up to
// `returned` exactly, which is the property that makes them worth reading — a
// count that did not account for a charged row would only advertise a filter.
//
// `keywords`, not `proposals`: a run stores nothing. The rows are an offer to
// the caller, and become Proposals only through `propose`.
export const DiscoveryResult = Schema.Struct({
  seed: Schema.String,
  source: DiscoverySource,
  // Rows DataForSEO answered with, which is what a Labs expansion bills for.
  // The seed's own row is not among them: the expansions are asked not to send
  // it, and one sent anyway is dropped on the wire rather than counted here.
  returned: Schema.Number,
  // Rows that could not be offered at all: the same keyword answered twice
  // across the branches of a related walk, or a row with no keyword. Counted
  // rather than skipped in silence, because a charged row that appears in none
  // of these numbers makes every other number unreadable.
  droppedUnusable: Schema.Number,
  droppedKnown: Schema.Number,
  droppedBrandOrOperator: Schema.Number,
  droppedBelowVolume: Schema.Number,
  droppedAboveDifficulty: Schema.Number,
  droppedByIntent: Schema.Number,
  keywords: Schema.Array(DiscoveredKeyword),
}).annotate({ identifier: "DiscoveryResult" })
export interface DiscoveryResult extends Schema.Schema.Type<typeof DiscoveryResult> {}

// What one `propose` call stored, and what it would not. The counts add up the
// same way a run's do: `named` is what the caller handed over, and every row
// that did not become a Proposal is charged to one reason. Nothing here is a
// relevance judgement — that already happened, in the caller — so the only
// skips are the ones the caller could not have known about.
export const ProposalStoreResult = Schema.Struct({
  named: Schema.Number,
  stored: Schema.Number,
  // Already in the Registry, already proposed, or already dismissed. The last
  // is the one that matters: a dismissal has to outlive a caller who proposes
  // the same keyword again.
  skippedKnown: Schema.Number,
  skippedBrandOrOperator: Schema.Number,
  // Named twice in one call. Counted rather than ignored, so `named` stays the
  // number of rows the caller sent.
  skippedDuplicate: Schema.Number,
}).annotate({ identifier: "ProposalStoreResult" })
export interface ProposalStoreResult
  extends Schema.Schema.Type<typeof ProposalStoreResult> {}

export class KeywordDiscoveryError extends Schema.TaggedErrorClass<KeywordDiscoveryError>()(
  "KeywordDiscoveryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export * as KeywordDiscoverySchema from "./schema"

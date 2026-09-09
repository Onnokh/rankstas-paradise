import Foundation

/// The plan as the planning screen shows it: the server's keywords narrowed by what the
/// reader asked for, then ranked. A pure function of its inputs, so the screen holds no list
/// of its own and a refresh replaces the rows under the same order.
///
/// The order the server sends is already the useful one — demand first, strongest first —
/// so this narrows and re-ranks rather than deciding from scratch.
/// What the planning screen is looking at. Its own type because the screen got this wrong
/// once: with no report it described the plan anyway, and "the registry maps no keywords
/// yet" reads as a fact — one that was false about a registry holding forty-five rows.
///
/// The distinction that matters is between an EMPTY answer and NO answer. Only the first is
/// a statement about the plan.
enum PlanningState: Equatable {
    /// A report arrived. The list, the strip of figures and the counts all speak for themselves.
    case plan
    /// Nothing has arrived and nothing has failed: the first look at a cold site.
    case waiting
    /// Nothing arrived, and this is why. The screen must say so rather than count zeros —
    /// a 404 here means the server predates the report, which is a deploy and not
    /// something the reader can fix on this screen.
    case unavailable(String)
}

enum PlanningList {
    /// Which of the three the screen is in. `reason` is why the report is missing, when the
    /// store knows; a present report wins over it, because a held report is still worth
    /// reading after a refresh that failed.
    static func state(
        report: RegistryHealthReport?,
        reason: String?,
        loading: Bool
    ) -> PlanningState {
        if report != nil { return .plan }
        if let reason { return .unavailable(reason) }
        // Loading and cold read the same: both mean "not yet", and neither is entitled to
        // say anything about the plan.
        _ = loading
        return .waiting
    }

    /// - Parameters:
    ///   - verdicts: keeps only keywords the vendor said this about. Empty keeps every one.
    ///   - search: matched against the keyword, its cluster and its target, case-insensitively.
    ///   - reach: keeps only keywords whose difficulty is at or under this. Nil keeps every
    ///     one, including the ones with no difficulty at all.
    static func rows(
        _ keywords: [KeywordHealth],
        verdicts: Set<KeywordVerdict> = [],
        search: String = "",
        reach: Double? = nil
    ) -> [KeywordHealth] {
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        return keywords.filter { keyword in
            if !verdicts.isEmpty, !verdicts.contains(keyword.verdictKind) { return false }
            if let reach {
                // A keyword the vendor scored no difficulty for is not "within reach" —
                // it is unknown, and dropping it would hide it. Kept, and the screen shows
                // the blank.
                if let difficulty = keyword.difficulty, difficulty > reach { return false }
            }
            guard !needle.isEmpty else { return true }
            return keyword.keyword.lowercased().contains(needle)
                || keyword.cluster.lowercased().contains(needle)
                || keyword.targetUrl.lowercased().contains(needle)
        }
    }

    /// The difficulty to count as within reach when the reader has not said. Their own
    /// value wins; this is only the starting point.
    ///
    /// The site's domain rating, but never below `floor`. The rating alone is the obvious
    /// default and it is wrong at the bottom of the scale: a rating of 0 does not mean the
    /// site can only rank for keywords scored 0. Ahrefs difficulty is roughly how many
    /// referring domains the first page demands, and the low end of it is winnable with
    /// almost none — so a raw rating of 0 hides the entire long tail a new site can
    /// actually take, which is the only thing it can take.
    ///
    /// A rule of thumb, and it lives here rather than in the report on purpose: the screen
    /// shows the number beside a slider, so the reader can see the rule and move it. An API
    /// verdict cannot be argued with.
    static func defaultReach(domainRating: Double?, floor: Double = 10) -> Double {
        max(domainRating ?? floor, floor)
    }

    /// Proposals as the screen shows them: narrowed by the same search box as the plan.
    /// One box over both lists on purpose — the reader's question is about a subject, and
    /// asking it twice in two fields would be two questions.
    ///
    /// The seed is matched as well as the keyword, because the seed is how a reader finds
    /// the group a run just produced.
    ///
    /// Not narrowed by the reach slider, for the same reason the plan is not: a difficulty
    /// above the threshold is shown and coloured, never hidden. Hiding it would answer
    /// "what is within reach" with a list that cannot be checked against anything.
    static func proposals(
        _ proposals: [KeywordProposal],
        search: String = ""
    ) -> [KeywordProposal] {
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return proposals }
        return proposals.filter { proposal in
            proposal.keyword.lowercased().contains(needle)
                || proposal.seed.lowercased().contains(needle)
        }
    }

    /// The verdicts offered as chips over the list — not every case, because two of them
    /// cannot be acted on from here.
    ///
    /// `noDemand` needs the vendor to answer with a literal zero, and it does not: a term
    /// nobody searches for comes back with no volume at all, which is `unreported`. Across
    /// the four sites the store holds, every measured keyword is `has-demand`, `unreported`
    /// or `brand`, and not one is `no-demand` — so the chip was a filter that could only
    /// ever read 0. The verdict itself stays: the server can still produce it, and a row
    /// that ever is one says so in coral where it belongs, beside the keyword.
    ///
    /// `unmeasured` is not a verdict on a keyword at all — it says a DataForSEO key is
    /// missing or a sync has not run, which is our own setup. The Measured figure above the
    /// list is where that belongs, with its denominator beside it.
    static let verdictFilters: [KeywordVerdict] = [.hasDemand, .unreported, .brand]

    /// How much of the plan the vendor has actually answered for. The denominator of every
    /// claim the screen makes: a "1 of 3" is honest where a "1 of 29" would not be, because
    /// the other 26 were never asked about.
    static func measured(_ keywords: [KeywordHealth]) -> [KeywordHealth] {
        keywords.filter { $0.verdictKind != .unmeasured }
    }

    /// The keywords whose difficulty is at or under the site's domain rating.
    ///
    /// A rough guide across two vendors' unrelated scales, which is why the threshold is the
    /// reader's to move and lives on the screen rather than in the report. A keyword with no
    /// difficulty is not counted: unknown is not the same as within reach.
    static func withinReach(_ keywords: [KeywordHealth], reach: Double) -> [KeywordHealth] {
        keywords.filter { keyword in
            guard let difficulty = keyword.difficulty else { return false }
            return difficulty <= reach
        }
    }
}

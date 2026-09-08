import Foundation

/// The plan as the planning screen shows it: the server's keywords narrowed by what the
/// reader asked for, then ranked. A pure function of its inputs, so the screen holds no list
/// of its own and a refresh replaces the rows under the same order.
///
/// The order the server sends is already the useful one — demand first, strongest first —
/// so this narrows and re-ranks rather than deciding from scratch.
enum PlanningList {
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

    /// Keywords with a season worth planning around, soonest first from `month`.
    ///
    /// This is the planning part: a term that peaks every October needs its page to exist
    /// before then, so the useful order is not "biggest" but "next".
    static func upcoming(
        _ keywords: [KeywordHealth],
        from month: Int,
        seasonalAbove threshold: Double
    ) -> [KeywordHealth] {
        keywords
            .filter { keyword in
                guard let peak = keyword.peakMonth, let seasonality = keyword.seasonality
                else { return false }
                return (1...12).contains(peak) && seasonality >= threshold
            }
            .sorted { left, right in
                let a = monthsAhead(left.peakMonth!, from: month)
                let b = monthsAhead(right.peakMonth!, from: month)
                // Same month: the bigger term first.
                return a == b ? (left.searchVolume ?? 0) > (right.searchVolume ?? 0) : a < b
            }
    }

    /// How many months until `peak`, counting the current month as zero and wrapping the
    /// year. A peak that has just passed is eleven months away, not one behind.
    static func monthsAhead(_ peak: Int, from month: Int) -> Int {
        ((peak - month) % 12 + 12) % 12
    }
}

import Foundation

/// How the registry screen ranks its pages. Clicks, impressions and visits are the same
/// three the ranking cards offer; volume ranks the plan by what it aims at rather than by
/// what it has reached, which is the order to read a new plan in; path is the way to find
/// one page among many.
enum RegistrySort: String, CaseIterable, Identifiable, Sendable {
    case volume
    case impressions
    case clicks
    case visits
    case path

    var id: Self { self }

    var label: String {
        switch self {
        case .volume: "Volume"
        case .impressions: "Impressions"
        case .clicks: "Clicks"
        case .visits: "Visits"
        case .path: "Path"
        }
    }

    /// What the sort reads off a page. Nil for the path, which sorts by its own text.
    ///
    /// A page with no answer ranks as a zero, as one with no visits does. That is a ranking
    /// decision and not a reading of the number: the row still shows no volume rather than
    /// a 0, because nobody asked is not nobody searches.
    func value(of target: RegistryTarget) -> Double? {
        switch self {
        case .volume: target.demand?.monthlyVolume ?? 0
        case .impressions: target.window.impressions
        case .clicks: target.window.clicks
        case .visits: target.visits?.current.visits ?? 0
        case .path: nil
        }
    }
}

/// What the whole registry adds up to, as the strip over the list reads it.
///
/// The two shares are measured against different populations, on purpose. How much of the
/// registry aims at a keyword is a fact about every page it holds. How much of it Google
/// holds is a fact about the pages a keyword aims at only: an inventory-only page has
/// nothing planned to rank on it, so Google's verdict on it cannot block a plan — and a
/// site's `/login` and `/privacy` are pages Google is right never to index, which counted in
/// would hold the share down for ever and teach the reader to ignore it.
///
/// A share of nothing is nil rather than zero — a registry aiming at nothing is not a
/// registry that is 0% indexed, and the screen says the two differently.
struct RegistryTotals: Equatable, Sendable {
    /// The pages the registry holds.
    let pages: Int
    /// The pages carrying at least one keyword. The rest are inventory-only pages: tracked,
    /// with nothing planned to rank on them.
    let withKeywords: Int
    /// Keyword mappings across every page, counted once per row, not per distinct term.
    let keywords: Int
    /// Google's verdicts, counted over the keyword-carrying pages only.
    let indexed: Int
    let notIndexed: Int

    /// The keyword-carrying pages Google has said nothing usable about: never inspected, or
    /// inspected and answered "unknown". Not a zero and not a verdict.
    var unknown: Int { max(withKeywords - indexed - notIndexed, 0) }

    /// How much of the registry aims at a keyword at all, 0…1.
    var keywordShare: Double? {
        guard pages > 0 else { return nil }
        return Double(withKeywords) / Double(pages)
    }

    /// How much of the plan Google holds, 0…1. Measured over the keyword-carrying pages, so
    /// an inventory-only page cannot move it either way.
    var indexedShare: Double? {
        guard withKeywords > 0 else { return nil }
        return Double(indexed) / Double(withKeywords)
    }
}

/// The registry as the screen shows it: the server's targets narrowed by what the reader
/// asked for, then ranked. A pure function of its inputs, so the screen holds no list of
/// its own and a refresh replaces the rows under the same order.
enum RegistryList {
    /// - Parameters:
    ///   - search: matched against the path and the mapped keywords, case-insensitively.
    ///     Blank matches every page.
    ///   - unindexedOnly: keeps only the pages Google reports as not indexed. A page Google
    ///     has not spoken about is not one of them.
    static func rows(
        _ targets: [RegistryTarget],
        sort: RegistrySort,
        unindexedOnly: Bool = false,
        search: String = ""
    ) -> [RegistryTarget] {
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        let kept = targets.filter { target in
            if unindexedOnly, !target.isUnindexed { return false }
            guard !needle.isEmpty else { return true }
            if target.targetUrl.lowercased().contains(needle) { return true }
            return target.mappedKeywords.contains { $0.keyword.lowercased().contains(needle) }
        }

        guard sort != .path else {
            return kept.sorted { $0.targetUrl.localizedStandardCompare($1.targetUrl) == .orderedAscending }
        }
        // Strongest first, and the server's own order among equals, so a run of zeros keeps
        // the order the other clients show.
        return kept.enumerated()
            .sorted { left, right in
                let a = sort.value(of: left.element) ?? 0
                let b = sort.value(of: right.element) ?? 0
                return a == b ? left.offset < right.offset : a > b
            }
            .map(\.element)
    }

    /// Whether the server sent any keyword demand at all. Drives whether the screen names
    /// the market: a market label beside no numbers would be a promise the screen does not
    /// keep.
    static func hasDemand(_ targets: [RegistryTarget]) -> Bool {
        targets.contains { target in
            target.mappedKeywords.contains { $0.demand != nil }
        }
    }

    /// How many of the pages Google reports as not indexed.
    static func unindexedCount(_ targets: [RegistryTarget]) -> Int {
        targets.filter(\.isUnindexed).count
    }

    /// What the registry adds up to. Counted over every target the server sent, never over
    /// the filtered rows: the strip describes the plan, and a search that hides half of it
    /// does not change what the plan holds.
    ///
    /// The verdicts are counted over the keyword-carrying pages only — see `RegistryTotals`
    /// for why, and `unindexedCount` for the tally over every page, which is what the list
    /// below dims and what its filter keeps.
    static func totals(_ targets: [RegistryTarget]) -> RegistryTotals {
        let planned = targets.filter { !$0.mappedKeywords.isEmpty }
        return RegistryTotals(
            pages: targets.count,
            withKeywords: planned.count,
            keywords: targets.reduce(0) { $0 + $1.mappedKeywords.count },
            indexed: planned.filter { $0.indexed == "indexed" }.count,
            notIndexed: unindexedCount(planned)
        )
    }

    /// The Indexed series as the chart plots it: the days the server sent that carry a real
    /// calendar date, oldest first.
    ///
    /// The series is never sorted or filled here. The server records one reading a day and
    /// sends them in order; a gap in it is a day nobody synced, and the chart draws straight
    /// across it rather than inventing a reading the ledger does not hold.
    static func coverageDays(_ days: [IndexCoverageDay]) -> [IndexCoverageDay] {
        days.filter { $0.day != nil }
    }
}

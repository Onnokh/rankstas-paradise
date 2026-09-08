import Foundation

/// How the registry screen ranks its pages. Clicks, impressions and visits are the same
/// three the ranking cards offer; path is the way to find one page among many.
enum RegistrySort: String, CaseIterable, Identifiable, Sendable {
    case impressions
    case clicks
    case visits
    case path

    var id: Self { self }

    var label: String {
        switch self {
        case .impressions: "Impressions"
        case .clicks: "Clicks"
        case .visits: "Visits"
        case .path: "Path"
        }
    }

    /// What the sort reads off a page. Nil for the path, which sorts by its own text.
    func value(of target: RegistryTarget) -> Double? {
        switch self {
        case .impressions: target.window.impressions
        case .clicks: target.window.clicks
        case .visits: target.visits?.current.visits ?? 0
        case .path: nil
        }
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

    /// How many of the pages Google reports as not indexed.
    static func unindexedCount(_ targets: [RegistryTarget]) -> Int {
        targets.filter(\.isUnindexed).count
    }
}

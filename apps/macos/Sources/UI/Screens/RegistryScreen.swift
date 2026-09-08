import SwiftUI

/// Sub-screen listing every page the site's registry tracks: what each one reached in the
/// server's own 28-day window, the phase it is in, and the keywords mapped to it. A page
/// Google reports as not indexed keeps its place in the ranking and is dimmed, the reading
/// the ranking card and the other clients give it.
///
/// The rows are the ones the site screen already loaded: the registry comes with the ranked
/// lists, cache-first, so this screen shows what is held at once and never fetches on its own.
struct RegistryScreen: View {
    let overview: SiteOverview
    @Bindable var state: SiteTabState
    let rankings: RankingStore
    let onBack: () -> Void
    let onRefresh: () -> Void

    @Environment(\.isTabPreview) private var isPreview

    /// The registry as it is held for this site, in the server's order.
    private var targets: [RegistryTarget] {
        rankings.registry[overview.id] ?? []
    }

    private var rows: [RegistryTarget] {
        RegistryList.rows(
            targets,
            sort: state.registrySort,
            unindexedOnly: state.registryUnindexedOnly,
            search: state.registrySearch
        )
    }

    private var loading: Bool { rankings.loading.contains(overview.id) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                    .padding(.top, SiteTabScreen.columnInset)
                    .padding(.bottom, 24)

                controls
                    .padding(.bottom, 20)

                list

                if let error = rankings.errors[overview.id] {
                    Text(error)
                        .foregroundStyle(Palette.coral)
                        .padding(.top, 16)
                }
            }
            .column()
            .padding(.bottom, SiteTabScreen.columnInset)
        }
        .scrollDisabled(isPreview)
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Button(overview.site.name, systemImage: "chevron.left", action: onBack)
                    .keyboardShortcut(isPreview ? nil : KeyboardShortcut("[", modifiers: .command))
                Spacer()
                if loading {
                    ProgressView()
                        .controlSize(.small)
                }
                Button("Refresh", systemImage: "arrow.clockwise", action: onRefresh)
                    .labelStyle(.iconOnly)
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .disabled(loading)
                    .help("Refresh (⌘R)")
            }

            Text("Registry")
                .font(.largeTitle)

            Text(summary)
                .foregroundStyle(.secondary)
        }
    }

    /// What the registry holds, in one line: how many pages, how many carry keywords, how
    /// many Google does not hold, and the market every search volume below is measured in.
    /// The market is a property of the site, so it belongs here once rather than on each
    /// keyword — but it has to be somewhere, because a volume without its market is
    /// ambiguous.
    private var summary: String {
        guard !targets.isEmpty else {
            return loading ? "Loading…" : "No target pages yet."
        }
        let mapped = targets.filter { !$0.mappedKeywords.isEmpty }.count
        let unindexed = RegistryList.unindexedCount(targets)
        var parts = ["\(targets.count) \(targets.count == 1 ? "page" : "pages")"]
        parts.append("\(mapped) with keywords")
        if unindexed > 0 {
            parts.append("\(unindexed) not indexed")
        }
        if let market = overview.site.market, RegistryList.hasDemand(targets) {
            parts.append(market.summary)
        }
        return parts.joined(separator: " · ")
    }

    private var controls: some View {
        HStack(spacing: 20) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Filter by path or keyword", text: $state.registrySearch)
                    .textFieldStyle(.plain)
                    .frame(maxWidth: 240)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Palette.raised, in: .rect(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.line))

            Toggle("Not indexed only", isOn: $state.registryUnindexedOnly)
                .toggleStyle(.checkbox)

            Spacer()

            WordSwitch(options: RegistrySort.allCases, selection: $state.registrySort, label: \.label, font: .subheadline)
                .accessibilityLabel("Rank by")
        }
        .disabled(isPreview)
    }

    // MARK: List

    @ViewBuilder
    private var list: some View {
        if rows.isEmpty {
            ContentUnavailableView(
                targets.isEmpty ? "No target pages" : "No pages match",
                systemImage: "list.bullet.rectangle",
                description: Text(
                    targets.isEmpty
                        ? "The registry for \(overview.site.name) has no target pages yet."
                        : "No page in the registry matches the filter."
                )
            )
            .frame(minHeight: 240)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                columnHeadings
                // Plain rows, drawn in full: the registry is a page of a few hundred at
                // most, and a lazy stack here re-phases its items while the tab's live
                // poll runs behind the screen.
                ForEach(rows) { target in
                    RegistryRow(
                        target: target,
                        origin: overview.site.origin,
                        isOpen: state.registryOpenPath == target.targetUrl,
                        onToggle: { toggle(target) }
                    )
                    Divider().opacity(0.4)
                }
            }
            .padding(.vertical, 4)
            .cardSurface(cornerRadius: 12)

            if rows.contains(where: \.isUnindexed) {
                Text("Dimmed rows are pages Google reports as not indexed.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.top, 10)
            }
        }
    }

    private var columnHeadings: some View {
        HStack(spacing: RegistryRow.columnSpacing) {
            Text("Page")
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("Phase")
                .frame(width: RegistryRow.phaseWidth, alignment: .leading)
            Text("Impressions")
                .frame(width: RegistryRow.numberWidth, alignment: .trailing)
            Text("Clicks")
                .frame(width: RegistryRow.numberWidth, alignment: .trailing)
            Text("CTR")
                .frame(width: RegistryRow.numberWidth, alignment: .trailing)
            Text("Visits")
                .frame(width: RegistryRow.numberWidth, alignment: .trailing)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }

    private func toggle(_ target: RegistryTarget) {
        state.registryOpenPath = state.registryOpenPath == target.targetUrl ? nil : target.targetUrl
    }
}

// MARK: - Row

/// One page of the registry: its path, its phase, and the window's figures. Clicking it opens
/// what the registry knows about the page under the row.
private struct RegistryRow: View {
    let target: RegistryTarget
    /// The site's origin, so the open button can reach the page itself.
    let origin: String
    let isOpen: Bool
    let onToggle: () -> Void

    @State private var isHovered = false

    static let columnSpacing: CGFloat = 12
    static let numberWidth: CGFloat = 84
    static let phaseWidth: CGFloat = 52
    /// How far a row drops when Google reports the page is not indexed.
    private static let unindexedOpacity: Double = 0.45

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onToggle) {
                summaryRow
            }
            .buttonStyle(.plain)
            .background(isHovered ? Palette.line.opacity(0.5) : .clear)
            .onHover { isHovered = $0 }
            .accessibilityElement(children: .combine)
            .accessibilityHint(target.isUnindexed ? "Not indexed" : "")
            .accessibilityAddTraits(.isButton)

            if isOpen {
                RegistryDetail(target: target, origin: origin)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
            }
        }
        .opacity(target.isUnindexed ? Self.unindexedOpacity : 1)
        .help(target.isUnindexed ? (target.coverageState ?? "Google reports this page is not indexed") : "")
    }

    private var summaryRow: some View {
        HStack(spacing: Self.columnSpacing) {
            HStack(spacing: 8) {
                Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(target.targetUrl)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if !target.mappedKeywords.isEmpty {
                    Text("\(target.mappedKeywords.count) kw")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            PhaseBadge(phase: target.phase)
                .frame(width: Self.phaseWidth, alignment: .leading)

            number(target.window.impressions)
            number(target.window.clicks)
            Text(target.window.impressions > 0 ? target.window.ctr.formatted(.percent.precision(.fractionLength(1))) : "—")
                .frame(width: Self.numberWidth, alignment: .trailing)
            Text(target.visits.map { $0.current.visits.formatted(.number.precision(.fractionLength(0))) } ?? "—")
                .frame(width: Self.numberWidth, alignment: .trailing)
        }
        .monospacedDigit()
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        .contentShape(.rect)
    }

    private func number(_ value: Double) -> some View {
        Text(value.formatted(.number.precision(.fractionLength(0))))
            .frame(width: Self.numberWidth, alignment: .trailing)
    }
}

/// The server's phase word, in the colour of what it says.
private struct PhaseBadge: View {
    let phase: String

    private var known: RegistryPhase? { RegistryPhase(rawValue: phase) }

    private var tint: Color {
        switch known {
        case .live: Palette.mint
        case .page: .secondary
        case .measuring: Palette.coral
        case .pre, .new: Palette.amber
        case nil: .secondary
        }
    }

    var body: some View {
        Text(phase)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint.opacity(0.14), in: .rect(cornerRadius: 4))
            .help(known?.meaning ?? "")
    }
}

// MARK: - Detail

/// What the registry knows about one page, under its row: Google's verdict, the keywords
/// mapped to it, the dates it is measured from, and why it was picked.
private struct RegistryDetail: View {
    let target: RegistryTarget
    let origin: String

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Text(indexLabel)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(indexTint)
                if let coverage = target.coverageState, !coverage.isEmpty {
                    Text(coverage)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let url = pageURL {
                    Button("Open page", systemImage: "arrow.up.right.square") { openURL(url) }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                        .help(url.absoluteString)
                }
            }

            if !target.mappedKeywords.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Keywords")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    // A wrapping row of the mapped keywords, each with its search volume:
                    // this is what makes the plan checkable rather than a list of
                    // intentions. A keyword nobody searches for is a page nobody will find,
                    // whatever its priority says. The cluster, the intent and the rest of
                    // the vendor's numbers sit in the tooltip, so a long list stays one line
                    // per keyword.
                    FlowRow(spacing: 6) {
                        ForEach(target.mappedKeywords) { keyword in
                            KeywordChip(keyword: keyword)
                        }
                    }
                }
            }

            if let why = target.whyOpportunity, !why.isEmpty {
                Text(why)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            facts
        }
        .padding(.leading, 20)
    }

    private var facts: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(rows, id: \.0) { label, value in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(label)
                        .frame(width: 110, alignment: .leading)
                        .foregroundStyle(.secondary)
                    Text(value)
                }
            }
        }
        .font(.caption)
    }

    /// The dates and words the registry carries for the page, each shown only when it has one.
    private var rows: [(String, String)] {
        var facts: [(String, String)] = [("Status", target.status)]
        if let intent = target.intent, !intent.isEmpty { facts.append(("Intent", intent)) }
        if let priority = target.priority, !priority.isEmpty { facts.append(("Priority", priority)) }
        if let published = target.publishedAt, !published.isEmpty { facts.append(("Published", published)) }
        if let baseline = target.baselineDate, !baseline.isEmpty { facts.append(("Baseline", baseline)) }
        if let from = target.measuredFrom, !from.isEmpty { facts.append(("Measured from", from)) }
        if let inspected = target.inspectedAt, !inspected.isEmpty {
            facts.append(("Inspected", String(inspected.prefix(10))))
        }
        if let baseline = target.baseline {
            let move = target.window.impressions - baseline.impressions
            facts.append((
                "Vs baseline",
                "\(move < 0 ? "−" : "+")\(abs(move).formatted(.number.precision(.fractionLength(0)))) impressions"
            ))
        }
        return facts
    }

    private var pageURL: URL? {
        URL(string: origin.hasSuffix("/") ? String(origin.dropLast()) + target.targetUrl : origin + target.targetUrl)
    }

    private var indexLabel: String {
        switch target.indexed {
        case "indexed": "Indexed"
        case "not-indexed": "Not indexed"
        default: "Index unknown"
        }
    }

    private var indexTint: Color {
        switch target.indexed {
        case "indexed": Palette.mint
        case "not-indexed": Palette.coral
        default: .secondary
        }
    }
}

/// One mapped keyword, with its search volume when the site has one.
///
/// The volume sits on the chip because it is the number that decides whether the mapping
/// was worth making; everything else the vendor says is in the tooltip, where a reader who
/// wants it can find it without the list growing a column per number.
///
/// A keyword with no stored answer looks exactly as it did before demand existed. That is
/// deliberate: an absent answer means nobody has asked yet, and showing a "0" or a dash
/// would claim the vendor said something it did not.
private struct KeywordChip: View {
    let keyword: RegistryKeyword

    var body: some View {
        HStack(spacing: 5) {
            Text(keyword.keyword)
            if let volume = keyword.demand?.volumeLabel {
                Text(volume)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
        .font(.caption)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(Palette.line.opacity(0.7), in: .capsule)
        .help(tooltip)
    }

    /// The cluster and intent the registry holds, then the numbers the vendor reported.
    /// Difficulty is shown and never ranked on: a term this site cannot reach yet is still
    /// a real target, just not this quarter's, so the reader weighs it against the site's
    /// domain rating themselves.
    private var tooltip: String {
        var parts = [keyword.cluster, keyword.intent].filter { !$0.isEmpty }
        if let demand = keyword.demand {
            if let difficulty = demand.difficultyLabel { parts.append(difficulty) }
            if let cost = demand.costPerClick {
                parts.append("CPC \(cost.formatted(.currency(code: "USD")))")
            }
            if let intent = demand.intent, !intent.isEmpty, intent != keyword.intent {
                parts.append("searched as \(intent)")
            }
            parts.append("measured \(demand.fetchedAt.prefix(10))")
        }
        return parts.joined(separator: " · ")
    }
}

/// A row of items that wraps to the next line when the width runs out: the keyword chips.
private struct FlowRow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: proposal.width ?? x, height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var lineHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += lineHeight + spacing
                lineHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}

import Charts
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

    /// What the whole registry adds up to, over every target the server sent — not over the
    /// filtered rows: the strip describes the plan, and a search that hides half of it does
    /// not change what the plan holds.
    private var totals: RegistryTotals { RegistryList.totals(targets) }

    /// The Indexed series that came with the registry, oldest first.
    private var coverage: [IndexCoverageDay] {
        RegistryList.coverageDays(rankings.coverage[overview.id] ?? [])
    }

    private var loading: Bool { rankings.loading.contains(overview.id) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // The registry's numbers lead the screen, as the plan's do on the
                // planning screen and the site's on the dashboard. With no targets in
                // hand there is nothing to count, and a strip of zeros would be a claim
                // about a registry the screen has not read — so those states say so in a
                // line of prose instead.
                Group {
                    if targets.isEmpty {
                        header
                    } else {
                        numbers
                    }
                }
                .padding(.top, SiteTabScreen.screenInset)
                .padding(.bottom, 24)

                if !targets.isEmpty {
                    indexing
                        .padding(.bottom, 24)
                }

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

    /// What the screen holds, in one line — and only while there is no registry to count.
    /// With one in hand the strip below says all of this and says it as figures, so a line
    /// repeating it would be a second, older copy of the same claim.
    private var header: some View {
        Text(summary)
            .foregroundStyle(.secondary)
    }

    private var summary: String {
        loading ? "Loading…" : "No target pages yet."
    }

    // MARK: Numbers

    /// The registry's figures in one row, plain on the panel, read like the dashboard's: a
    /// label over a large number. How many pages the plan holds, then the two shares that
    /// say what is true of them — how much of the registry aims at a keyword at all, and how
    /// much of it Google holds — and the pages Google reports it does not hold.
    ///
    /// The shares are shown as shares, with their count under them. The count alone left the
    /// reader dividing two numbers to answer the only question the strip is asked: is this
    /// most of the registry, or a corner of it.
    ///
    /// A hairline separates those from the market, as on the planning screen: the market
    /// describes the SITE and not this plan, and it is what every search volume in the rows
    /// below means — a volume is only comparable inside one market.
    private var numbers: some View {
        HStack(alignment: .top, spacing: 0) {
            Metric(
                title: "Pages",
                value: totals.pages.formatted(),
                footnote: "in the registry"
            )
            .help("Every page the registry tracks: the keyword targets, and the inventory-only pages tracked with no keyword of their own.")
            gap
            Metric(
                title: "With keywords",
                value: percent(totals.keywordShare),
                footnote: pagesFootnote(totals.withKeywords)
            )
            .help("How much of the registry aims at a keyword at all. The rest are inventory-only pages — tracked, and judged on every query they draw, with nothing planned to rank on them.")
            gap
            Metric(
                title: "Indexed",
                value: percent(totals.indexedShare),
                footnote: pagesFootnote(totals.indexed)
            )
            .help(indexedHelp)
            gap
            Metric(
                title: "Not indexed",
                value: totals.notIndexed.formatted(),
                // The count and not a share: this is the backlog, and a backlog is
                // worked through page by page. The pages Google has answered nothing
                // about are named beside it when there are any, because they are the
                // ones a reader would otherwise take for indexed.
                footnote: totals.unknown > 0
                    ? "\(totals.unknown) unanswered"
                    : "of \(totals.pages) \(totals.pages == 1 ? "page" : "pages")"
            )
            .help("Pages Google reports it has NOT indexed. These are the dimmed rows below, and the checkbox beside the search keeps only them.")

            if let market = overview.site.market, RegistryList.hasDemand(targets) {
                gap
                Rectangle()
                    .fill(Palette.line)
                    .frame(width: 1, height: 48)
                gap
                Metric(
                    title: "Market",
                    value: market.languageCode.uppercased(),
                    footnote: market.label
                )
                .help("Every search volume in the rows below is measured in \(market.summary). The same keyword has a different number in every market.")
            }
        }
    }

    /// One flexible gap, as on the dashboard's strip: the figures sit at the two ends of the
    /// column and the room between them is shared, so the row reads as one line across the
    /// page rather than a cluster on its left.
    private var gap: some View {
        Spacer(minLength: 20)
    }

    /// A share as the strip prints it. A dash where there is nothing to divide: an empty
    /// registry is not a registry that is 0% indexed.
    private func percent(_ share: Double?) -> String {
        share?.formatted(.percent.precision(.fractionLength(0))) ?? "—"
    }

    /// The denominator, in the footnote rather than the figure: the large number answers
    /// "how much of it", and the count under it says of what.
    private func pagesFootnote(_ count: Int) -> String {
        "\(count) of \(totals.pages) \(totals.pages == 1 ? "page" : "pages")"
    }

    private var indexedHelp: String {
        var help = "How much of the registry Google reports as in its index, from its last inspection of each page."
        if totals.unknown > 0 {
            help += " The \(totals.unknown) Google has said nothing about count against this share, not beside it: a page nobody has checked earns no more than one Google left out."
        }
        return help
    }

    // MARK: Indexing over time

    /// How much of the registry Google held, day by day.
    ///
    /// The server records one reading a day and cannot backfill it — URL Inspection answers
    /// only for the present — so the series is worth exactly as many days as it has been
    /// recording. A young registry therefore gets a sentence instead of a chart, rather than
    /// a line drawn through days nobody recorded.
    private var indexing: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Text("Indexed over time")
                    .font(.headline)
                if loading {
                    ProgressView()
                        .controlSize(.small)
                }
                Spacer()
                legend
            }

            if coverage.count >= 2 {
                IndexingChart(days: coverage)
            } else {
                Text(waitingForDays)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, minHeight: 80, alignment: .topLeading)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
    }

    /// Which line is which, as a pair of dots — the same tie between a figure and its series
    /// the dashboard's strip uses.
    private var legend: some View {
        HStack(spacing: 14) {
            ForEach(
                [("Indexed", IndexingChart.indexedColor), ("Pages tracked", IndexingChart.trackedColor)],
                id: \.0
            ) { label, color in
                HStack(spacing: 6) {
                    Circle()
                        .fill(color)
                        .frame(width: 6, height: 6)
                    Text(label)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityHidden(true)
    }

    /// Why there is no chart yet. Never "no data": the series is young, which is a fact
    /// about how long the server has been recording and not about this registry.
    private var waitingForDays: String {
        guard let only = coverage.last else {
            return "No day recorded yet. The daily sync writes one reading a day from here on, and the chart appears once there are two — the series is written a day at a time and cannot be backfilled."
        }
        return "One day recorded so far: \(only.indexed) of \(only.tracked) \(only.tracked == 1 ? "page" : "pages") indexed. The chart appears once there are two — the series is written a day at a time and cannot be backfilled."
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

// MARK: - Indexing chart

/// How many of the registry's pages Google held, day by day, against how many the registry
/// tracked that day.
///
/// Two lines and not one percentage: a share that fell can mean Google dropped a page or that
/// the registry gained one, and those call for opposite work. The gap between the lines is
/// the backlog, and the tooltip prints the share for the day the reader is on.
private struct IndexingChart: View {
    let days: [IndexCoverageDay]

    @Environment(\.isTabPreview) private var isPreview
    @State private var hovered: IndexCoverageDay?

    static let indexedColor = Palette.mint
    static let trackedColor = Palette.blue

    var body: some View {
        VStack(spacing: 6) {
            chart
            endLabels
        }
    }

    /// The first and last day, at the two ends of the run, as the dashboard's chart sets
    /// them: outside the plot, so the plot keeps the card's full width.
    private var endLabels: some View {
        HStack {
            Text(label(days.first))
            Spacer()
            Text(label(days.last))
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private func label(_ day: IndexCoverageDay?) -> String {
        guard let date = day?.day else { return "" }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }

    private var chart: some View {
        Chart {
            ForEach(days) { day in
                if let date = day.day {
                    AreaMark(
                        x: .value("Date", date),
                        y: .value("Indexed", day.indexed),
                        series: .value("Series", "Indexed"),
                        stacking: .unstacked
                    )
                    .foregroundStyle(Self.gradient)

                    LineMark(
                        x: .value("Date", date),
                        y: .value("Indexed", day.indexed),
                        series: .value("Series", "Indexed")
                    )
                    .foregroundStyle(Self.indexedColor)
                    .lineStyle(StrokeStyle(lineWidth: 1.5, lineJoin: .round))

                    // The registry itself, as a dashed ceiling: it is a count of rows and
                    // not a measurement, so it is drawn as the boundary of the plot rather
                    // than as a second reading beside the first.
                    LineMark(
                        x: .value("Date", date),
                        y: .value("Pages tracked", day.tracked),
                        series: .value("Series", "Pages tracked")
                    )
                    .foregroundStyle(Self.trackedColor.opacity(0.8))
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                }
            }
            .interpolationMethod(.monotone)

            if let hovered, let date = hovered.day {
                RuleMark(x: .value("Date", date))
                    .foregroundStyle(.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .annotation(
                        position: .top,
                        alignment: .leading,
                        spacing: 10,
                        overflowResolution: .init(x: .fit(to: .chart), y: .disabled)
                    ) {
                        IndexingTooltip(day: hovered)
                    }
                PointMark(x: .value("Date", date), y: .value("Indexed", hovered.indexed))
                    .foregroundStyle(Self.indexedColor)
                    .symbolSize(70)
            }
        }
        .chartLegend(.hidden)
        // Zero to the whole registry, always: a chart scaled to the readings alone turned
        // "3 of 27 indexed" into a line across the top of the card.
        .chartYScale(domain: 0...Double(max(days.map(\.tracked).max() ?? 1, 1)))
        // The baseline is the only horizontal rule: a hairline at zero, as on the dashboard.
        .chartYAxis {
            AxisMarks(values: [0]) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 1))
                    .foregroundStyle(Palette.line)
            }
        }
        .chartXAxis {
            AxisMarks(values: .stride(by: .day, count: tickStride)) { _ in
                AxisTick(centered: false, length: 2, stroke: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .foregroundStyle(Palette.line)
            }
        }
        // Room above the ceiling for the tooltip.
        .chartPlotStyle { plot in
            plot.padding(.top, 8)
        }
        .chartOverlay { proxy in
            if !isPreview {
                GeometryReader { geometry in
                    Rectangle()
                        .fill(.clear)
                        .contentShape(Rectangle())
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let location):
                                hovered = day(at: location, proxy: proxy, geometry: geometry)
                            case .ended:
                                hovered = nil
                            }
                        }
                }
            }
        }
        .frame(minHeight: 160, maxHeight: 220)
    }

    /// Days between ticks: one per day up to a month, then thinned so the dots stay dots.
    private var tickStride: Int {
        days.count <= 31 ? 1 : days.count <= 100 ? 3 : 7
    }

    private func day(at location: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) -> IndexCoverageDay? {
        guard let plotFrame = proxy.plotFrame else { return nil }
        let origin = geometry[plotFrame].origin
        guard let date: Date = proxy.value(atX: location.x - origin.x) else { return nil }
        return days
            .compactMap { day -> (IndexCoverageDay, TimeInterval)? in
                guard let own = day.day else { return nil }
                return (day, abs(own.timeIntervalSince(date)))
            }
            .min { $0.1 < $1.1 }?
            .0
    }

    private static let gradient = LinearGradient(
        colors: [indexedColor.opacity(0.28), indexedColor.opacity(0.02)],
        startPoint: .top,
        endPoint: .bottom
    )
}

/// One day of the Indexed series, on hover: the share, the two counts behind it, and the
/// pages Google said nothing about that day — the ones the share counts against.
private struct IndexingTooltip: View {
    let day: IndexCoverageDay

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let date = day.day {
                Text(date.formatted(.dateTime.day().month(.abbreviated)))
                    .font(.callout.weight(.semibold))
            }
            Text("Indexed : \(day.indexed) of \(day.tracked)\(share)")
            if day.unknown > 0 {
                Text("\(day.unknown) unanswered")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .font(.callout)
        .monospacedDigit()
        .padding(12)
        .background(.regularMaterial, in: .rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
        .shadow(color: .black.opacity(0.25), radius: 8, y: 4)
    }

    private var share: String {
        guard let share = day.indexedShare else { return "" }
        return " · \(share.formatted(.percent.precision(.fractionLength(0))))"
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

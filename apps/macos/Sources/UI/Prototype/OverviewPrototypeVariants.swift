#if DEBUG
import Charts
import SwiftUI

// PROTOTYPE — throwaway. Not for main.
//
// Round four's three bodies. Each is what sits between the strip and the footer.

// MARK: - Readings

/// This period against the one before, as the prototype says it: a ratio, a word, a colour.
/// The bands are the screen's, not the server's — see the note on thresholds.
struct ProtoGrowth {
    let current: Double
    let previous: Double?

    /// (current − previous) / previous. Nil when there was nothing to grow from.
    var ratio: Double? {
        guard let previous, previous > 0 else { return nil }
        return (current - previous) / previous
    }

    /// "+34%", or "new" for a count that came from nothing, or a dash for nothing at all.
    var label: String {
        if let ratio { return Trend.signed(ratio * 100, fractionDigits: 0) + "%" }
        return current > 0 ? "new" : "—"
    }

    var verdict: String {
        guard let ratio else { return current > 0 ? "Started this period" : "Nothing yet" }
        if ratio >= 0.1 { return "Growing" }
        if ratio <= -0.1 { return "Slipping" }
        return "Flat"
    }

    /// Mint up, coral down, secondary for flat or unknown: one colour, one meaning.
    var tint: Color? {
        guard let ratio else { return nil }
        if ratio >= 0.1 { return Palette.mint }
        if ratio <= -0.1 { return Palette.coral }
        return nil
    }

    static func clicks(_ site: PrototypeSiteSeries) -> ProtoGrowth {
        ProtoGrowth(current: site.glance.comparison.currentStats.clicks, previous: site.glance.comparison.previousStats?.clicks)
    }

    static func visits(_ site: PrototypeSiteSeries) -> ProtoGrowth? {
        site.glance.visits.map { ProtoGrowth(current: $0.current, previous: $0.previous) }
    }

    static func revenue(_ site: PrototypeSiteSeries) -> ProtoGrowth? {
        guard let report = site.revenue, report.revenue != nil else { return nil }
        return ProtoGrowth(current: report.current.revenue, previous: report.previous.revenue)
    }
}

/// One week of the long run: seven days summed, newest last.
struct ProtoWeek: Identifiable {
    let end: Date
    let clicks: Double
    let impressions: Double
    /// Nil when no day of the week had a synced count.
    let visits: Double?

    var id: Date { end }

    /// The last `count` whole weeks, cut from the end of the run.
    static func weeks(_ days: [HistoryReportDay], count: Int = 26) -> [ProtoWeek] {
        var weeks: [ProtoWeek] = []
        var end = days.count
        while end - 7 >= 0, weeks.count < count {
            let run = days[(end - 7)..<end]
            let counted = run.compactMap(\.visits)
            weeks.append(ProtoWeek(
                end: run.last!.day,
                clicks: run.reduce(0) { $0 + $1.clicks },
                impressions: run.reduce(0) { $0 + $1.impressions },
                visits: counted.isEmpty ? nil : counted.reduce(0) { $0 + $1.visits }
            ))
            end -= 7
        }
        return weeks.reversed()
    }
}

/// The registry read as a funnel over the pages a keyword aims at.
struct ProtoFunnel {
    struct Step: Identifiable {
        let name: String
        let count: Int
        let note: String
        var id: String { name }
    }

    let steps: [Step]
    var planned: Int { steps.first?.count ?? 0 }

    init(targets: [RegistryTarget]) {
        let planned = targets.filter { !$0.mappedKeywords.isEmpty }
        let published = planned.filter { $0.phase != RegistryPhase.new.rawValue }
        let indexed = planned.filter { $0.indexed == "indexed" }
        let reached = planned.filter { $0.window.impressions > 0 }
        let clicked = planned.filter { $0.window.clicks > 0 }
        steps = [
            Step(name: "Planned", count: planned.count, note: "Pages a keyword aims at"),
            Step(name: "Published", count: published.count, note: "Pages Search Console has seen"),
            Step(name: "Indexed", count: indexed.count, note: "Pages Google reports in its index"),
            Step(name: "Reached", count: reached.count, note: "Pages a search reached in the window"),
            Step(name: "Clicked", count: clicked.count, note: "Pages a search brought someone to"),
        ]
    }
}

// MARK: - Parts

struct ProtoFavicon: View {
    let icon: Image?
    var size: CGFloat = 16

    var body: some View {
        Group {
            if let icon {
                icon.resizable().interpolation(.high).scaledToFit().clipShape(.rect(cornerRadius: 3))
            } else {
                Image(systemName: "globe").foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
    }
}

struct ProtoCardHeader: View {
    let site: PrototypeSiteSeries
    let icon: Image?
    var showsOrigin = true

    var body: some View {
        HStack(spacing: 8) {
            ProtoFavicon(icon: icon)
            Text(site.site.name)
                .font(.headline)
                .lineLimit(1)
            if showsOrigin {
                Text(site.site.origin.replacingOccurrences(of: "https://", with: ""))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if let error = site.glance.errorMessage {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(Palette.coral)
                    .help(error)
            }
        }
    }
}

/// How the period is set against the one before.
enum ProtoCompareStyle {
    /// The period as a line and area in the source's colour, over the period before as a
    /// grey line, the same days laid on the same axis. Growth is the gap between the lines.
    case overlay
    /// The period before as a dim block of bars, a gap, then the period lit. Growth is the
    /// step from one block to the next.
    case sideBySide
}

/// The period against the period before, for one source. Both runs are the same length:
/// a day per point up to a month, a week per point beyond, so a half year is 26 points.
struct ProtoCompareChart: View {
    let current: [Double]
    let previous: [Double]
    let color: Color
    let style: ProtoCompareStyle
    /// The earlier run is a stand-in — its total spread evenly — and is drawn dashed.
    var previousIsAverage = false

    /// Sums a run into buckets of `size` from its end, so both runs line up on their last day.
    static func buckets(_ values: [Double], size: Int) -> [Double] {
        guard size > 1 else { return values }
        var out: [Double] = []
        var end = values.count
        while end > 0 {
            let start = max(0, end - size)
            out.append(values[start..<end].reduce(0, +))
            end = start
        }
        return out.reversed()
    }

    /// Noon of the day `index` days after the made-up calendar's first day.
    static func slot(_ index: Int) -> Date {
        Date(timeIntervalSinceReferenceDate: 43_200 + Double(index) * 86_400)
    }

    /// A trailing mean over `window` points: the shape of a run of ones and zeros.
    static func smoothed(_ values: [Double], window: Int) -> [Double] {
        guard window > 1, values.count > window else { return values }
        return values.indices.map { index in
            let start = max(0, index - window + 1)
            let run = values[start...index]
            return run.reduce(0, +) / Double(run.count)
        }
    }

    var body: some View {
        switch style {
        case .overlay:
            Chart {
                RuleMark(y: .value("Value", 0))
                    .foregroundStyle(Palette.line)
                    .lineStyle(StrokeStyle(lineWidth: 1))
                ForEach(Array(previous.enumerated()), id: \.offset) { index, value in
                    LineMark(x: .value("Day", index), y: .value("Was", value), series: .value("Run", "was"))
                        .foregroundStyle(Color.secondary.opacity(0.7))
                        .lineStyle(StrokeStyle(lineWidth: 1.25, lineJoin: .round, dash: previousIsAverage ? [3, 3] : []))
                }
                .interpolationMethod(.monotone)
                ForEach(Array(current.enumerated()), id: \.offset) { index, value in
                    AreaMark(x: .value("Day", index), y: .value("Now", value), series: .value("Run", "now"))
                        .foregroundStyle(LinearGradient(colors: [color.opacity(0.28), color.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                    LineMark(x: .value("Day", index), y: .value("Now", value), series: .value("Run", "now"))
                        .foregroundStyle(color)
                        .lineStyle(StrokeStyle(lineWidth: 1.5, lineJoin: .round))
                }
                .interpolationMethod(.monotone)
            }
            .chartYScale(domain: .automatic(includesZero: true))
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartPlotStyle { plot in plot.padding(.top, 2) }
            .accessibilityHidden(true)
        case .sideBySide:
            // Slots are days on a made-up calendar: a bar needs a unit to take its width
            // from, and a day is the one Charts sizes reliably. Slot 0 is the first earlier
            // point; one empty slot separates the two blocks.
            let gap = 1
            let slots = previous.count + gap + current.count
            Chart {
                RuleMark(y: .value("Value", 0))
                    .foregroundStyle(Palette.line)
                    .lineStyle(StrokeStyle(lineWidth: 1))
                ForEach(Array(previous.enumerated()), id: \.offset) { index, value in
                    BarMark(x: .value("Slot", Self.slot(index), unit: .day), y: .value("Was", value))
                        .foregroundStyle(color.opacity(previousIsAverage ? 0.18 : 0.3))
                        .cornerRadius(1.5)
                }
                ForEach(Array(current.enumerated()), id: \.offset) { index, value in
                    BarMark(x: .value("Slot", Self.slot(previous.count + gap + index), unit: .day), y: .value("Now", value))
                        .foregroundStyle(color)
                        .cornerRadius(1.5)
                }
            }
            .chartXScale(domain: Self.slot(0).addingTimeInterval(-43_200)...Self.slot(max(slots - 1, 0)).addingTimeInterval(43_200))
            .chartYScale(domain: .automatic(includesZero: true))
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartPlotStyle { plot in plot.padding(.top, 2) }
            .accessibilityHidden(true)
        }
    }
}

// MARK: - E. Trajectory

/// One card per project. Four columns — Search, Visitors, Sales, Plan — each led by the
/// growth as one large percentage, the counts it comes from under it in a line, and the
/// last 26 weeks as bars, the compared period lit. A source the site does not have keeps
/// its column and says so.
struct ProtoTrajectoryVariant: View {
    let sites: [PrototypeSiteSeries]
    let period: Period
    let style: ProtoCompareStyle
    var compact = false
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    var body: some View {
        VStack(spacing: compact ? 12 : 20) {
            ForEach(sites) { site in
                ProtoTrajectoryCard(site: site, period: period, style: style, compact: compact, icon: icon(site.id))
                    .onTapGesture(count: 2) { onOpen(site.id) }
                    .help(site.glance.errorMessage ?? "Double-click to open \(site.site.name)")
            }
        }
        .column()
        .padding(.top, 36)
    }
}

struct ProtoTrajectoryCard: View {
    let site: PrototypeSiteSeries
    let period: Period
    let style: ProtoCompareStyle
    var compact = false
    let icon: Image?

    /// The compact card's sizes: the figure at 20 points, the picture at 36.
    private var figureSize: CGFloat { compact ? 20 : 28 }
    private var pictureHeight: CGFloat { compact ? 36 : 48 }

    /// The overlay is a line: a day per point up to a month, a week per point beyond, and a
    /// daily run is read through a seven-day trailing mean so a site with one click a day
    /// draws a shape and not a square wave. The blocks are bars: a week per bar from 28 days
    /// on, so four weeks stand against four weeks.
    private var bucket: Int {
        switch style {
        case .overlay: period.days > 31 ? 7 : 1
        case .sideBySide: period.days >= 28 ? 7 : 1
        }
    }

    private func shape(_ values: [Double]) -> [Double] {
        let bucketed = ProtoCompareChart.buckets(values, size: bucket)
        guard style == .overlay, bucket == 1, period.days >= 14 else { return bucketed }
        return ProtoCompareChart.smoothed(bucketed, window: 7)
    }

    private func runs(_ value: (HistoryReportDay) -> Double) -> (now: [Double], was: [Double]) {
        (shape(site.days.map(value)), shape(site.previousDays.map(value)))
    }

    var body: some View {
        Group {
            if compact {
                HStack(alignment: .top, spacing: 24) {
                    // The name in a zone of its own, so the card is one band and not a header
                    // over a band.
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            ProtoFavicon(icon: icon)
                            Text(site.site.name)
                                .font(.headline)
                                .lineLimit(1)
                        }
                        Text(site.site.origin.replacingOccurrences(of: "https://", with: ""))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        if let error = site.glance.errorMessage {
                            Image(systemName: "exclamationmark.triangle")
                                .foregroundStyle(Palette.coral)
                                .help(error)
                        }
                    }
                    .frame(width: 140, alignment: .leading)
                    columns
                }
            } else {
                VStack(alignment: .leading, spacing: 20) {
                    ProtoCardHeader(site: site, icon: icon)
                    columns
                }
            }
        }
        .padding(compact ? 16 : 20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
        .contentShape(Rectangle())
    }

    private var columns: some View {
        let clicks = ProtoGrowth.clicks(site)
        let visits = ProtoGrowth.visits(site)
        let revenue = ProtoGrowth.revenue(site)
        return HStack(alignment: .top, spacing: compact ? 20 : 28) {
            ProtoSourceColumn(
                title: "Search",
                growth: clicks,
                line: "\(GlanceFigure.count(clicks.current)) clicks" + (clicks.previous.map { ", was \(GlanceFigure.count($0))" } ?? ""),
                absent: nil,
                figureSize: figureSize,
                pictureHeight: pictureHeight
            ) {
                let run = runs(\.clicks)
                ProtoCompareChart(current: run.now, previous: run.was, color: Palette.blue, style: style)
            }
            ProtoSourceColumn(
                title: "Visitors",
                growth: visits,
                line: visits.map { "\(GlanceFigure.count($0.current)) visits" + ($0.previous.map { ", was \(GlanceFigure.count($0))" } ?? "") } ?? "",
                absent: "No analytics provider",
                figureSize: figureSize,
                pictureHeight: pictureHeight
            ) {
                let run = runs { $0.visits?.visits ?? 0 }
                ProtoCompareChart(current: run.now, previous: run.was, color: visitsColor, style: style)
            }
            ProtoSourceColumn(
                title: "Sales",
                growth: revenue,
                line: site.revenue.map { "\(Money.format($0.current.revenue, currency: $0.currency)), was \(Money.format($0.previous.revenue, currency: $0.currency))" } ?? "",
                absent: "No commerce provider",
                figureSize: figureSize,
                pictureHeight: pictureHeight
            ) {
                // The revenue report carries only the window's days, and the period before
                // as one total: that total is spread over the same days as a dashed line.
                let now = shape((site.revenue?.days ?? []).map { $0.revenue / 100 })
                let wasTotal = (site.revenue?.previous.revenue ?? 0) / 100
                let was = now.isEmpty ? [] : Array(repeating: wasTotal / Double(now.count), count: now.count)
                ProtoCompareChart(current: now, previous: was, color: Palette.mint, style: style, previousIsAverage: true)
            }
            planColumn
        }
    }

    /// The plan's column: the indexed share as the figure, its move over the indexing series
    /// as the tint, the funnel's ends as the line, the series as the picture.
    private var planColumn: some View {
        let funnel = ProtoFunnel(targets: site.targets)
        let share = site.registry?.indexedShare
        let first = site.coverage.first?.indexedShare
        let last = site.coverage.last?.indexedShare
        let move: Double? = if let first, let last, site.coverage.count >= 2 { (last - first) * 100 } else { nil }
        return VStack(alignment: .leading, spacing: 8) {
            Text("Plan")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            if let share {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(share.formatted(.percent.precision(.fractionLength(0))))
                        .font(.system(size: figureSize, weight: .medium))
                        .monospacedDigit()
                    Text(move.map { Trend.signed($0, fractionDigits: 0) + "pp" } ?? "indexed")
                        .font(.caption.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(move.map { GlanceFigure.tint($0) } ?? .secondary)
                }
                Text("\(funnel.steps[4].count) of \(funnel.planned) planned pages clicked")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else {
                Text("—")
                    .font(.system(size: figureSize, weight: .medium))
                Text(site.registry == nil ? "No registry yet" : "No keyword pages planned")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            Group {
                if site.coverage.count >= 2 {
                    ProtoSparkline(values: site.coverage.map { ($0.indexedShare ?? 0) * 100 }, color: Palette.mint, fromZero: false)
                } else {
                    ProtoNoPicture(text: site.registry == nil ? "" : "Indexing series too young")
                }
            }
            .frame(height: pictureHeight)
            .padding(.top, 6)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

/// One source's column on a trajectory card.
struct ProtoSourceColumn<Picture: View>: View {
    let title: String
    let growth: ProtoGrowth?
    let line: String
    /// Why there is no growth to show, for a site without this source.
    let absent: String?
    var figureSize: CGFloat = 28
    var pictureHeight: CGFloat = 48
    @ViewBuilder let picture: () -> Picture

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            if let growth {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(growth.label)
                        .font(.system(size: figureSize, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(growth.tint ?? .primary)
                    Text(growth.verdict)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                Text(line)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                picture()
                    .frame(height: pictureHeight)
                    .padding(.top, 6)
            } else {
                Text("—")
                    .font(.system(size: figureSize, weight: .medium))
                Text(absent ?? "")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                ProtoNoPicture(text: "")
                    .frame(height: pictureHeight)
                    .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

/// The picture's zone when there is nothing to draw: the reason, small, over the baseline
/// the chart would have had.
struct ProtoNoPicture: View {
    let text: String

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Text(text)
                .font(.caption)
                .foregroundStyle(.tertiary)
            Spacer()
            Palette.line.frame(height: 1)
        }
    }
}

// MARK: E1b. Trajectory as rows

/// One card, one row per project: the site in the first zone, then four zones — Search,
/// Visitors, Sales, Plan — each the percentage with its word over the "was" line, and the
/// period against the period before as a small chart beside them. One row height.
struct ProtoTrajectoryRows: View {
    let sites: [PrototypeSiteSeries]
    let period: Period
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    @Environment(\.isTabPreview) private var isPreview
    @State private var hoveredRow: Site.ID?

    static let siteWidth: CGFloat = 130
    static let spacing: CGFloat = 14
    static let rowHeight: CGFloat = 60
    static let chartWidth: CGFloat = 64
    static let columns = ["Search", "Visitors", "Sales", "Plan"]
    private static let overhang: CGFloat = 8

    private var bucket: Int { period.days > 31 ? 7 : 1 }

    private func shape(_ values: [Double]) -> [Double] {
        let bucketed = ProtoCompareChart.buckets(values, size: bucket)
        guard bucket == 1, period.days >= 14 else { return bucketed }
        return ProtoCompareChart.smoothed(bucketed, window: 7)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: Self.spacing) {
                Text("Projects")
                    .font(.headline)
                    .frame(width: Self.siteWidth, alignment: .leading)
                ForEach(Self.columns, id: \.self) { column in
                    Text(column)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.bottom, 4)

            VStack(spacing: 0) {
                ForEach(sites) { site in
                    row(site)
                        .contentShape(Rectangle())
                        .onTapGesture(count: 2) { onOpen(site.id) }
                        .onHover { inside in
                            guard !isPreview else { return }
                            if inside { hoveredRow = site.id } else if hoveredRow == site.id { hoveredRow = nil }
                        }
                        .help(site.glance.errorMessage ?? "Double-click to open \(site.site.name)")
                }
            }
            .animation(.easeOut(duration: 0.12), value: hoveredRow)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
        .column()
        .padding(.top, 36)
    }

    private func row(_ site: PrototypeSiteSeries) -> some View {
        let clicks = ProtoGrowth.clicks(site)
        let visits = ProtoGrowth.visits(site)
        let revenue = ProtoGrowth.revenue(site)
        let clickRun = (shape(site.days.map(\.clicks)), shape(site.previousDays.map(\.clicks)))
        let visitRun = (shape(site.days.map { $0.visits?.visits ?? 0 }), shape(site.previousDays.map { $0.visits?.visits ?? 0 }))
        let salesNow = shape((site.revenue?.days ?? []).map { $0.revenue / 100 })
        let salesWas = salesNow.isEmpty ? [] : Array(repeating: (site.revenue?.previous.revenue ?? 0) / 100 / Double(salesNow.count), count: salesNow.count)
        let share = site.registry?.indexedShare
        let first = site.coverage.first?.indexedShare
        let last = site.coverage.last?.indexedShare
        let move: Double? = if let first, let last, site.coverage.count >= 2 { (last - first) * 100 } else { nil }
        return HStack(alignment: .center, spacing: Self.spacing) {
            HStack(spacing: 8) {
                ProtoFavicon(icon: icon(site.id))
                Text(site.site.name)
                    .font(.callout)
                    .lineLimit(1)
            }
            .frame(width: Self.siteWidth, alignment: .leading)

            zone(growth: clicks, line: "\(GlanceFigure.count(clicks.current)), was \(clicks.previous.map(GlanceFigure.count) ?? "—")", absent: nil) {
                ProtoCompareChart(current: clickRun.0, previous: clickRun.1, color: Palette.blue, style: .overlay)
            }
            zone(growth: visits, line: visits.map { $0.previous == nil ? GlanceFigure.count($0.current) : "\(GlanceFigure.count($0.current)), was \(GlanceFigure.count($0.previous!))" } ?? "", absent: "No analytics") {
                ProtoCompareChart(current: visitRun.0, previous: visitRun.1, color: visitsColor, style: .overlay)
            }
            zone(growth: revenue, line: site.revenue.map { Money.format($0.current.revenue, currency: $0.currency) } ?? "", absent: "No provider") {
                ProtoCompareChart(current: salesNow, previous: salesWas, color: Palette.mint, style: .overlay, previousIsAverage: true)
            }
            // The plan's zone: the indexed share, and its move.
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(share.map { $0.formatted(.percent.precision(.fractionLength(0))) } ?? "—")
                            .font(.body)
                            .monospacedDigit()
                            .fixedSize()
                            .foregroundStyle(move.map { GlanceFigure.tint($0) } ?? .primary)
                        Text(move.map { Trend.signed($0, fractionDigits: 0) + "pp" } ?? "")
                            .font(.caption)
                            .monospacedDigit()
                            .lineLimit(1)
                            .foregroundStyle(.secondary)
                    }
                    Text(share == nil ? "No keyword pages" : "indexed, \(ProtoFunnel(targets: site.targets).steps[4].count) clicked")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Group {
                    if site.coverage.count >= 2 {
                        ProtoSparkline(values: site.coverage.map { ($0.indexedShare ?? 0) * 100 }, color: Palette.mint, fromZero: false)
                    } else {
                        Color.clear
                    }
                }
                .frame(width: Self.chartWidth, height: 28)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(height: Self.rowHeight)
        .padding(.horizontal, Self.overhang)
        .background(hoveredRow == site.id ? Palette.line.opacity(0.45) : Color.clear, in: .rect(cornerRadius: 6))
        .padding(.horizontal, -Self.overhang)
    }

    /// One source's zone: the percentage and word over the counts, the chart at the right.
    private func zone<Chart: View>(growth: ProtoGrowth?, line: String, absent: String?, @ViewBuilder chart: () -> Chart) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                // The percentage alone: its colour is the word, and a word beside it wrapped
                // the zone. A source that only started says so in the line under.
                Text(growth?.label ?? "—")
                    .font(.body)
                    .monospacedDigit()
                    .fixedSize()
                    .foregroundStyle(growth?.tint ?? .primary)
                Text(growth == nil ? (absent ?? "") : (growth?.ratio == nil && growth!.current > 0 ? "\(line), started this period" : line))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Group {
                if growth != nil {
                    chart()
                } else {
                    Color.clear
                }
            }
            .frame(width: Self.chartWidth, height: 28)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - F. Scorecard

/// One row per project, in the tab bar's order: the site, then one verdict per source —
/// the ratio in the row's colour with the word under it — and, at the end, the 26 weeks
/// of clicks as one line. One row height; every zone fixed.
struct ProtoScorecardVariant: View {
    let sites: [PrototypeSiteSeries]
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    @Environment(\.isTabPreview) private var isPreview
    @State private var hoveredRow: Site.ID?

    static let siteWidth: CGFloat = 200
    static let sparkWidth: CGFloat = 140
    static let spacing: CGFloat = 16
    static let rowHeight: CGFloat = 48
    static let columns = ["Search", "Visitors", "Sales", "Plan"]
    private static let overhang: CGFloat = 8

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: Self.spacing) {
                Text("Projects")
                    .font(.headline)
                    .frame(width: Self.siteWidth, alignment: .leading)
                ForEach(Self.columns, id: \.self) { column in
                    Text(column)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                Text("26 weeks of clicks")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: Self.sparkWidth, alignment: .trailing)
            }
            .padding(.bottom, 4)

            VStack(spacing: 0) {
                ForEach(sites) { site in
                    row(site)
                        .contentShape(Rectangle())
                        .onTapGesture(count: 2) { onOpen(site.id) }
                        .onHover { inside in
                            guard !isPreview else { return }
                            if inside { hoveredRow = site.id } else if hoveredRow == site.id { hoveredRow = nil }
                        }
                        .help(site.glance.errorMessage ?? "Double-click to open \(site.site.name)")
                }
            }
            .animation(.easeOut(duration: 0.12), value: hoveredRow)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
        .column()
        .padding(.top, 36)
    }

    private func row(_ site: PrototypeSiteSeries) -> some View {
        let weeks = ProtoWeek.weeks(site.allDays)
        let share = site.registry?.indexedShare
        let first = site.coverage.first?.indexedShare
        let last = site.coverage.last?.indexedShare
        let move: Double? = if let first, let last, site.coverage.count >= 2 { (last - first) * 100 } else { nil }
        return HStack(alignment: .center, spacing: Self.spacing) {
            HStack(spacing: 8) {
                ProtoFavicon(icon: icon(site.id))
                Text(site.site.name)
                    .font(.callout)
                    .lineLimit(1)
            }
            .frame(width: Self.siteWidth, alignment: .leading)

            ProtoVerdictCell(growth: ProtoGrowth.clicks(site), absent: nil)
            ProtoVerdictCell(growth: ProtoGrowth.visits(site), absent: "No analytics")
            ProtoVerdictCell(growth: ProtoGrowth.revenue(site), absent: "No provider")
            // The plan's cell: the indexed share, and its move since the series began.
            VStack(alignment: .trailing, spacing: 2) {
                Text(share.map { $0.formatted(.percent.precision(.fractionLength(0))) } ?? "—")
                    .font(.body)
                    .monospacedDigit()
                    .foregroundStyle(move.map { GlanceFigure.tint($0) } ?? .primary)
                Text(share == nil ? "No keyword pages" : move.map { "indexed, \(Trend.signed($0, fractionDigits: 0))pp" } ?? "indexed")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .trailing)

            ProtoSparkline(values: weeks.map(\.clicks), color: Palette.blue)
                .frame(width: Self.sparkWidth, height: 30)
        }
        .frame(height: Self.rowHeight)
        .padding(.horizontal, Self.overhang)
        .background(hoveredRow == site.id ? Palette.line.opacity(0.45) : Color.clear, in: .rect(cornerRadius: 6))
        .padding(.horizontal, -Self.overhang)
    }
}

/// One verdict: the ratio over the word. A source the site lacks is a dash over the reason.
struct ProtoVerdictCell: View {
    let growth: ProtoGrowth?
    let absent: String?

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(growth?.label ?? "—")
                .font(.body)
                .monospacedDigit()
                .foregroundStyle(growth?.tint ?? .primary)
            Text(growth?.verdict ?? absent ?? "")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

// MARK: - G. Plan

/// One card per project, two across: the registry as a funnel — planned, published,
/// indexed, reached, clicked — each step a bar against the pages planned, the count at its
/// end. The list-as-chart of the ranking cards, with the plan's steps for rows.
struct ProtoPlanVariant: View {
    let sites: [PrototypeSiteSeries]
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    var body: some View {
        VStack(spacing: 20) {
            ForEach(Array(stride(from: 0, to: sites.count, by: 2)), id: \.self) { start in
                HStack(alignment: .top, spacing: 20) {
                    ForEach(sites[start..<min(start + 2, sites.count)]) { site in
                        ProtoPlanCard(site: site, icon: icon(site.id))
                            .onTapGesture(count: 2) { onOpen(site.id) }
                            .help(site.glance.errorMessage ?? "Double-click to open \(site.site.name)")
                    }
                    if start + 1 >= sites.count {
                        Color.clear.frame(maxWidth: .infinity)
                    }
                }
            }
        }
        .column()
        .padding(.top, 36)
    }
}

struct ProtoPlanCard: View {
    let site: PrototypeSiteSeries
    let icon: Image?

    var body: some View {
        let funnel = ProtoFunnel(targets: site.targets)
        let clicks = ProtoGrowth.clicks(site)
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                ProtoCardHeader(site: site, icon: icon, showsOrigin: false)
                // The one figure beside the name: what the plan brings in, and how that moves.
                Text(GlanceFigure.count(clicks.current) + " clicks")
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                Text(clicks.label)
                    .font(.caption.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(clicks.tint ?? .secondary)
            }

            if funnel.planned == 0 {
                Text(site.registry == nil ? "No registry yet." : "No page in the registry aims at a keyword yet.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 160, alignment: .center)
            } else {
                VStack(spacing: 6) {
                    ForEach(funnel.steps) { step in
                        HStack(spacing: 12) {
                            Text(step.name)
                            Spacer(minLength: 0)
                            Text(step.count.formatted())
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(alignment: .leading) {
                            GeometryReader { geometry in
                                RoundedRectangle(cornerRadius: 6)
                                    .fill(Palette.mint.opacity(0.16))
                                    .frame(width: max(geometry.size.width * Double(step.count) / Double(funnel.planned), 6))
                            }
                        }
                        .help(step.note)
                        .accessibilityElement(children: .combine)
                    }
                }
                Text("\(funnel.planned) pages a keyword aims at; \(site.registry?.pages ?? funnel.planned) in the registry.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
        .contentShape(Rectangle())
    }
}
#endif

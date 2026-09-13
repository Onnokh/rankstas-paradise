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

/// The long run as one bar per week. The weeks inside the compared period keep the colour;
/// the ones before step back, so the eye finds the period the percentage above speaks of.
struct ProtoWeekBars: View {
    let weeks: [ProtoWeek]
    let value: (ProtoWeek) -> Double?
    let color: Color
    /// How many trailing weeks the period covers.
    let litWeeks: Int

    var body: some View {
        let points = weeks.compactMap { week in value(week).map { (week: week, value: $0) } }
        let firstLit = max(weeks.count - litWeeks, 0)
        Chart {
            RuleMark(y: .value("Value", 0))
                .foregroundStyle(Palette.line)
                .lineStyle(StrokeStyle(lineWidth: 1))
            ForEach(points, id: \.week.id) { point in
                let index = weeks.firstIndex { $0.id == point.week.id } ?? 0
                BarMark(x: .value("Week", point.week.end, unit: .weekOfYear), y: .value("Value", point.value))
                    .foregroundStyle(color.opacity(index >= firstLit ? 1 : 0.3))
                    .cornerRadius(1.5)
            }
        }
        .chartYScale(domain: .automatic(includesZero: true))
        // The axis is the whole run even when only the newest weeks have a count, so a young
        // site's three weeks stand at the right end and not as three slabs across the zone.
        .chartXScale(domain: (weeks.first?.end ?? .now).addingTimeInterval(-3.5 * 86_400)...(weeks.last?.end ?? .now).addingTimeInterval(3.5 * 86_400))
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartPlotStyle { plot in plot.padding(.top, 2) }
        .accessibilityHidden(true)
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
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    var body: some View {
        VStack(spacing: 20) {
            ForEach(sites) { site in
                ProtoTrajectoryCard(site: site, period: period, icon: icon(site.id))
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
    let icon: Image?

    private var litWeeks: Int { max(1, Int((Double(period.days) / 7).rounded(.up))) }

    var body: some View {
        let weeks = ProtoWeek.weeks(site.allDays)
        let clicks = ProtoGrowth.clicks(site)
        let visits = ProtoGrowth.visits(site)
        let revenue = ProtoGrowth.revenue(site)
        VStack(alignment: .leading, spacing: 20) {
            ProtoCardHeader(site: site, icon: icon)

            HStack(alignment: .top, spacing: 28) {
                ProtoSourceColumn(
                    title: "Search",
                    growth: clicks,
                    line: "\(GlanceFigure.count(clicks.current)) clicks" + (clicks.previous.map { ", was \(GlanceFigure.count($0))" } ?? ""),
                    absent: nil
                ) {
                    ProtoWeekBars(weeks: weeks, value: \.clicks, color: Palette.blue, litWeeks: litWeeks)
                }
                ProtoSourceColumn(
                    title: "Visitors",
                    growth: visits,
                    line: visits.map { "\(GlanceFigure.count($0.current)) visits" + ($0.previous.map { ", was \(GlanceFigure.count($0))" } ?? "") } ?? "",
                    absent: "No analytics provider"
                ) {
                    ProtoWeekBars(weeks: weeks, value: \.visits, color: visitsColor, litWeeks: litWeeks)
                }
                ProtoSourceColumn(
                    title: "Sales",
                    growth: revenue,
                    line: site.revenue.map { "\(Money.format($0.current.revenue, currency: $0.currency)), was \(Money.format($0.previous.revenue, currency: $0.currency))" } ?? "",
                    absent: "No commerce provider"
                ) {
                    // The revenue report carries only the window's days: this picture is the
                    // period, not the long run, and the caption says so.
                    ProtoMiniBars(
                        points: (site.revenue?.days ?? []).map { ProtoMiniBars.Point(day: $0.day, value: $0.revenue / 100) },
                        color: Palette.mint
                    )
                }
                planColumn
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
        .contentShape(Rectangle())
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
                        .font(.system(size: 28, weight: .medium))
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
                    .font(.system(size: 28, weight: .medium))
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
            .frame(height: 48)
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
    @ViewBuilder let picture: () -> Picture

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            if let growth {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(growth.label)
                        .font(.system(size: 28, weight: .medium))
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
                    .frame(height: 48)
                    .padding(.top, 6)
            } else {
                Text("—")
                    .font(.system(size: 28, weight: .medium))
                Text(absent ?? "")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                ProtoNoPicture(text: "")
                    .frame(height: 48)
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

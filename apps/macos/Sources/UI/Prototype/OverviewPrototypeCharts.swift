#if DEBUG
import Charts
import SwiftUI

// PROTOTYPE — throwaway. Not for main.
//
// The site dashboard's charts, copied so the prototype can size them and take their hover
// away: the trend chart at any height, the day bars for any metric, a sparkline for a row,
// and a stacked chart with one band per site.

// MARK: - Trend

/// Impressions and clicks over the period as gradient areas on one value axis: the site
/// dashboard's chart. `labelInset` is the room the end dates keep from the plot's edges — the
/// column inset when the plot is the pane, none inside a card. Hover is a rule, two points and
/// a tooltip, and only where `interactive` says so.
struct ProtoTrendChart: View {
    let days: [HistoryReportDay]
    var height: CGFloat = 240
    var labelInset: CGFloat = SiteTabScreen.columnInset
    var interactive = true

    @Environment(\.isTabPreview) private var isPreview
    @State private var hovered: HistoryReportDay?

    private static let impressionsColor = Palette.amber
    private static let clicksColor = Palette.blue

    var body: some View {
        if days.count >= 2 {
            VStack(spacing: 6) {
                chart
                HStack {
                    Text(days.first!.day, format: .dateTime.day().month(.abbreviated))
                    Spacer()
                    Text(days.last!.day, format: .dateTime.day().month(.abbreviated))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, labelInset)
            }
        } else {
            Text("Not enough days yet.")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: height, alignment: .center)
        }
    }

    private var finalized: [HistoryReportDay] { days.filter { !$0.provisional } }

    private var provisional: [HistoryReportDay] {
        guard let first = days.firstIndex(where: \.provisional) else { return [] }
        return Array(days[max(first - 1, 0)...])
    }

    private var tickStride: Int {
        days.count <= 31 ? 1 : days.count <= 100 ? 3 : 7
    }

    private var chart: some View {
        Chart {
            series(finalized, suffix: "", opacity: 1)
            series(provisional, suffix: " (provisional)", opacity: 0.45)

            if let hovered {
                RuleMark(x: .value("Date", hovered.day))
                    .foregroundStyle(.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .annotation(
                        position: .top,
                        alignment: .leading,
                        spacing: 10,
                        overflowResolution: .init(x: .fit(to: .chart), y: .disabled)
                    ) {
                        ProtoDayTooltip(day: hovered)
                    }
                PointMark(x: .value("Date", hovered.day), y: .value("Impressions", hovered.impressions))
                    .foregroundStyle(Self.impressionsColor)
                    .symbolSize(70)
                PointMark(x: .value("Date", hovered.day), y: .value("Clicks", hovered.clicks))
                    .foregroundStyle(Self.clicksColor)
                    .symbolSize(70)
            }
        }
        .chartForegroundStyleScale(["Impressions": Self.impressionsColor, "Clicks": Self.clicksColor])
        .chartLegend(.hidden)
        .chartYScale(domain: .automatic(includesZero: true))
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
        .chartPlotStyle { plot in
            plot.padding(.top, 8)
        }
        .chartOverlay { proxy in
            if interactive, !isPreview {
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
        .frame(height: height)
    }

    @ChartContentBuilder
    private func series(_ run: [HistoryReportDay], suffix: String, opacity: Double) -> some ChartContent {
        ForEach(run) { point in
            AreaMark(
                x: .value("Date", point.day),
                y: .value("Impressions", point.impressions),
                series: .value("Series", "Impressions" + suffix),
                stacking: .unstacked
            )
            .foregroundStyle(Self.gradient(Self.impressionsColor).opacity(opacity))

            LineMark(
                x: .value("Date", point.day),
                y: .value("Impressions", point.impressions),
                series: .value("Series", "Impressions" + suffix)
            )
            .foregroundStyle(Self.impressionsColor.opacity(opacity))
            .lineStyle(StrokeStyle(lineWidth: 1.5, lineJoin: .round))

            AreaMark(
                x: .value("Date", point.day),
                y: .value("Clicks", point.clicks),
                series: .value("Series", "Clicks" + suffix),
                stacking: .unstacked
            )
            .foregroundStyle(Self.gradient(Self.clicksColor).opacity(opacity))

            LineMark(
                x: .value("Date", point.day),
                y: .value("Clicks", point.clicks),
                series: .value("Series", "Clicks" + suffix)
            )
            .foregroundStyle(Self.clicksColor.opacity(opacity))
            .lineStyle(StrokeStyle(lineWidth: 1.5, lineJoin: .round))
        }
        .interpolationMethod(.monotone)
    }

    private func day(at location: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) -> HistoryReportDay? {
        guard let plotFrame = proxy.plotFrame else { return nil }
        let origin = geometry[plotFrame].origin
        guard let date: Date = proxy.value(atX: location.x - origin.x) else { return nil }
        return days.min { abs($0.day.timeIntervalSince(date)) < abs($1.day.timeIntervalSince(date)) }
    }

    private static func gradient(_ color: Color) -> LinearGradient {
        LinearGradient(colors: [color.opacity(0.28), color.opacity(0.02)], startPoint: .top, endPoint: .bottom)
    }
}

/// One day's figures, over the whole fleet or one site.
struct ProtoDayTooltip: View {
    let day: HistoryReportDay

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(day.day.formatted(.dateTime.day().month(.abbreviated)))
                .font(.callout.weight(.semibold))
            Text("Impressions : \(GlanceFigure.count(day.impressions))")
            Text("Clicks : \(GlanceFigure.count(day.clicks))")
            Text("CTR : \(GlanceFigure.rate(day.ctr))")
            Text("Position : \(GlanceFigure.position(day.position))")
            if let visits = day.visits {
                Text("Visits : \(GlanceFigure.count(visits.visits))")
            }
            if day.provisional {
                Text("Provisional")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.callout)
        .monospacedDigit()
        .padding(12)
        .background(.regularMaterial, in: .rect(cornerRadius: 8))
    }
}

// MARK: - Day bars

/// One bar per day for one metric: the Visits card's chart, for any series. Days without a
/// value are left out rather than drawn as zero.
struct ProtoDayBars: View {
    let days: [HistoryReportDay]
    let metric: PrototypeMetric
    var height: CGFloat = 96

    @Environment(\.isTabPreview) private var isPreview
    @State private var hovered: HistoryReportDay?
    @State private var hoverX: CGFloat = 0

    private var points: [HistoryReportDay] {
        metric == .visits ? days.filter { $0.visits != nil } : days
    }

    var body: some View {
        let points = points
        if points.count >= 2 {
            VStack(spacing: 6) {
                Chart {
                    RuleMark(y: .value(metric.label, 0))
                        .foregroundStyle(Palette.line)
                        .lineStyle(StrokeStyle(lineWidth: 1))

                    ForEach(points) { point in
                        BarMark(
                            x: .value("Date", point.day, unit: .day),
                            y: .value(metric.label, metric.value(point))
                        )
                        .foregroundStyle(metric.color.opacity(hovered == nil || hovered == point ? 1 : 0.4))
                        .cornerRadius(2)
                    }

                    if let hovered {
                        RuleMark(x: .value("Date", hovered.day))
                            .foregroundStyle(.secondary.opacity(0.6))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    }
                }
                .chartYScale(domain: .automatic(includesZero: true))
                .chartYAxis(.hidden)
                .chartXAxis(.hidden)
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
                                        hovered = day(at: location, points: points, proxy: proxy, geometry: geometry)
                                        if let hovered,
                                           let plotFrame = proxy.plotFrame,
                                           let x = proxy.position(forX: hovered.day) {
                                            hoverX = geometry[plotFrame].origin.x + x
                                        }
                                    case .ended:
                                        hovered = nil
                                    }
                                }
                        }
                    }
                }
                .frame(height: height)
                .overlay(alignment: .topLeading) {
                    GeometryReader { geometry in
                        ProtoDayTooltip(day: hovered ?? points[points.count - 1])
                            .fixedSize()
                            .alignmentGuide(.leading) { label in
                                -min(max(hoverX - label.width / 2, 0), max(geometry.size.width - label.width, 0))
                            }
                            .alignmentGuide(.top) { label in label.height + 8 }
                            .opacity(hovered == nil ? 0 : 1)
                    }
                    .allowsHitTesting(false)
                }

                HStack {
                    Text(points.first!.day, format: .dateTime.day().month(.abbreviated))
                    Spacer()
                    Text(points.last!.day, format: .dateTime.day().month(.abbreviated))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        } else {
            Text("Not enough days of \(metric.label.lowercased()) yet.")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: height, alignment: .center)
        }
    }

    private func day(at location: CGPoint, points: [HistoryReportDay], proxy: ChartProxy, geometry: GeometryProxy) -> HistoryReportDay? {
        guard let plotFrame = proxy.plotFrame else { return nil }
        let origin = geometry[plotFrame].origin
        guard let date: Date = proxy.value(atX: location.x - origin.x) else { return nil }
        return points.min { abs($0.day.timeIntervalSince(date)) < abs($1.day.timeIntervalSince(date)) }
    }
}

// MARK: - Sparkline

/// The period as one small line with a faint area under it, no axes, no hover: a row's own
/// picture of its clicks. Flat when every day is zero, so an empty site still draws its zone.
struct ProtoSparkline: View {
    let values: [Double]
    let color: Color

    var body: some View {
        Chart {
            ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                AreaMark(x: .value("Day", index), y: .value("Value", value))
                    .foregroundStyle(
                        LinearGradient(colors: [color.opacity(0.28), color.opacity(0.02)], startPoint: .top, endPoint: .bottom)
                    )
                LineMark(x: .value("Day", index), y: .value("Value", value))
                    .foregroundStyle(color)
                    .lineStyle(StrokeStyle(lineWidth: 1.25, lineJoin: .round))
            }
            .interpolationMethod(.monotone)
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartYScale(domain: .automatic(includesZero: true))
        .chartPlotStyle { plot in
            plot.padding(.vertical, 2)
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Stacked

/// One metric over the period, every site a band on the same stack: the height is the
/// fleet's total, each band a site's share. Bands are the metric's one colour at stepped
/// strengths, the strongest site at the bottom in full. Hover lists the day per site.
struct ProtoStackedChart: View {
    /// Strongest first: the first site is the bottom band.
    let sites: [PrototypeSiteSeries]
    let metric: PrototypeMetric
    var height: CGFloat = 260

    @Environment(\.isTabPreview) private var isPreview
    @State private var hoveredDate: String?

    /// The strength each band is drawn at, by its place in the order.
    static func opacity(rank: Int) -> Double {
        max(0.7 - Double(rank) * 0.18, 0.16)
    }

    private var dates: [String] {
        Array(Set(sites.flatMap { $0.days.map(\.date) })).sorted()
    }

    var body: some View {
        Chart {
            ForEach(sites) { site in
                ForEach(site.days) { day in
                    AreaMark(
                        x: .value("Date", day.day),
                        y: .value(metric.label, metric.value(day)),
                        series: .value("Site", site.site.name),
                        stacking: .standard
                    )
                    .foregroundStyle(by: .value("Site", site.site.name))
                }
                .interpolationMethod(.monotone)
            }

            if let hoveredDate, let date = ISODay.date(hoveredDate) {
                RuleMark(x: .value("Date", date.addingTimeInterval(12 * 3600)))
                    .foregroundStyle(.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .annotation(
                        position: .top,
                        alignment: .leading,
                        spacing: 10,
                        overflowResolution: .init(x: .fit(to: .chart), y: .disabled)
                    ) {
                        tooltip(for: hoveredDate)
                    }
            }
        }
        .chartForegroundStyleScale(
            domain: sites.map(\.site.name),
            range: sites.indices.map { metric.color.opacity(Self.opacity(rank: $0)) }
        )
        .chartLegend(.hidden)
        .chartYScale(domain: .automatic(includesZero: true))
        .chartYAxis {
            AxisMarks(values: [0]) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 1))
                    .foregroundStyle(Palette.line)
            }
        }
        .chartXAxis {
            AxisMarks(values: .stride(by: .day, count: dates.count <= 31 ? 1 : dates.count <= 100 ? 3 : 7)) { _ in
                AxisTick(centered: false, length: 2, stroke: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .foregroundStyle(Palette.line)
            }
        }
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
                                hoveredDate = date(at: location, proxy: proxy, geometry: geometry)
                            case .ended:
                                hoveredDate = nil
                            }
                        }
                }
            }
        }
        .frame(height: height)
    }

    private func tooltip(for date: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text((ISODay.date(date) ?? .now).formatted(.dateTime.day().month(.abbreviated)))
                .font(.callout.weight(.semibold))
            ForEach(sites) { site in
                let value = site.days.first { $0.date == date }.map { metric.value($0) } ?? 0
                Text("\(site.site.name) : \(GlanceFigure.count(value))")
            }
        }
        .font(.callout)
        .monospacedDigit()
        .padding(12)
        .background(.regularMaterial, in: .rect(cornerRadius: 8))
    }

    private func date(at location: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) -> String? {
        guard let plotFrame = proxy.plotFrame else { return nil }
        let origin = geometry[plotFrame].origin
        guard let pointer: Date = proxy.value(atX: location.x - origin.x) else { return nil }
        return dates.min {
            abs((ISODay.date($0) ?? .distantPast).timeIntervalSince(pointer)) < abs((ISODay.date($1) ?? .distantPast).timeIntervalSince(pointer))
        }
    }
}
#endif

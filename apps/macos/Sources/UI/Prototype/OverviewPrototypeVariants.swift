#if DEBUG
import SwiftUI

// PROTOTYPE — throwaway. Not for main.
//
// The four bodies. Each is what sits between the strip and the footer; the header and the
// strip are the page's own and never change between variants.

// MARK: - A. Dashboard

/// The site dashboard's skeleton, for the fleet: the chart edge to edge, then the visits card
/// beside the sites as bars, then the rows for the figures per site.
struct ProtoDashboardVariant: View {
    let sites: [PrototypeSiteSeries]
    let total: [HistoryReportDay]
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    var body: some View {
        let rows = sites.map(\.glance)

        ProtoTrendChart(days: total)
            .padding(.top, 36)

        HStack(alignment: .top, spacing: 20) {
            ProtoVisitsCard(days: total, comparison: OverviewGlance.totalVisits(rows))
            ProtoSitesBarsCard(sites: sites, icon: icon, onOpen: onOpen)
        }
        .column()
        .padding(.top, 36)

        SitesCard(rows: rows, icon: icon, onOpen: onOpen)
            .column()
            .padding(.top, 20)
    }
}

/// The fleet's visits, one bar per day, with the period's total and its move in the title:
/// the site dashboard's Visits card over every site.
struct ProtoVisitsCard: View {
    let days: [HistoryReportDay]
    let comparison: VisitsComparison?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Visits")
                    .font(.headline)
                Spacer()
                if let comparison {
                    Text(GlanceFigure.count(comparison.current))
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                    if let trend = comparison.trend {
                        Text(Trend.signed(trend.delta, fractionDigits: 0))
                            .font(.caption.weight(.medium))
                            .monospacedDigit()
                            .foregroundStyle(GlanceFigure.tint(trend.delta))
                    }
                }
            }

            ProtoDayBars(days: days, metric: .visits)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
    }
}

/// The sites ranked by one metric, each row a bar as long as its share of the strongest: the
/// ranking cards' list-as-chart, with the sites for rows. The word switch picks the metric
/// and the bars take its colour. Double-click opens the site.
struct ProtoSitesBarsCard: View {
    let sites: [PrototypeSiteSeries]
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    @State private var metric = PrototypeMetric.clicks

    private var options: [PrototypeMetric] {
        sites.contains { $0.glance.visits != nil } ? PrototypeMetric.allCases : [.clicks, .impressions]
    }

    private var chosen: PrototypeMetric { options.contains(metric) ? metric : .clicks }

    var body: some View {
        let chosen = chosen
        let ranked = sites.sorted { $0.total(chosen) > $1.total(chosen) }
        let strongest = max(ranked.map { $0.total(chosen) }.max() ?? 1, 1)
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Text("Sites")
                    .font(.headline)
                Spacer()
                WordSwitch(options: options, selection: $metric, label: \.label, font: .subheadline)
                    .accessibilityLabel("Rank by")
            }

            VStack(spacing: 6) {
                ForEach(ranked) { site in
                    let value = site.total(chosen)
                    HStack(spacing: 10) {
                        ProtoFavicon(icon: icon(site.id))
                        Text(site.site.name)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        Text(GlanceFigure.count(value))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(alignment: .leading) {
                        GeometryReader { geometry in
                            RoundedRectangle(cornerRadius: 6)
                                .fill(chosen.color.opacity(0.16))
                                .frame(width: max(geometry.size.width * (value / strongest), 6))
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2) { onOpen(site.id) }
                    .help("Double-click to open \(site.site.name)")
                }
            }
            .animation(.snappy(duration: 0.25), value: chosen)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
    }
}

/// A site's mark at row size, with the globe for a site whose icon has not landed.
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

// MARK: - B. Cards

/// What a site card says, in four groups. Each group is four lines — a label, a figure, its
/// move — and one small picture. Built once per card from the series, so both layouts say
/// the same thing.
enum ProtoGroups {
    struct Line: Identifiable {
        let label: String
        let value: String
        var change: String? = nil
        var tint: Color? = nil
        var id: String { label }
    }

    /// Search Console and Ahrefs: what Google shows and how strong the domain is.
    static func search(_ site: PrototypeSiteSeries) -> [Line] {
        let comparison = site.glance.comparison
        let stats = comparison.currentStats
        return [
            Line(label: "Clicks", value: GlanceFigure.count(stats.clicks),
                 change: comparison.clicks.map { Trend.signed($0.delta, fractionDigits: 0) },
                 tint: comparison.clicks.map { GlanceFigure.tint($0.delta) }),
            Line(label: "Impressions", value: GlanceFigure.count(stats.impressions),
                 change: comparison.impressions.map { Trend.signed($0.delta, fractionDigits: 0) },
                 tint: comparison.impressions.map { GlanceFigure.tint($0.delta) }),
            Line(label: "CTR", value: GlanceFigure.rate(stats.ctr),
                 change: comparison.ctrPointsDelta.map { Trend.signed($0, fractionDigits: 1) + "pp" },
                 tint: comparison.ctrPointsDelta.map { GlanceFigure.tint($0) }),
            Line(label: "Domain Rating", value: site.rating.map { $0.current.formatted(.number.precision(.fractionLength(1))) } ?? "—",
                 change: site.rating?.delta.map { Trend.signed($0, fractionDigits: 1) },
                 tint: site.rating?.delta.map { GlanceFigure.tint($0) }),
        ]
    }

    /// The analytics provider: the people. Visits sum over the period; visitors do not, so
    /// they are given a day; pages a visit is the one ratio the schema allows.
    static func visitors(_ site: PrototypeSiteSeries) -> [Line] {
        func sum(_ days: [HistoryReportDay], _ key: KeyPath<VisitsDay, Double>) -> Double? {
            let counted = days.compactMap(\.visits)
            return counted.isEmpty ? nil : counted.reduce(0) { $0 + $1[keyPath: key] }
        }
        func perDay(_ days: [HistoryReportDay], _ key: KeyPath<VisitsDay, Double>) -> Double? {
            let counted = days.compactMap(\.visits)
            return counted.isEmpty ? nil : counted.reduce(0) { $0 + $1[keyPath: key] } / Double(counted.count)
        }
        func move(_ current: Double?, _ previous: Double?, digits: Int = 0) -> (String?, Color?) {
            guard let current, let previous else { return (nil, nil) }
            let delta = current - previous
            // A move that rounds to nothing is no move: "−0,0" is a line that says less than a blank.
            guard abs(delta) >= 0.5 / pow(10, Double(digits)) else { return (nil, nil) }
            return (Trend.signed(delta, fractionDigits: digits), GlanceFigure.tint(delta))
        }
        let visits = sum(site.days, \.visits), previousVisits = sum(site.previousDays, \.visits)
        let pageviews = sum(site.days, \.pageviews), previousPageviews = sum(site.previousDays, \.pageviews)
        let visitorsPerDay = perDay(site.days, \.visitors), previousVisitorsPerDay = perDay(site.previousDays, \.visitors)
        let pagesPerVisit = visits.flatMap { v in pageviews.map { v > 0 ? $0 / v : 0 } }
        let previousPagesPerVisit = previousVisits.flatMap { v in previousPageviews.map { v > 0 ? $0 / v : 0 } }
        let visitsMove = move(visits, previousVisits)
        let pageviewsMove = move(pageviews, previousPageviews)
        let visitorsMove = move(visitorsPerDay, previousVisitorsPerDay)
        let pagesMove = move(pagesPerVisit, previousPagesPerVisit, digits: 1)
        return [
            Line(label: "Visits", value: visits.map(GlanceFigure.count) ?? "—", change: visitsMove.0, tint: visitsMove.1),
            Line(label: "Visitors a day", value: visitorsPerDay.map(GlanceFigure.count) ?? "—", change: visitorsMove.0, tint: visitorsMove.1),
            Line(label: "Pageviews", value: pageviews.map(GlanceFigure.count) ?? "—", change: pageviewsMove.0, tint: pageviewsMove.1),
            Line(label: "Pages a visit", value: pagesPerVisit.map { $0.formatted(.number.precision(.fractionLength(1))) } ?? "—",
                 change: pagesMove.0, tint: pagesMove.1),
        ]
    }

    /// A money move in whole units, so it fits the move's slot: "+€ 1.451".
    static func signedMoney(_ minorUnits: Double, currency: String?) -> String {
        let units = abs(minorUnits) / 100
        let figure = currency.map { units.formatted(.currency(code: $0).precision(.fractionLength(0))) }
            ?? units.formatted(.number.precision(.fractionLength(0)))
        return (minorUnits < 0 ? "−" : "+") + figure
    }

    /// The commerce provider, for a site that sells. Amounts in the report's currency.
    static func sales(_ site: PrototypeSiteSeries) -> [Line]? {
        guard let report = site.revenue, report.revenue != nil else { return nil }
        let currency = report.currency
        let orders = report.current.orders
        let average = orders > 0 ? report.current.revenue / orders : 0
        let previousAverage = report.previous.orders > 0 ? report.previous.revenue / report.previous.orders : nil
        return [
            Line(label: "Revenue", value: Money.format(report.current.revenue, currency: currency),
                 change: signedMoney(report.delta.revenue, currency: currency), tint: GlanceFigure.tint(report.delta.revenue)),
            Line(label: "Orders", value: GlanceFigure.count(orders),
                 change: Trend.signed(report.delta.orders, fractionDigits: 0), tint: GlanceFigure.tint(report.delta.orders)),
            Line(label: "Net", value: Money.format(report.current.net, currency: currency),
                 change: signedMoney(report.delta.net, currency: currency), tint: GlanceFigure.tint(report.delta.net)),
            Line(label: "Order value", value: Money.format(average, currency: currency),
                 change: previousAverage.map { signedMoney(average - $0, currency: currency) },
                 tint: previousAverage.map { GlanceFigure.tint(average - $0) }),
        ]
    }

    /// Ranksta's own: the plan. Indexing is measured over the keyword pages, as on the
    /// registry screen; the volume is the plan's addressable market, not a forecast.
    static func registry(_ site: PrototypeSiteSeries) -> [Line] {
        let totals = site.registry
        let share = totals?.indexedShare
        let latest = site.coverage.last?.indexedShare
        let earliest = site.coverage.first?.indexedShare
        let shareMove: Double? = if let latest, let earliest, site.coverage.count >= 2 { (latest - earliest) * 100 } else { nil }
        return [
            Line(label: "Pages", value: totals.map { $0.pages.formatted() } ?? "—"),
            Line(label: "Indexed", value: share.map { $0.formatted(.percent.precision(.fractionLength(0))) } ?? "—",
                 change: shareMove.map { Trend.signed($0, fractionDigits: 0) + "pp" },
                 tint: shareMove.map { GlanceFigure.tint($0) }),
            Line(label: "Not indexed", value: totals.map { $0.notIndexed.formatted() } ?? "—",
                 change: totals.flatMap { $0.unknown > 0 ? "\($0.unknown) open" : nil }),
            Line(label: "Volume", value: site.monthlyVolume.map { GlanceFigure.count($0) + "/mo" } ?? "—"),
        ]
    }
}

/// One group inside a site card: its name, its lines and its picture. `columns` is how many
/// lines share a row — one in the wide card, two in the narrow one.
struct ProtoGroup<Picture: View>: View {
    let title: String
    let lines: [ProtoGroups.Line]
    var columns = 1
    var pictureHeight: CGFloat = 44
    @ViewBuilder let picture: () -> Picture

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)

            VStack(spacing: 4) {
                ForEach(Array(stride(from: 0, to: lines.count, by: columns)), id: \.self) { start in
                    HStack(spacing: 20) {
                        ForEach(lines[start..<min(start + columns, lines.count)]) { line in
                            ProtoGroupLine(line: line)
                        }
                        if start + columns > lines.count {
                            Color.clear.frame(maxWidth: .infinity)
                        }
                    }
                }
            }

            picture()
                .frame(height: pictureHeight)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

/// One line of a group: the label leading, the figure trailing with its move in a slot of
/// its own, so the figures of every line end on the same line. One row height.
struct ProtoGroupLine: View {
    let line: ProtoGroups.Line

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(line.label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 6)
            Text(line.value)
                .font(.callout)
                .monospacedDigit()
                .lineLimit(1)
            Text(line.change ?? "")
                .font(.caption)
                .monospacedDigit()
                .lineLimit(1)
                .foregroundStyle(line.tint ?? .secondary)
                .frame(width: 56, alignment: .leading)
        }
        .frame(height: 20)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// The four pictures, one per group, all silent: the trend for Search, day bars for
/// Visitors and Sales, the indexing series or the index band for Registry.
enum ProtoPictures {
    @ViewBuilder
    static func search(_ site: PrototypeSiteSeries, height: CGFloat) -> some View {
        ProtoTrendChart(days: site.days, height: height, labelInset: 0, interactive: false, showsDates: false)
    }

    @ViewBuilder
    static func visitors(_ site: PrototypeSiteSeries) -> some View {
        let points = site.days.compactMap { day in day.visits.map { ProtoMiniBars.Point(day: day.day, value: $0.visits) } }
        if points.count >= 2 {
            ProtoMiniBars(points: points, color: visitsColor)
        } else {
            ProtoNoPicture(text: "No analytics")
        }
    }

    @ViewBuilder
    static func sales(_ site: PrototypeSiteSeries) -> some View {
        let points = (site.revenue?.days ?? []).map { ProtoMiniBars.Point(day: $0.day, value: $0.revenue / 100) }
        if points.count >= 2 {
            ProtoMiniBars(points: points, color: Palette.mint)
        } else {
            ProtoNoPicture(text: site.sells ? "No sales yet" : "No commerce provider")
        }
    }

    @ViewBuilder
    static func registry(_ site: PrototypeSiteSeries) -> some View {
        if site.coverage.count >= 2 {
            ProtoSparkline(values: site.coverage.map { ($0.indexedShare ?? 0) * 100 }, color: Palette.mint, fromZero: false)
        } else if let totals = site.registry {
            VStack {
                Spacer()
                ProtoIndexBand(totals: totals)
                Spacer()
            }
        } else {
            ProtoNoPicture(text: "No registry")
        }
    }
}

/// The picture's zone when there is nothing to draw in it: the reason, small and centred,
/// over the baseline the chart would have had.
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

/// The card's first line: the site's mark and name, its origin, and at the trailing edge
/// what it made over the period when it sells — the one figure worth the header.
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

// MARK: B1. Wide cards

/// One card per site, the full column: the header, then the four groups side by side, each
/// a column of four lines over its picture. Every card has the same four columns, so a site
/// that does not sell keeps the Sales column and says why.
struct ProtoWideCardsVariant: View {
    let sites: [PrototypeSiteSeries]
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    var body: some View {
        VStack(spacing: 20) {
            ForEach(sites) { site in
                ProtoWideCard(site: site, icon: icon(site.id))
                    .onTapGesture(count: 2) { onOpen(site.id) }
                    .help(site.glance.errorMessage ?? "Double-click to open \(site.site.name)")
            }
        }
        .column()
        .padding(.top, 36)
    }
}

struct ProtoWideCard: View {
    let site: PrototypeSiteSeries
    let icon: Image?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ProtoCardHeader(site: site, icon: icon)

            HStack(alignment: .top, spacing: 28) {
                ProtoGroup(title: "Search", lines: ProtoGroups.search(site)) {
                    ProtoPictures.search(site, height: 44)
                }
                ProtoGroup(title: "Visitors", lines: ProtoGroups.visitors(site)) {
                    ProtoPictures.visitors(site)
                }
                ProtoGroup(title: "Sales", lines: ProtoGroups.sales(site) ?? Self.noSales) {
                    ProtoPictures.sales(site)
                }
                ProtoGroup(title: "Registry", lines: ProtoGroups.registry(site)) {
                    ProtoPictures.registry(site)
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
        .contentShape(Rectangle())
    }

    /// A site without a commerce provider keeps the column and its four lines, as dashes.
    static let noSales = ["Revenue", "Orders", "Net", "Order value"].map { ProtoGroups.Line(label: $0, value: "—") }
}

// MARK: B2. Cards two across

/// Two cards to a row, the four groups stacked inside each, the lines two to a row. A site
/// that does not sell has no Sales group; the card is shorter for it.
struct ProtoCardsVariant: View {
    let sites: [PrototypeSiteSeries]
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    var body: some View {
        VStack(spacing: 20) {
            ForEach(Array(stride(from: 0, to: sites.count, by: 2)), id: \.self) { start in
                HStack(alignment: .top, spacing: 20) {
                    ForEach(sites[start..<min(start + 2, sites.count)]) { site in
                        ProtoSiteCard(site: site, icon: icon(site.id))
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

struct ProtoSiteCard: View {
    let site: PrototypeSiteSeries
    let icon: Image?

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            ProtoCardHeader(site: site, icon: icon, showsOrigin: false)

            ProtoGroup(title: "Search", lines: ProtoGroups.search(site), columns: 2, pictureHeight: 56) {
                ProtoPictures.search(site, height: 56)
            }
            ProtoGroup(title: "Visitors", lines: ProtoGroups.visitors(site), columns: 2, pictureHeight: 40) {
                ProtoPictures.visitors(site)
            }
            if let sales = ProtoGroups.sales(site) {
                ProtoGroup(title: "Sales", lines: sales, columns: 2, pictureHeight: 40) {
                    ProtoPictures.sales(site)
                }
            }
            ProtoGroup(title: "Registry", lines: ProtoGroups.registry(site), columns: 2, pictureHeight: 40) {
                ProtoPictures.registry(site)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
        .contentShape(Rectangle())
    }
}

// MARK: - C. Sparklines

/// The fleet's chart, then the rows with a zone for the period's clicks as a line.
struct ProtoSparklinesVariant: View {
    let sites: [PrototypeSiteSeries]
    let total: [HistoryReportDay]
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    var body: some View {
        ProtoTrendChart(days: total)
            .padding(.top, 36)

        ProtoSparklineSitesCard(sites: sites, icon: icon, onOpen: onOpen)
            .column()
            .padding(.top, 36)
    }
}

/// The shipped Sites card, with one more fixed zone after the site: its clicks by day as a
/// line, in the clicks colour. Everything else keeps its place.
struct ProtoSparklineSitesCard: View {
    let sites: [PrototypeSiteSeries]
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    @Environment(\.isTabPreview) private var isPreview
    @State private var hoveredRow: Site.ID?

    // The sparkline's room comes out of the site zone, the gaps and the move slot, so the
    // five figures keep the width the shipped rows give them.
    static let siteWidth: CGFloat = 152
    static let sparkWidth: CGFloat = 88
    static let spacing: CGFloat = 12
    static let columns = ["Clicks", "Impressions", "CTR", "Position", "Visits"]
    private static let overhang: CGFloat = 8

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: Self.spacing) {
                Text("Sites")
                    .font(.headline)
                    .frame(width: Self.siteWidth, alignment: .leading)
                Text("Clicks by day")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: Self.sparkWidth, alignment: .leading)
                ForEach(Self.columns, id: \.self) { column in
                    Text(column)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .trailing)
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
                            if inside {
                                hoveredRow = site.id
                            } else if hoveredRow == site.id {
                                hoveredRow = nil
                            }
                        }
                        .help(site.glance.errorMessage ?? "Double-click to open \(site.site.name)")
                }
            }
            .animation(.easeOut(duration: 0.12), value: hoveredRow)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
    }

    private func row(_ site: PrototypeSiteSeries) -> some View {
        let comparison = site.glance.comparison
        let stats = comparison.currentStats
        return HStack(alignment: .center, spacing: Self.spacing) {
            HStack(spacing: 8) {
                ProtoFavicon(icon: icon(site.id))
                Text(site.site.name)
                    .font(.callout)
                    .lineLimit(1)
            }
            .frame(width: Self.siteWidth, alignment: .leading)

            ProtoSparkline(values: site.days.map(\.clicks), color: Palette.blue)
                .frame(width: Self.sparkWidth, height: 26)

            ProtoFigure(
                value: GlanceFigure.count(stats.clicks),
                change: comparison.clicks.map { Trend.signed($0.delta, fractionDigits: 0) },
                tint: comparison.clicks.map { GlanceFigure.tint($0.delta) }
            )
            ProtoFigure(
                value: GlanceFigure.count(stats.impressions),
                change: comparison.impressions.map { Trend.signed($0.delta, fractionDigits: 0) },
                tint: comparison.impressions.map { GlanceFigure.tint($0.delta) }
            )
            ProtoFigure(
                value: GlanceFigure.rate(stats.ctr),
                change: comparison.ctrPointsDelta.map { Trend.signed($0, fractionDigits: 1) + "pp" },
                tint: comparison.ctrPointsDelta.map { GlanceFigure.tint($0) }
            )
            ProtoFigure(
                value: GlanceFigure.position(stats.position),
                change: comparison.positionDelta.map { Trend.signed($0, fractionDigits: 1) },
                tint: comparison.positionDelta.map { GlanceFigure.tint($0, lowerIsBetter: true) }
            )
            ProtoFigure(
                value: site.glance.visits.map { GlanceFigure.count($0.current) } ?? "—",
                change: site.glance.visits?.trend.map { Trend.signed($0.delta, fractionDigits: 0) },
                tint: site.glance.visits?.trend.map { GlanceFigure.tint($0.delta) }
            )
        }
        .frame(height: SiteGlanceRow.height)
        .padding(.horizontal, Self.overhang)
        .background(hoveredRow == site.id ? Palette.line.opacity(0.45) : Color.clear, in: .rect(cornerRadius: 6))
        .padding(.horizontal, -Self.overhang)
    }
}

/// `Figure` with a narrower slot for the move, and never a second line.
struct ProtoFigure: View {
    let value: String
    let change: String?
    let tint: Color?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(value)
                .font(.body)
                .monospacedDigit()
                .lineLimit(1)
            Text(change ?? "")
                .font(.caption)
                .monospacedDigit()
                .lineLimit(1)
                .foregroundStyle(tint ?? .secondary)
                .frame(width: 44, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

// MARK: - D. Stacked

/// One chart edge to edge, each site a band of the metric's colour, the metric switched in
/// the line above it and the sites named in the line below, strongest first. The rows follow.
struct ProtoStackedVariant: View {
    let sites: [PrototypeSiteSeries]
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    @State private var metric = PrototypeMetric.clicks

    private var options: [PrototypeMetric] {
        sites.contains { $0.glance.visits != nil } ? PrototypeMetric.allCases : [.clicks, .impressions]
    }

    private var chosen: PrototypeMetric { options.contains(metric) ? metric : .clicks }

    var body: some View {
        let chosen = chosen
        let ordered = sites.sorted { $0.total(chosen) > $1.total(chosen) }

        HStack(spacing: 12) {
            Text("By site")
                .font(.headline)
            Spacer()
            WordSwitch(options: options, selection: $metric, label: \.label, font: .subheadline)
                .accessibilityLabel("Metric")
        }
        .column()
        .padding(.top, 36)

        ProtoStackedChart(sites: ordered, metric: chosen)
            .padding(.top, 16)

        // The legend, as a line of the page: a swatch at the band's strength, the site, and
        // its period total. Double-click opens the site.
        HStack(spacing: 24) {
            ForEach(Array(ordered.enumerated()), id: \.element.id) { rank, site in
                HStack(spacing: 8) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(chosen.color.opacity(ProtoStackedChart.opacity(rank: rank)))
                        .frame(width: 10, height: 10)
                    ProtoFavicon(icon: icon(site.id), size: 14)
                    Text(site.site.name)
                        .font(.callout)
                    Text(GlanceFigure.count(site.total(chosen)))
                        .font(.callout)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
                .onTapGesture(count: 2) { onOpen(site.id) }
            }
            Spacer()
        }
        .column()
        .padding(.top, 10)
        .animation(.snappy(duration: 0.25), value: chosen)

        SitesCard(rows: sites.map(\.glance), icon: icon, onOpen: onOpen)
            .column()
            .padding(.top, 36)
    }
}
#endif

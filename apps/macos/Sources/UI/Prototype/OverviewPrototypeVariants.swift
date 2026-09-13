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

/// One small dashboard per site, two across: the site's name, its four figures with their
/// moves, and its own chart. Double-click opens the site.
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
        let comparison = site.glance.comparison
        let stats = comparison.currentStats
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 8) {
                ProtoFavicon(icon: icon)
                Text(site.site.name)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
            }

            // The site's own strip, at a card's scale. Justified like the page's.
            HStack(alignment: .top, spacing: 0) {
                ProtoMiniMetric(
                    title: "Clicks",
                    value: GlanceFigure.count(stats.clicks),
                    change: comparison.clicks.map { Trend.signed($0.delta, fractionDigits: 0) },
                    tint: comparison.clicks.map { GlanceFigure.tint($0.delta) },
                    dot: Palette.blue
                )
                Spacer(minLength: 12)
                ProtoMiniMetric(
                    title: "Impressions",
                    value: GlanceFigure.count(stats.impressions),
                    change: comparison.impressions.map { Trend.signed($0.delta, fractionDigits: 0) },
                    tint: comparison.impressions.map { GlanceFigure.tint($0.delta) },
                    dot: Palette.amber
                )
                Spacer(minLength: 12)
                ProtoMiniMetric(
                    title: "Position",
                    value: GlanceFigure.position(stats.position),
                    change: comparison.positionDelta.map { Trend.signed($0, fractionDigits: 1) },
                    tint: comparison.positionDelta.map { GlanceFigure.tint($0, lowerIsBetter: true) }
                )
                Spacer(minLength: 12)
                ProtoMiniMetric(
                    title: "Visits",
                    value: site.glance.visits.map { GlanceFigure.count($0.current) } ?? "—",
                    change: site.glance.visits?.trend.map { Trend.signed($0.delta, fractionDigits: 0) },
                    tint: site.glance.visits?.trend.map { GlanceFigure.tint($0.delta) },
                    dot: site.glance.visits == nil ? nil : visitsColor
                )
            }

            ProtoTrendChart(days: site.days, height: 120, labelInset: 0, interactive: false)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
        .contentShape(Rectangle())
    }
}

/// `Metric` at two thirds: the label at caption, the figure at 20 points, the move beside it.
struct ProtoMiniMetric: View {
    let title: String
    let value: String
    var change: String? = nil
    var tint: Color? = nil
    var dot: Color? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if let dot {
                    Circle().fill(dot).frame(width: 5, height: 5)
                }
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(value)
                    .font(.system(size: 20, weight: .medium))
                    .monospacedDigit()
                if let change {
                    Text(change)
                        .font(.caption.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(tint ?? .secondary)
                }
            }
        }
        .fixedSize()
        .accessibilityElement(children: .combine)
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

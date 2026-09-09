// PROTOTYPE — throwaway. Four takes on the overview's Sites card as tiles, shown in place of
// the real card in debug builds and switched from the floating bar at the bottom or with ← →.
//
// Question: the tile format won; what can a tile hold and still be scannable from across the
// room when the window is left open? Each variant answers with a different tile: the hero
// number over a heat strip; the same with the live feed ticking inside it; today's twenty-four
// hours as the picture; and a wide board row. Nothing here is production code.

#if DEBUG
import Charts
import Observation
import SwiftUI

// MARK: - Variant switching

@MainActor
@Observable
final class PrototypeVariantStore {
    static let shared = PrototypeVariantStore()
    static let names = ["C — Pulse tiles", "D — Pulse + live ticker", "E — Day tiles", "F — Board rows"]
    var index = 0

    func step(_ delta: Int) {
        index = (index + delta + Self.names.count) % Self.names.count
    }
}

/// The floating bar: obviously not part of the design being judged.
struct PrototypeSwitcher: View {
    @State private var store = PrototypeVariantStore.shared

    var body: some View {
        HStack(spacing: 14) {
            Button { store.step(-1) } label: { Image(systemName: "chevron.left") }
                .keyboardShortcut(.leftArrow, modifiers: [])
            Text(PrototypeVariantStore.names[store.index])
                .font(.callout.weight(.semibold))
                .monospacedDigit()
                .frame(minWidth: 220)
            Button { store.step(1) } label: { Image(systemName: "chevron.right") }
                .keyboardShortcut(.rightArrow, modifiers: [])
        }
        .buttonStyle(.plain)
        .foregroundStyle(.black)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Palette.acid, in: .capsule)
        .shadow(color: .black.opacity(0.4), radius: 12, y: 4)
        .padding(.bottom, 20)
    }
}

// MARK: - Shared inputs

/// Everything a tile knows about one site. Built once by the switcher.
struct PrototypeSite: Identifiable {
    let overview: SiteOverview
    let live: LiveVisitors?
    let today: TodayVisits?
    let icon: Image?
    let isSelected: Bool
    /// The newest few things visitors did, newest first.
    let latest: [LiveFeedRow]

    var id: Site.ID { overview.id }
    var name: String { overview.site.name }
    var online: Double { live?.onlineNow ?? 0 }
    var lit: Bool { online > 0 }
    var bars: [Double] { live?.bars ?? Array(repeating: 0, count: 30) }
    var window: Int { live?.windowMinutes ?? 30 }
    var visits: Double { today?.site?.visits ?? 0 }
    var pageviews: Double { today?.site?.pageviews ?? 0 }
    var events: Double { today?.eventCount ?? 0 }
    var hours: [VisitsHour] { today?.hours ?? [] }
    var hoursElapsed: Int { today?.hoursElapsed ?? 0 }
    /// Minutes since the newest bar with someone in it; nil when the window is empty.
    var quietFor: Int? {
        guard let last = bars.lastIndex(where: { $0 > 0 }) else { return nil }
        return bars.count - 1 - last
    }
}

struct SitesPrototype: View {
    let overviews: [SiteOverview]
    let live: LiveStore
    let favicons: FaviconStore
    let selection: Site.ID?
    let onSelect: (Site.ID) -> Void
    let onOpen: (Site.ID) -> Void

    @State private var store = PrototypeVariantStore.shared

    private var sites: [PrototypeSite] {
        overviews
            .map { overview in
                let events = (live.feeds[overview.id]?.events ?? [])
                    .sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
                    .prefix(3)
                    .map { LiveFeedRow(siteID: overview.id, siteName: overview.site.name, event: $0) }
                return PrototypeSite(
                    overview: overview,
                    live: live.reports[overview.id]?.live,
                    today: live.todays[overview.id]?.today,
                    icon: favicons.image(for: overview.id),
                    isSelected: overview.id == selection,
                    latest: events
                )
            }
            .sorted { $0.online != $1.online ? $0.online > $1.online : $0.name < $1.name }
    }

    var body: some View {
        Group {
            switch store.index {
            case 0: TileGrid(sites: sites) { site, hero in PulseTile(site: site, hero: hero) }
            case 1: TileGrid(sites: sites) { site, hero in TickerTile(site: site, hero: hero) }
            case 2: TileGrid(sites: sites) { site, hero in DayTile(site: site, hero: hero) }
            default: BoardRows(sites: sites)
            }
        }
        .environment(\.tileClicks, TileClicks(onSelect: onSelect, onOpen: onOpen))
        .column()
    }
}

private struct TileClicks {
    var onSelect: (Site.ID) -> Void = { _ in }
    var onOpen: (Site.ID) -> Void = { _ in }
}

private extension EnvironmentValues {
    @Entry var tileClicks = TileClicks()
}

private func n(_ value: Double) -> String {
    value.formatted(.number.precision(.fractionLength(0)))
}

/// One wide tile, two side by side, three or more in a grid. The hero size follows.
private struct TileGrid<Tile: View>: View {
    let sites: [PrototypeSite]
    @ViewBuilder let tile: (PrototypeSite, CGFloat) -> Tile

    var body: some View {
        switch sites.count {
        case 1:
            tile(sites[0], 72)
        case 2:
            HStack(alignment: .top, spacing: 16) {
                ForEach(sites) { tile($0, 56) }
            }
        default:
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 16)], alignment: .leading, spacing: 16) {
                ForEach(sites) { tile($0, 44) }
            }
        }
    }
}

/// The tile's skin: raised when quiet, lilac-lit when someone is there; a heavier border
/// when it is the selected site. Click selects, double-click opens the tab.
private struct TileSkin: ViewModifier {
    let site: PrototypeSite
    @Environment(\.tileClicks) private var clicks

    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(site.lit ? visitsColor.opacity(0.08) : Palette.raised, in: .rect(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(site.lit ? visitsColor.opacity(0.35) : Palette.line, lineWidth: site.isSelected ? 2 : 1)
            )
            .animation(.snappy(duration: 0.3), value: site.lit)
            .contentShape(Rectangle())
            .onTapGesture(count: 2) { clicks.onOpen(site.id) }
            .onTapGesture { clicks.onSelect(site.id) }
    }
}

private struct TileName: View {
    let site: PrototypeSite
    var trailing: String? = nil
    var body: some View {
        HStack(spacing: 8) {
            Group {
                if let icon = site.icon {
                    icon.resizable().interpolation(.high).scaledToFit().clipShape(.rect(cornerRadius: 4))
                } else {
                    Image(systemName: "globe").foregroundStyle(.secondary)
                }
            }
            .frame(width: 16, height: 16)
            Text(site.name).font(.subheadline.weight(.medium))
            Spacer()
            if let trailing {
                Text(trailing).font(.subheadline).foregroundStyle(.secondary).monospacedDigit()
            }
        }
    }
}

/// The online count, big, lilac while someone is there.
private struct Hero: View {
    let site: PrototypeSite
    let size: CGFloat
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(n(site.online))
                .font(.system(size: size, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(site.lit ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.tertiary))
                .contentTransition(.numericText())
            Text("online").foregroundStyle(.secondary)
        }
    }
}

/// One cell per minute, oldest left; the deeper the lilac, the more people that minute.
private struct HeatStrip: View {
    let bars: [Double]
    var body: some View {
        let peak = max(bars.max() ?? 1, 1)
        HStack(spacing: 3) {
            ForEach(Array(bars.enumerated()), id: \.offset) { _, value in
                RoundedRectangle(cornerRadius: 2)
                    .fill(value > 0 ? visitsColor.opacity(0.35 + 0.65 * value / peak) : Palette.line)
            }
        }
        .animation(.snappy(duration: 0.3), value: bars)
    }
}

// MARK: - C. Pulse tiles

private struct PulseTile: View {
    let site: PrototypeSite
    let hero: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            TileName(site: site, trailing: "\(n(site.visits)) today")
            Hero(site: site, size: hero)
            HeatStrip(bars: site.bars)
                .frame(height: hero > 50 ? 14 : 10)
        }
        .padding(20)
        .modifier(TileSkin(site: site))
    }
}

// MARK: - D. Pulse + live ticker

/// The pulse tile with the half hour as a soft area bleeding across the tile's floor, a ring
/// that breathes round the number while someone is there, and the newest three things
/// visitors did ticking under it — so a glance says not just "someone is here" but where.
private struct TickerTile: View {
    let site: PrototypeSite
    let hero: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            TileName(site: site, trailing: "\(n(site.visits)) visits · \(n(site.events)) events")

            HStack(alignment: .center, spacing: 16) {
                Pulse(active: site.lit, size: hero * 0.5)
                Hero(site: site, size: hero)
                Spacer()
                if let quiet = site.quietFor, !site.lit {
                    Text(quiet == 0 ? "just now" : "quiet for \(quiet) min")
                        .font(.caption).foregroundStyle(.tertiary)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                if site.latest.isEmpty {
                    Text("Nothing in the last \(site.window) minutes")
                        .font(.caption).foregroundStyle(.tertiary)
                } else {
                    ForEach(site.latest.prefix(hero > 50 ? 3 : 2)) { row in
                        HStack(spacing: 8) {
                            Image(systemName: row.event.kind.symbol)
                                .font(.caption2)
                                .foregroundStyle(row.event.kind == .pageview ? AnyShapeStyle(.secondary) : AnyShapeStyle(visitsColor))
                                .frame(width: 12)
                            Text(row.primary).lineLimit(1)
                            Spacer(minLength: 8)
                            Text(row.event.country.map(LiveFeedRow.place) ?? "")
                            Text(row.time.prefix(5)).foregroundStyle(.tertiary).monospacedDigit()
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(20)
        .padding(.bottom, 40)
        .background(alignment: .bottom) {
            MinuteArea(bars: site.bars, tint: visitsColor)
                .frame(height: 64)
                .clipShape(.rect(cornerRadius: 12))
                .allowsHitTesting(false)
        }
        .modifier(TileSkin(site: site))
    }
}

/// A breathing ring: two circles, the outer one swelling and fading on a loop while active.
/// Cheap enough for four tiles; a fleet of forty would want the repeat replaced by a
/// single pulse per new visitor.
private struct Pulse: View {
    let active: Bool
    let size: CGFloat
    @State private var swell = false

    var body: some View {
        ZStack {
            Circle()
                .stroke(visitsColor.opacity(active ? 0.5 : 0), lineWidth: 1.5)
                .scaleEffect(swell ? 1.9 : 1)
                .opacity(swell ? 0 : 1)
            Circle()
                .fill(active ? visitsColor : Palette.line)
                .frame(width: size * 0.42, height: size * 0.42)
        }
        .frame(width: size, height: size)
        .onAppear { swell = true }
        .animation(active ? .easeOut(duration: 1.8).repeatForever(autoreverses: false) : .default, value: swell)
    }
}

private struct MinuteArea: View {
    let bars: [Double]
    let tint: Color
    var body: some View {
        Chart {
            ForEach(Array(bars.enumerated()), id: \.offset) { minute, value in
                AreaMark(x: .value("Minute", minute), y: .value("People", value))
                    .foregroundStyle(LinearGradient(colors: [tint.opacity(0.35), tint.opacity(0.0)], startPoint: .top, endPoint: .bottom))
                LineMark(x: .value("Minute", minute), y: .value("People", value))
                    .foregroundStyle(tint.opacity(0.8))
                    .lineStyle(StrokeStyle(lineWidth: 1.5, lineJoin: .round))
            }
            .interpolationMethod(.monotone)
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartYScale(domain: 0...max(bars.max() ?? 1, 1))
        .chartXScale(domain: 0...max(bars.count - 1, 1))
        .chartPlotStyle { $0.padding(0) }
        .animation(.snappy(duration: 0.3), value: bars)
    }
}

// MARK: - E. Day tiles

/// The tile on today's scale: twenty-four hour bars fill it, the hours still to come dimmed
/// and the running hour lit, with the half hour as a thin heat strip above. Says "how is the
/// day going" rather than "is someone here this minute".
private struct DayTile: View {
    let site: PrototypeSite
    let hero: CGFloat

    private var peakHour: VisitsHour? {
        site.hours.prefix(site.hoursElapsed).max { $0.visits < $1.visits }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            TileName(site: site, trailing: site.today?.date ?? "")

            HStack(alignment: .lastTextBaseline, spacing: 24) {
                Hero(site: site, size: hero)
                VStack(alignment: .leading, spacing: 2) {
                    Text(n(site.visits)).font(.title3.weight(.semibold)).monospacedDigit()
                    Text("visits today").font(.caption).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(n(site.events)).font(.title3.weight(.semibold)).monospacedDigit()
                    Text("events").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }

            HeatStrip(bars: site.bars).frame(height: 6)

            hoursChart.frame(height: hero > 50 ? 96 : 56)

            HStack {
                Text("00:00")
                Spacer()
                if let peakHour, peakHour.visits > 0 {
                    Text("peak \(String(format: "%02d", peakHour.hour)):00 · \(n(peakHour.visits))")
                }
                Spacer()
                Text("24:00")
            }
            .font(.caption).foregroundStyle(.tertiary).monospacedDigit()
        }
        .padding(20)
        .modifier(TileSkin(site: site))
    }

    private var hoursChart: some View {
        let peak = max(site.hours.map(\.visits).max() ?? 1, 1)
        return HStack(alignment: .bottom, spacing: 3) {
            ForEach(site.hours) { hour in
                let elapsed = hour.hour < site.hoursElapsed
                let running = hour.hour == site.hoursElapsed - 1
                RoundedRectangle(cornerRadius: 2)
                    .fill(
                        !elapsed ? Palette.line.opacity(0.4)
                            : running ? visitsColor
                            : hour.visits > 0 ? visitsColor.opacity(0.45) : Palette.line
                    )
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .frame(height: hour.visits > 0 ? nil : 4)
                    .scaleEffect(y: hour.visits > 0 ? max(hour.visits / peak, 0.06) : 1, anchor: .bottom)
            }
        }
        .animation(.snappy(duration: 0.3), value: site.hours.map(\.visits))
    }
}

// MARK: - F. Board rows

/// Every site as one wide row of a departures board: the number huge on the left, the half
/// hour as a tall barcode filling the middle, the newest event on the right. Stacks whatever
/// the count, so it suits a tall window kept open beside other work.
private struct BoardRows: View {
    let sites: [PrototypeSite]

    var body: some View {
        VStack(spacing: 12) {
            ForEach(sites) { site in
                BoardRow(site: site, hero: sites.count == 1 ? 88 : 64)
            }
        }
    }
}

private struct BoardRow: View {
    let site: PrototypeSite
    let hero: CGFloat

    var body: some View {
        HStack(alignment: .center, spacing: 24) {
            Text(n(site.online))
                .font(.system(size: hero, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(site.lit ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.tertiary))
                .contentTransition(.numericText())
                .frame(width: hero * 1.4, alignment: .trailing)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Group {
                        if let icon = site.icon {
                            icon.resizable().interpolation(.high).scaledToFit().clipShape(.rect(cornerRadius: 4))
                        } else {
                            Image(systemName: "globe").foregroundStyle(.secondary)
                        }
                    }
                    .frame(width: 18, height: 18)
                    Text(site.name).font(.title3.weight(.semibold))
                }
                Text("\(n(site.visits)) visits · \(n(site.events)) events today")
                    .font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            .frame(width: 190, alignment: .leading)

            HeatStrip(bars: site.bars)
                .frame(height: hero * 0.45)

            VStack(alignment: .trailing, spacing: 4) {
                if let row = site.latest.first {
                    Text(row.primary).lineLimit(1).font(.callout)
                    Text([row.event.country.map(LiveFeedRow.place), row.time.prefix(5).description].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.tertiary).monospacedDigit()
                } else {
                    Text("—").foregroundStyle(.tertiary)
                }
            }
            .frame(width: 200, alignment: .trailing)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .modifier(TileSkin(site: site))
    }
}
#endif

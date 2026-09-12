import SwiftUI

// PROTOTYPE — throwaway. Not for main.
//
// Question: the Overview's Feed is a log — one row per Live event, newest first. What else
// could show what people are doing on the sites right now?
//
// The log has three known weaknesses, all visible in one screenshot of a busy half hour:
// one person reloading a shader page fills twenty rows; two product actions sit buried
// among them; and nothing in the shape says which rows belong to the same person, which
// page is under pressure, or where anyone is going next.
//
// Six shapes of the same half hour, switchable from the floating bar at the bottom of the
// window (⌘⌥← / ⌘⌥→), in the Feed card's own slot on the Overview, with real data. The
// shipped log is kept in the cycle as the baseline.
//
//   Current — the log, one row per Live event (as shipped)
//   A — Visits: one row per person, their path through the site with dwell between steps
//   B — Lanes: the half hour as a time axis, one lane per person, a tick per Live event
//   C — Pressure: no time axis — the window's pages as tiles, sized by load, per site
//   D — Paths: page to page, as a flow, with the walks that were actually taken
//   E — Signals: actions first and large, page loads demoted to a pulse under them
//
// Every variant reads `FeedShapes`, built once per poll. None of them formats a string.

// MARK: - Variant

/// Which shape the Overview's Feed card is drawn in. Held once, in the environment;
/// remembered across launches so a variant can be judged after a restart.
@MainActor
@Observable
final class FeedPrototype {
    enum Variant: String, CaseIterable, Identifiable {
        case current, visits, lanes, pressure, paths, signals

        var id: String { rawValue }

        var key: String {
            switch self {
            case .current: "Current"
            case .visits: "A"
            case .lanes: "B"
            case .pressure: "C"
            case .paths: "D"
            case .signals: "E"
            }
        }

        var name: String {
            switch self {
            case .current: "The log, one row per event (as shipped)"
            case .visits: "Visits: one row per person, with their path"
            case .lanes: "Lanes: the half hour as time, one lane per person"
            case .pressure: "Pressure: the window's pages as tiles, per site"
            case .paths: "Paths: page to page, as a flow"
            case .signals: "Signals: actions first, page loads as a pulse"
            }
        }

        /// The card's own title, where the shipped card says "Feed".
        var title: String {
            switch self {
            case .current: "Feed"
            case .visits: "Visits"
            case .lanes: "Lanes"
            case .pressure: "Pressure"
            case .paths: "Paths"
            case .signals: "Signals"
            }
        }
    }

    private static let defaultsKey = "prototype.feed.variant"

    var variant: Variant {
        didSet { UserDefaults.standard.set(variant.rawValue, forKey: Self.defaultsKey) }
    }

    init() {
        let stored = UserDefaults.standard.string(forKey: Self.defaultsKey)
        variant = stored.flatMap(Variant.init(rawValue:)) ?? .current
    }

    func cycle(_ step: Int) {
        let all = Variant.allCases
        let index = all.firstIndex(of: variant) ?? 0
        let count = all.count
        variant = all[((index + step) % count + count) % count]
    }
}

// MARK: - Host

/// Draws the Feed card in the chosen variant. Without a prototype in the environment it is
/// exactly the shipped `FeedCard`.
struct FeedPrototypeHost: View {
    let rows: [LiveFeedRow]
    let shapes: FeedShapes
    let showsSite: Bool
    @Binding var kinds: FeedKinds
    let windowMinutes: Int
    let waiting: Bool
    let now: Date

    @Environment(FeedPrototype.self) private var prototype: FeedPrototype?

    var body: some View {
        switch prototype?.variant ?? .current {
        case .current:
            FeedCard(
                rows: rows,
                showsSite: showsSite,
                kinds: $kinds,
                windowMinutes: windowMinutes,
                waiting: waiting,
                now: now
            )
        case .visits:
            FeedVariantCard(title: "Visits", note: note, isEmpty: shapes.isEmpty) {
                FeedVisitsVariant(shapes: shapes, showsSite: showsSite)
            }
        case .lanes:
            FeedVariantCard(title: "Lanes", note: note, isEmpty: shapes.isEmpty) {
                FeedLanesVariant(shapes: shapes, showsSite: showsSite)
            }
        case .pressure:
            FeedVariantCard(title: "Pressure", note: note, isEmpty: shapes.isEmpty) {
                FeedPressureVariant(shapes: shapes)
            }
        case .paths:
            FeedVariantCard(title: "Paths", note: note, isEmpty: shapes.isEmpty) {
                FeedPathsVariant(shapes: shapes)
            }
        case .signals:
            FeedVariantCard(title: "Signals", note: note, isEmpty: shapes.isEmpty) {
                FeedSignalsVariant(shapes: shapes, showsSite: showsSite)
            }
        }
    }

    /// What the card says about the window, in the header's trailing place.
    private var note: String {
        let people = shapes.visits.count
        return "\(people) \(people == 1 ? "person" : "people") · \(shapes.eventCount) events · last \(shapes.windowMinutes)m"
    }
}

/// The shell every variant sits in: the card surface, a title, a word about the window, and
/// the empty state. Only the shell is shared — each variant is free to throw out the layout.
struct FeedVariantCard<Content: View>: View {
    let title: String
    let note: String
    let isEmpty: Bool
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 16) {
                Text(title)
                    .font(.headline)
                Spacer()
                Text(note)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }

            if isEmpty {
                Text("Nothing in the window yet.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 96, alignment: .center)
            } else {
                content
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
    }
}

// MARK: - Switcher

/// The floating bar that flips variants. Obviously not part of the design being judged.
struct FeedPrototypeSwitcher: View {
    let prototype: FeedPrototype

    var body: some View {
        HStack(spacing: 12) {
            Text("PROTOTYPE")
                .font(.caption2.weight(.heavy))
                .tracking(1)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.black, in: .rect(cornerRadius: 3))
                .foregroundStyle(.yellow)

            Button { prototype.cycle(-1) } label: {
                Image(systemName: "chevron.left")
            }
            .keyboardShortcut(.leftArrow, modifiers: [.command, .option])

            Text("\(prototype.variant.key) — \(prototype.variant.name)")
                .font(.callout.weight(.semibold))
                .frame(minWidth: 340)

            Button { prototype.cycle(1) } label: {
                Image(systemName: "chevron.right")
            }
            .keyboardShortcut(.rightArrow, modifiers: [.command, .option])

            Text("⌘⌥← ⌘⌥→")
                .font(.caption)
                .opacity(0.6)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: .capsule)
        .overlay(Capsule().strokeBorder(.separator))
        .shadow(color: .black.opacity(0.35), radius: 12, y: 4)
        .fixedSize()
    }
}

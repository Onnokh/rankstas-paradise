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
//
// Round four — the table stripped: one row height, greys only, no icons, flags, pills or tints:
//
//   Q — Quiet: the log's rows, stripped
//   R — Quiet path: one row per person, their path as the row's words
//   S — Quiet per site: R's rows, one column per site
//   T — Hierarchy: two lines per person — what now, then one caption with everything else
//   U — One line: T on one line, the caption right-anchored in its own zone
//
// Round three — the log kept, one thing changed each (the log was still the clearest):
//
//   J — Grouped: one person's rows folded into a block, repeats counted
//   O — Trail: J, calmed — the person's newest step as the shipped row, the rest one dim line
//   P — Folded: one shipped row per person, "+3" for the folded steps, click to lay them out
//   K — Temperature: the same rows, cooling with age; a row that just landed flashes
//   L — Per site: one newest-first column per site, so one site's flood stays in its lane
//   M — Transcript: the blocks of J read as a chat, the flag for a face
//   N — Head: the log untouched, with the window's actions pinned above it
//
// Round two — shapes that move, drawn from the clock rather than from the poll:
//
//   F — Pulse: the sites as rooms, the people in them as points of light that ring and fade
//   G — Trace: one instrument trace per site, running right to left under a "now" edge
//   H — Now: only the people here this minute, one tile each, cooling as they go quiet
//   I — Stage: one moment at a time, in words, large, fading to the next
//
// Round one — arrangements of records, kept for the parts worth stealing:
//
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
        // Declaration order is the order the floating bar cycles through.
        case current
        case hierarchy, oneLine, quiet, quietPath, quietPerSite
        case grouped, trail, folded, temperature, perSite, transcript, head
        case pulse, trace, now, stage
        case visits, lanes, pressure, paths, signals

        var id: String { rawValue }

        var key: String {
            switch self {
            case .current: "Current"
            case .hierarchy: "T"
            case .oneLine: "U"
            case .quiet: "Q"
            case .quietPath: "R"
            case .quietPerSite: "S"
            case .grouped: "J"
            case .trail: "O"
            case .folded: "P"
            case .temperature: "K"
            case .perSite: "L"
            case .transcript: "M"
            case .head: "N"
            case .pulse: "F"
            case .trace: "G"
            case .now: "H"
            case .stage: "I"
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
            case .hierarchy: "Hierarchy: what now, then one caption for the rest"
            case .oneLine: "One line: T on one line, caption right-anchored"
            case .quiet: "Quiet: the log, stripped to type"
            case .quietPath: "Quiet path: one line per person, the path as the line"
            case .quietPerSite: "Quiet per site: one line per person, one column per site"
            case .grouped: "Grouped: one person's rows as one block"
            case .trail: "Trail: one row per person, their path as one dim line"
            case .folded: "Folded: one row per person, click for the path"
            case .temperature: "Temperature: the log, cooling with age, flashing on arrival"
            case .perSite: "Per site: one log column per site"
            case .transcript: "Transcript: the blocks read as a chat"
            case .head: "Head: the log untouched, actions pinned above"
            case .pulse: "Pulse: the sites as rooms, people as light"
            case .trace: "Trace: an instrument line per site, running to now"
            case .now: "Now: only the people here this minute"
            case .stage: "Stage: one moment at a time, in words"
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
            case .hierarchy, .oneLine, .quiet, .quietPath, .quietPerSite: "Feed"
            case .grouped, .trail, .folded, .temperature, .perSite, .transcript, .head: "Feed"
            case .pulse: "Pulse"
            case .trace: "Trace"
            case .now: "Now"
            case .stage: "Stage"
            case .visits: "Visits"
            case .lanes: "Lanes"
            case .pressure: "Pressure"
            case .paths: "Paths"
            case .signals: "Signals"
            }
        }
    }

    /// Whether the Overview is the tab in front. The moving variants pause when it is not:
    /// every tab stays mounted, so an animation schedule left running in a tab nobody can
    /// see is a frame paid for nothing, for as long as the app is open.
    ///
    /// Held here rather than in the environment on purpose. An environment value flipping on
    /// a tab switch re-evaluates every mounted screen on the one frame that has to be cheap;
    /// observation reaches only the one view that reads this.
    var isLive = true

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
    /// A site's favicon, for the variants that lead a row with its site.
    var icon: (Site.ID) -> Image? = { _ in nil }

    @Environment(FeedPrototype.self) private var prototype: FeedPrototype?
    @Environment(\.isTabPreview) private var isPreview

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
        case .hierarchy:
            logCard { FeedHierarchyVariant(rows: rows, showsSite: showsSite, now: now, icon: icon) }
        case .oneLine:
            logCard { FeedOneLineVariant(rows: rows, showsSite: showsSite, now: now, icon: icon) }
        case .quiet:
            logCard { FeedQuietVariant(rows: rows, showsSite: showsSite, now: now) }
        case .quietPath:
            logCard { FeedQuietPathVariant(rows: rows, showsSite: showsSite, now: now) }
        case .quietPerSite:
            logCard { FeedQuietPerSiteVariant(rows: rows, shapes: shapes, now: now) }
        case .grouped:
            logCard { FeedGroupedVariant(rows: rows, showsSite: showsSite, now: now) }
        case .trail:
            logCard { FeedTrailVariant(rows: rows, showsSite: showsSite, now: now) }
        case .folded:
            logCard { FeedFoldedVariant(rows: rows, showsSite: showsSite, now: now) }
        case .temperature:
            logCard { FeedTemperatureVariant(rows: rows, showsSite: showsSite, now: now, isLive: isLive) }
        case .perSite:
            logCard { FeedPerSiteVariant(rows: rows, shapes: shapes, now: now) }
        case .transcript:
            logCard { FeedTranscriptVariant(rows: rows, showsSite: showsSite, now: now) }
        case .head:
            logCard { FeedHeadVariant(rows: rows, shapes: shapes, showsSite: showsSite, now: now) }
        case .pulse:
            FeedVariantCard(title: "Pulse", note: note, isEmpty: shapes.isEmpty) {
                FeedPulseVariant(shapes: shapes, isLive: isLive)
            }
        case .trace:
            FeedVariantCard(title: "Trace", note: note, isEmpty: shapes.isEmpty) {
                FeedTraceVariant(shapes: shapes, isLive: isLive)
            }
        case .now:
            FeedVariantCard(title: "Now", note: note, isEmpty: shapes.isEmpty) {
                FeedNowVariant(shapes: shapes, isLive: isLive)
            }
        case .stage:
            FeedVariantCard(title: "Stage", note: note, isEmpty: shapes.isEmpty) {
                FeedStageVariant(shapes: shapes, isLive: isLive)
            }
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

    /// The shipped Feed header around a round-three body: the kind switch still works, and
    /// the empty states are the log's own.
    private func logCard<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        FeedLogCard(title: "Feed", kinds: $kinds, isEmpty: rows.isEmpty, windowMinutes: windowMinutes, waiting: waiting, content: content)
    }

    /// Whether the moving variants may run: the Overview is in front, and this is not a
    /// still of a tab.
    private var isLive: Bool { (prototype?.isLive ?? true) && !isPreview }

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

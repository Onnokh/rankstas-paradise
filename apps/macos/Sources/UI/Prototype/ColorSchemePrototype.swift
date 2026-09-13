import AppKit
import SwiftUI

// PROTOTYPE — throwaway. Not for main.
//
// Question: which dark colour scheme should the Mac app wear?
//
// Eight schemes, switchable from the floating bar at the bottom of the window (⌘⌥← / ⌘⌥→),
// on the real window with real data. `Palette` reads its surfaces, hairline, accent and
// text from the scheme under trial, so every screen follows without being touched. The
// shipped scheme is kept in the cycle as the baseline. The light side is not under trial:
// every scheme keeps the shipped paper-side values there.
//
//   Current — as shipped: the guide's surfaces, the system's text
//   A — Guide, to the letter: the shipped surfaces with the guide's paper for text
//   B — Pitch: pure black canvas, neutral greys, no blue in the neutrals
//   C — Graphite: lifted and soft, the way Xcode and Finder do dark
//   D — Midnight: the guide's layering, pulled cool toward navy
//   E — Ember: the guide's layering, pulled warm toward umber
//   F — Sunk pane: the layers inverted — chrome lighter than the pane it frames
//   G — Paper accent: the guide, with the acid headband swapped for paper

/// One scheme: the four neutrals, the accent, and the text colour that replaces the
/// system's label colour (nil keeps the system's).
struct PrototypeScheme: Equatable, Sendable {
    let void: UInt32
    let panel: UInt32
    let raised: UInt32
    let line: UInt32
    let accent: UInt32
    let text: UInt32?

    static let current = PrototypeScheme(
        void: 0x08090A, panel: 0x15181D, raised: 0x1C2026, line: 0x292E36, accent: 0xC4FA04, text: nil
    )
}

@MainActor
@Observable
final class SchemePrototype {
    enum Variant: String, CaseIterable, Identifiable {
        case current, guide, pitch, graphite, midnight, ember, sunk, paper

        var id: String { rawValue }

        var key: String {
            switch self {
            case .current: "Current"
            case .guide: "A"
            case .pitch: "B"
            case .graphite: "C"
            case .midnight: "D"
            case .ember: "E"
            case .sunk: "F"
            case .paper: "G"
            }
        }

        var name: String {
            switch self {
            case .current: "As shipped"
            case .guide: "Guide, to the letter"
            case .pitch: "Pitch — pure black, neutral greys"
            case .graphite: "Graphite — lifted and soft"
            case .midnight: "Midnight — cool, toward navy"
            case .ember: "Ember — warm, toward umber"
            case .sunk: "Sunk pane — chrome lighter than pane"
            case .paper: "Paper accent — no acid"
            }
        }

        var scheme: PrototypeScheme {
            switch self {
            case .current:
                .current
            case .guide:
                PrototypeScheme(void: 0x08090A, panel: 0x15181D, raised: 0x1C2026, line: 0x292E36, accent: 0xC4FA04, text: 0xF7F8F8)
            case .pitch:
                PrototypeScheme(void: 0x000000, panel: 0x0C0C0C, raised: 0x171717, line: 0x262626, accent: 0xC4FA04, text: 0xEDEDED)
            case .graphite:
                PrototypeScheme(void: 0x1A1A1C, panel: 0x232326, raised: 0x2C2C30, line: 0x3A3A3F, accent: 0xC4FA04, text: 0xE4E4E7)
            case .midnight:
                PrototypeScheme(void: 0x070B14, panel: 0x0E1524, raised: 0x162034, line: 0x243047, accent: 0xC4FA04, text: 0xE3E8F2)
            case .ember:
                PrototypeScheme(void: 0x0E0B09, panel: 0x191412, raised: 0x231D1A, line: 0x332A25, accent: 0xC4FA04, text: 0xF3ECE4)
            case .sunk:
                PrototypeScheme(void: 0x1C2026, panel: 0x08090A, raised: 0x15181D, line: 0x292E36, accent: 0xC4FA04, text: 0xF7F8F8)
            case .paper:
                PrototypeScheme(void: 0x08090A, panel: 0x15181D, raised: 0x1C2026, line: 0x292E36, accent: 0xF7F8F8, text: 0xF7F8F8)
            }
        }
    }

    /// The scheme `Palette` reads. A global rather than an environment value, because the
    /// palette is a set of static colours read from 120 places; the root view remounts its
    /// tree when this changes, so every one of those reads happens again.
    nonisolated(unsafe) static var current: PrototypeScheme = .current

    static let defaultsKey = "prototype.colorScheme.variant"

    var variant: Variant {
        didSet {
            Self.current = variant.scheme
            UserDefaults.standard.set(variant.rawValue, forKey: Self.defaultsKey)
        }
    }

    init() {
        let stored = UserDefaults.standard.string(forKey: Self.defaultsKey)
        variant = stored.flatMap(Variant.init(rawValue:)) ?? .current
        Self.current = variant.scheme
    }

    func cycle(_ step: Int) {
        let all = Variant.allCases
        let index = all.firstIndex(of: variant) ?? 0
        let count = all.count
        variant = all[((index + step) % count + count) % count]
    }

    /// The text colour the window's tree is given. `.primary`, `.secondary` and `.tertiary`
    /// are hierarchical: they take the tree's foreground style and step its opacity down,
    /// so one colour at the root moves every label. `.foreground` inherits the system's.
    var textStyle: AnyShapeStyle {
        guard let text = variant.scheme.text else { return AnyShapeStyle(.foreground) }
        return AnyShapeStyle(Color(nsColor: Palette.srgb(text)))
    }
}

/// The floating bar. Debug builds only; see `RootView`.
struct PrototypeSchemeSwitcher: View {
    let prototype: SchemePrototype

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
                .frame(minWidth: 300)

            Button { prototype.cycle(1) } label: {
                Image(systemName: "chevron.right")
            }
            .keyboardShortcut(.rightArrow, modifiers: [.command, .option])

            Text("⌘⌥← ⌘⌥→")
                .font(.caption)
                .opacity(0.6)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.black)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(.yellow, in: .capsule)
        .overlay(Capsule().strokeBorder(.black.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
        .animation(.snappy(duration: 0.2), value: prototype.variant)
    }
}

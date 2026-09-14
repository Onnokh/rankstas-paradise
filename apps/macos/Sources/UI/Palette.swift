import AppKit
import SwiftUI

/// The app's palette, by the interface style guide's names.
///
/// The identity colours are the guide's own. The dark surfaces are not: the guide's blue-grey
/// neutrals were put beside seven other dark schemes on the real window, and a pure black
/// canvas with neutral greys won — see the `claude/macos-color-schemes-c1f0cc` branch. A Mac
/// app follows the system appearance, so every surface is a pair: the chosen value in dark,
/// and a paper-side equivalent that keeps the same layering in light.
///
/// Text is `text`, set once at the root of each window. `.primary`, `.secondary` and
/// `.tertiary` are hierarchical — they step the root's foreground style down in opacity —
/// so one colour there moves every label. Controls still come from AppKit.
enum Palette {
    // MARK: Identity

    /// Errors and alarms. The mascot's own color.
    static let coral = Color(nsColor: srgb(0xFB3949))
    /// The interface accent — the headband, carried through the interface. Also the colour
    /// of everything that comes from the analytics provider: live visitors are the app's
    /// momentum, and the guide gives momentum to acid.
    static let acid = Color(nsColor: srgb(0xC4FA04))
    /// The cool half of a two-series chart.
    static let blue = Color(nsColor: srgb(0x4C8DFF))
    /// Gains, and anything measured as healthy.
    static let mint = Color(nsColor: srgb(0x42D3A2))
    /// The warm half of a two-series chart.
    static let amber = Color(nsColor: srgb(0xFFB54A))

    // MARK: Surfaces

    /// The canvas the window is built on: behind the tab bar, around the pane.
    static let void = adaptive(dark: 0x000000, light: 0xE8EAE9)
    /// Grouped content — the screen a tab shows.
    static let panel = adaptive(dark: 0x0C0C0C, light: 0xF7F8F8)
    /// Floating UI: peek cards, and the cards inside a screen.
    static let raised = adaptive(dark: 0x171717, light: 0xFFFFFF)
    /// The hairline that separates one surface from the next.
    static let line = adaptive(dark: 0x262626, light: 0xDCDFDE)

    // MARK: Interaction

    /// The three answers a clickable surface gives, one value each.
    ///
    /// They are hierarchical on purpose — held is firmer than hovered — so a reader learns
    /// one fill and reads all three. `.primary` steps down from the window's own foreground,
    /// so they follow the appearance without a light and a dark value of their own.

    /// Under the pointer.
    static let hover = Color.primary.opacity(0.06)
    /// Held down. The HIG asks every custom button for a press state by name, and a hover
    /// alone cannot say that a click landed.
    static let pressed = Color.primary.opacity(0.12)
    /// The chosen one of a set. A different question from hover, so a different fill: a row
    /// stays chosen when the pointer leaves it.
    static let selected = Color.primary.opacity(0.09)

    // MARK: Text

    /// Body text, set at the root of a window. A neutral near-white in dark, so the greys it
    /// steps down to carry no blue; the system's label colour in light.
    static let text = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? srgb(0xEDEDED) : .labelColor
    })

    /// A surface that carries one value in dark and its paper-side equivalent in light.
    /// `NSColor`'s dynamic provider is asked for a value each time the appearance changes,
    /// so this follows the system live.
    private static func adaptive(dark: UInt32, light: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? srgb(dark) : srgb(light)
        })
    }

    private static func srgb(_ hex: UInt32) -> NSColor {
        NSColor(
            srgbRed: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

extension View {
    /// A card sitting on a panel: the raised surface, closed by a hairline. The guide leans
    /// on its hairlines to separate one surface from the next, and raised against panel is
    /// too near a match to read on its own.
    func cardSurface(cornerRadius: CGFloat = 10) -> some View {
        background(Palette.raised, in: .rect(cornerRadius: cornerRadius))
            .overlay(RoundedRectangle(cornerRadius: cornerRadius).strokeBorder(Palette.line))
    }
}

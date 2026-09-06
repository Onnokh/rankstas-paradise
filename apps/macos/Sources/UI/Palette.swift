import AppKit
import SwiftUI

/// The interface style guide's palette, by the guide's own names and hex values.
///
/// The guide is written for a dark interface only, but a Mac app follows the
/// system appearance. Every surface here is therefore a pair: the guide's value
/// in dark, and a paper-side equivalent that keeps the same layering in light.
/// Body text and controls still come from AppKit's semantic colors, so the app
/// keeps the system's contrast and accessibility settings.
enum Palette {
    // MARK: Identity

    /// Errors and alarms. The mascot's own color.
    static let coral = Color(nsColor: srgb(0xFB3949))
    /// The interface accent — the headband, carried through the interface.
    static let acid = Color(nsColor: srgb(0xC4FA04))
    /// The cool half of a two-series chart.
    static let blue = Color(nsColor: srgb(0x4C8DFF))
    /// Gains, and anything measured as healthy.
    static let mint = Color(nsColor: srgb(0x42D3A2))
    /// The warm half of a two-series chart.
    static let amber = Color(nsColor: srgb(0xFFB54A))

    // MARK: Surfaces

    /// The canvas the window is built on: behind the tab bar, around the pane.
    static let void = adaptive(dark: 0x08090A, light: 0xE8EAE9)
    /// Grouped content — the screen a tab shows.
    static let panel = adaptive(dark: 0x15181D, light: 0xF7F8F8)
    /// Floating UI: peek cards, and the cards inside a screen.
    static let raised = adaptive(dark: 0x1C2026, light: 0xFFFFFF)
    /// The hairline that separates one surface from the next.
    static let line = adaptive(dark: 0x292E36, light: 0xDCDFDE)

    /// A surface that carries the guide's value in dark and its paper-side
    /// equivalent in light. `NSColor`'s dynamic provider is asked for a value
    /// each time the appearance changes, so this follows the system live.
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
    /// A card sitting on a panel: the guide's raised surface, closed by a hairline.
    /// The guide leans on its hairlines to separate one surface from the next, and
    /// raised against panel is too near a match to read on its own.
    func cardSurface(cornerRadius: CGFloat = 10) -> some View {
        background(Palette.raised, in: .rect(cornerRadius: cornerRadius))
            .overlay(RoundedRectangle(cornerRadius: cornerRadius).strokeBorder(Palette.line))
    }
}

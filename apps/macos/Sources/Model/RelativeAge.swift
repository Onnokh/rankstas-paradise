import Foundation

/// How long ago something was, in the words a feed uses: "just now" inside a minute, whole
/// minutes up to an hour, and nothing after that — the caller shows the clock time instead.
///
/// A plain function of two dates, so a screen can drive it from a coarse timeline (every 15
/// seconds or so) rather than from SwiftUI's relative date text, whose seconds-precise style
/// asks for a new frame continuously and kept the app at a fifth of a core while idle.
enum RelativeAge {
    static let hour: TimeInterval = 60 * 60

    static func label(from date: Date, to now: Date) -> String? {
        let elapsed = now.timeIntervalSince(date)
        if elapsed < 60 { return "just now" }
        if elapsed < hour { return "\(Int(elapsed / 60))m ago" }
        return nil
    }

    /// The label, or the clock time once the label runs out: what a feed row shows.
    static func labelOrTime(from date: Date, to now: Date) -> String {
        label(from: date, to: now) ?? date.formatted(date: .omitted, time: .shortened)
    }
}

import SwiftUI

// How a figure is written and coloured, in one place for the Mac and the iPhone: the
// Overview set these rules, and a project reads the same on either.

/// The colour of everything that comes from the analytics provider: a site's live dot, the
/// visits dot in a metric strip, the realtime bars, the visits chart and the feed's events.
/// The accent, not a hue of its own: live visitors are the app's momentum, and the guide
/// gives momentum to acid. It was lilac, and lilac read as a colour nobody chose.
let visitsColor = Palette.acid

extension OverviewSource {
    /// The one colour this source wears everywhere in the app. The rate has none: it is not a
    /// source of its own but a relation between two, so it is drawn in the foreground colour
    /// rather than borrowing the meaning of blue or amber.
    var color: Color {
        switch self {
        case .clicks: Palette.blue
        case .impressions: Palette.amber
        case .ctr: Palette.text
        case .visits: visitsColor
        case .sales: Palette.mint
        }
    }

    /// The dot that ties a figure in the strip to its line in the chart. A rate has no line of
    /// its own colour, so it has no dot.
    var dot: Color? {
        isRate ? nil : color
    }

    /// Whether the line is drawn over a fill. A count fills: the area under it is the clicks
    /// that were made. A rate does not accumulate — the area under 8% means nothing — so it
    /// is a line alone, which is also what keeps a white line from washing the page grey.
    var fills: Bool { !isRate }
}

// MARK: - Figures

/// How the Overview writes its numbers: whole counts, a rate in percent to one place, a
/// position to one place, and a move with its sign. One place for every cell, so a project's
/// tile and the strip above it say the same thing the same way.
enum GlanceFigure {
    static func count(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0)))
    }

    static func rate(_ value: Double) -> String {
        value.formatted(.percent.precision(.fractionLength(1)))
    }

    /// A position of zero is no position: no impression put the site anywhere.
    static func position(_ value: Double) -> String {
        value > 0 ? value.formatted(.number.precision(.fractionLength(1))) : "—"
    }

    /// Mint when the move is the good way, coral otherwise. For a position, down is up.
    static func tint(_ delta: Double, lowerIsBetter: Bool = false) -> Color {
        (lowerIsBetter ? delta <= 0 : delta >= 0) ? Palette.mint : Palette.coral
    }

    /// A figure in the units of its source: percent for a rate, money for the sales, a count
    /// for the rest.
    static func figure(_ value: Double, source: OverviewSource, currency: String?) -> String {
        if source.isRate { return rate(value) }
        return source.isMoney ? Money.format(value, currency: currency) : count(value)
    }

    /// A move in the units of its source, with its sign in front. A rate moves in percentage
    /// points: from 8% to 9% is a point, not a ninth.
    static func move(_ growth: Growth, source: OverviewSource, currency: String?) -> String {
        if source.isRate {
            guard let points = Rate.points(growth) else { return "new" }
            return Trend.signed(points, fractionDigits: 1) + "pp"
        }
        guard let previous = growth.previous else { return "new" }
        let moved = growth.current - previous
        return source.isMoney
            ? Money.signed(moved, currency: currency)
            : Trend.signed(moved, fractionDigits: 0)
    }

    /// How a source's move is tinted: mint the good way, coral the other, nothing for a move
    /// too small to call. A rate is judged on its points, a count on its ratio.
    static func tint(_ growth: Growth, source: OverviewSource) -> Color? {
        if source.isRate {
            guard let points = Rate.points(growth) else { return nil }
            if points >= 0.1 { return Palette.mint }
            if points <= -0.1 { return Palette.coral }
            return nil
        }
        return GrowthReading.tint(growth)
    }
}

// MARK: - Reading a growth

/// What the screen says about a growth: the percentage and a colour. The bands are the
/// screen's: ten percent either way is the line between moving and standing still. One
/// colour with one meaning — mint up, coral down, nothing for flat or unknown.
enum GrowthReading {
    static let band = 0.1

    /// "+34%", or "new" for a count that came from nothing, or a dash for nothing at all.
    static func label(_ growth: Growth) -> String {
        if let ratio = growth.ratio { return Trend.signed(ratio * 100, fractionDigits: 0) + "%" }
        return growth.current > 0 ? "new" : "—"
    }

    static func tint(_ growth: Growth) -> Color? {
        guard let ratio = growth.ratio else { return nil }
        if ratio >= band { return Palette.mint }
        if ratio <= -band { return Palette.coral }
        return nil
    }
}

// MARK: - A chart's span

/// The y domain of a chart that keeps room above its peaks: the values' span, from zero for a
/// count, with `headroom` of the span added on top.
///
/// The room is in the domain, not in `chartPlotStyle` padding. Top padding on the plot moves
/// the axis — the zero grid line and the x ticks — up by its amount and leaves the marks where
/// they were, so the hairline that means zero sat above zero, inside the area.
enum ChartSpan {
    static func domain(_ values: [Double], fromZero: Bool, headroom: Double) -> ClosedRange<Double> {
        let top = values.max() ?? 0
        let bottom = fromZero ? min(0, values.min() ?? 0) : (values.min() ?? 0)
        // A flat run still needs a span: a count of nothing draws on the floor, a flat rate
        // in the middle.
        guard top > bottom else {
            return fromZero ? bottom...(bottom + 1) : (bottom - max(abs(bottom) * 0.1, 0.001))...(top + max(abs(top) * 0.1, 0.001))
        }
        return bottom...(top + (top - bottom) * headroom)
    }
}

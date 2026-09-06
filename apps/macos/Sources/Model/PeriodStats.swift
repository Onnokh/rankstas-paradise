import Foundation

/// The spans a site screen can show. Each is compared with the span of equal length before it.
enum Period: String, CaseIterable, Identifiable, Sendable {
    case d7, d14, d28, m3, m6

    var id: String { rawValue }

    var days: Int {
        switch self {
        case .d7: 7
        case .d14: 14
        case .d28: 28
        case .m3: 90
        case .m6: 180
        }
    }

    var label: String {
        switch self {
        case .d7: "7d"
        case .d14: "14d"
        case .d28: "28d"
        case .m3: "3m"
        case .m6: "6m"
        }
    }

    /// Days of history needed to compare the longest period with the one before it.
    static var historyLimit: Int { Period.m6.days * 2 }
}

/// A period and the one immediately before it, cut from one ascending daily series.
///
/// A short series still yields a current period; `previous` is then whatever remains, so an
/// under-filled comparison reads as a smaller previous total rather than a crash.
struct PeriodComparison: Equatable {
    let current: [HistoryDay]
    let previous: [HistoryDay]

    init(days: [HistoryDay], window: Int) {
        let count = days.count
        current = Array(days.suffix(window))
        let previousEnd = max(0, count - window)
        let previousStart = max(0, count - window * 2)
        previous = Array(days[previousStart..<previousEnd])
    }

    var currentStats: DashboardStats { DashboardStats(days: current) }
    var previousStats: DashboardStats? { previous.isEmpty ? nil : DashboardStats(days: previous) }

    var clicks: Trend? { previousStats.map { Trend(current: currentStats.clicks, previous: $0.clicks) } }
    var impressions: Trend? { previousStats.map { Trend(current: currentStats.impressions, previous: $0.impressions) } }
    /// Percentage-point move of the click-through rate.
    var ctrPointsDelta: Double? { previousStats.map { (currentStats.ctr - $0.ctr) * 100 } }
    var positionDelta: Double? { previousStats.map { currentStats.position - $0.position } }
}

/// A count and how it moved against the previous period.
struct Trend: Equatable {
    let delta: Double
    /// Nil when the previous period had nothing to grow from, so no percentage is meaningful.
    let ratio: Double?

    init(current: Double, previous: Double) {
        delta = current - previous
        ratio = previous > 0 ? (current - previous) / previous : nil
    }

    /// "+1 (+33.3%)", or just the count when there is no base to compare against.
    var label: String {
        let moved = Self.signed(delta, fractionDigits: 0)
        guard let ratio else { return moved }
        return "\(moved) (\(Self.signed(ratio * 100, fractionDigits: 1))%)"
    }

    static func signed(_ value: Double, fractionDigits: Int) -> String {
        let magnitude = abs(value).formatted(.number.precision(.fractionLength(fractionDigits)))
        return (value < 0 ? "−" : "+") + magnitude
    }
}

/// The Domain Rating move across a window: the newest reading against the newest one at
/// least `days` old.
///
/// The series is sparse and short: it only started when the feature shipped and grows one
/// day per sync. So the comparison walks back to the last reading on or before the cutoff,
/// and reports no delta when the series does not reach that far rather than inventing a
/// baseline from its oldest point.
struct RatingMove: Equatable {
    let current: Double
    let delta: Double?
    let since: String?

    init?(history: [DomainRatingDay], days: Int) {
        guard let latest = history.last else { return nil }
        current = latest.rating
        guard let latestDate = ISODay.date(latest.date),
              let cutoff = Calendar(identifier: .gregorian).date(byAdding: .day, value: -days, to: latestDate)
        else {
            delta = nil
            since = nil
            return
        }
        let cutoffKey = ISODay.string(cutoff)
        if let baseline = history.last(where: { $0.date <= cutoffKey }) {
            delta = latest.rating - baseline.rating
            since = baseline.date
        } else {
            delta = nil
            since = nil
        }
    }
}

/// "yyyy-MM-dd" as the API writes it, read and written in UTC.
enum ISODay {
    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static func date(_ string: String) -> Date? { formatter.date(from: string) }
    static func string(_ date: Date) -> String { formatter.string(from: date) }
}

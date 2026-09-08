import Foundation

struct Site: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let origin: String
}

struct SitesEnvelope: Codable, Sendable {
    let sites: [Site]
}

struct DashboardEnvelope: Codable, Sendable {
    let generatedAt: String
    let mode: String
    let summary: Summary
    let digest: OpportunityDigest
    let history: [HistoryDay]
    // Optional on the wire: an older server omits them, and a deployment without an
    // Ahrefs key sends null.
    var domainRating: DomainRating?
    var domainRatingHistory: [DomainRatingDay]?
}

/// Ahrefs' backlink-strength score for the site's host, 0–100 on a logarithmic scale.
struct DomainRating: Codable, Sendable, Equatable {
    let target: String
    let rating: Double
    let fetchedAt: String
}

struct DomainRatingDay: Codable, Sendable, Equatable {
    let date: String
    let rating: Double
}

/// `/api/history`: a longer daily series than the dashboard's 28 days, so a period can be
/// compared with the one before it.
struct HistoryReport: Codable, Sendable {
    let generatedAt: String
    let mode: String
    let days: [HistoryReportDay]
}

struct HistoryReportDay: Codable, Sendable, Equatable, Identifiable {
    let date: String
    /// Google is still revising this day; the UI dims it.
    let provisional: Bool
    let impressions: Double
    let clicks: Double
    let ctr: Double
    let position: Double
    /// The same day as the site's analytics provider counted it. Nil when the site has no
    /// provider, the day is not synced yet, or the series came from an older server or cache.
    var visits: VisitsDay? = nil

    var id: String { date }

    /// The day as a point in time (noon UTC), for plotting.
    var day: Date {
        (ISODay.date(date) ?? .distantPast).addingTimeInterval(12 * 3600)
    }

    var asHistoryDay: HistoryDay {
        HistoryDay(date: date, impressions: impressions, clicks: clicks, ctr: ctr, position: position)
    }
}

/// One day of the analytics provider's series. Visits (sessions) sum across days; visitors
/// are the day's distinct people and do not.
struct VisitsDay: Codable, Sendable, Equatable {
    let pageviews: Double
    let visits: Double
    let visitors: Double
}

/// `/api/events`: the site's custom events over a window, strongest first.
struct EventsReport: Codable, Sendable {
    let generatedAt: String
    let windowDays: Int
    let events: [EventRow]
}

struct EventRow: Codable, Sendable, Equatable, Identifiable {
    let name: String
    let current: Double
    let previous: Double
    let delta: Double

    var id: String { name }
}

/// `/api/revenue`: the site's sales over a window against the window before, from the server's
/// ledger. Amounts arrive in the currency's minor unit (cents); `Money` shows them.
struct RevenueReport: Codable, Sendable, Equatable {
    let generatedAt: String
    /// Nil when the site has no commerce provider.
    let revenue: RevenueStatus?
    let windowDays: Int
    /// Nil until a row exists.
    let currency: String?
    /// The current window's synced days, oldest first. A day never synced is absent.
    let days: [RevenueDay]
    let current: RevenueTotals
    let previous: RevenueTotals
    let delta: RevenueTotals
}

struct RevenueStatus: Codable, Sendable, Equatable {
    let provider: String
    let accountId: String?
    let ready: Bool
    let reason: String?
}

struct RevenueDay: Codable, Sendable, Equatable, Identifiable {
    let date: String
    let orders: Double
    /// What customers paid, in minor units.
    let revenue: Double
    /// Revenue less refunds, in minor units.
    let net: Double
    let currency: String

    var id: String { date }

    /// The day as a point in time (noon UTC), for plotting.
    var day: Date {
        (ISODay.date(date) ?? .distantPast).addingTimeInterval(12 * 3600)
    }
}

struct RevenueTotals: Codable, Sendable, Equatable {
    let orders: Double
    let revenue: Double
    let net: Double
}

/// Amounts in a currency's minor unit, shown in the currency.
enum Money {
    /// "$1,234.50" — or, for a currency the report has not named, a plain number of units.
    static func format(_ minorUnits: Double, currency: String?) -> String {
        let units = minorUnits / 100
        guard let currency else {
            return units.formatted(.number.precision(.fractionLength(2)))
        }
        return units.formatted(.currency(code: currency).precision(.fractionLength(2)))
    }

    /// "+$12.00" / "−$3.50": a move, with its sign in front of the currency.
    static func signed(_ minorUnits: Double, currency: String?) -> String {
        (minorUnits < 0 ? "−" : "+") + format(abs(minorUnits), currency: currency)
    }
}

/// `/api/today`: today so far in the site's zone, from the server's ledger, which it refreshes
/// from the provider every few minutes. Polled with the live count and never cached here.
struct TodayReport: Codable, Sendable {
    let generatedAt: String
    let analytics: AnalyticsStatus?
    /// Nil when the site has no provider, or its provider is not ready.
    let today: TodayVisits?
}

struct TodayVisits: Codable, Sendable, Equatable {
    let date: String
    let timeZone: String
    /// Hours of the day that have begun, 1–24: how many of `hours` are real.
    let hoursElapsed: Int
    /// The day's totals so far; nil before the first visit.
    let site: VisitsDay?
    /// Exactly 24 rows, hour 0 first, zeros for hours still to come.
    let hours: [VisitsHour]
    let pages: [TodayPage]
    let events: [TodayEvent]
    /// When the server last wrote today's rows; nil before its first sync of the day.
    let syncedAt: String?

    var eventCount: Double { events.reduce(0) { $0 + $1.count } }
}

struct VisitsHour: Codable, Sendable, Equatable, Identifiable {
    let hour: Int
    let pageviews: Double
    let visits: Double
    let visitors: Double

    var id: Int { hour }
}

struct TodayPage: Codable, Sendable, Equatable, Identifiable {
    let page: String
    let pageviews: Double
    let visits: Double

    var id: String { page }
}

struct TodayEvent: Codable, Sendable, Equatable, Identifiable {
    let name: String
    let count: Double

    var id: String { name }
}

/// `/api/live`: the people on the site right now. The one read that asks the analytics
/// provider, so it is polled on its own and never cached.
struct LiveReport: Codable, Sendable {
    let generatedAt: String
    let mode: String
    /// Nil when the site has no analytics provider.
    let analytics: AnalyticsStatus?
    /// Nil when the site has no provider, or its provider is configured but not ready.
    let live: LiveVisitors?
}

/// `/api/live/events`: what visitors did in the last half hour, from the provider. Polled
/// every few seconds while the overview is shown, and never cached; see `LiveStore`.
struct LiveEventsReport: Codable, Sendable {
    let generatedAt: String
    let analytics: AnalyticsStatus?
    /// Nil when the site has no provider, or its provider is configured but not ready.
    let events: LiveEvents?
}

struct LiveEvents: Codable, Sendable, Equatable {
    let windowMinutes: Int
    /// The cut-off the request carried, echoed back; nil when it asked for the whole window.
    let since: String?
    /// Newest first.
    let events: [LiveEvent]
    let fetchedAt: String
}

/// One thing a visitor just did: a page they loaded, or a named action with its data.
struct LiveEvent: Codable, Sendable, Equatable, Identifiable {
    /// What kind of thing it was. Every provider has pageviews and named events; the rest are
    /// auto-captured interactions some providers record. A kind this build does not know
    /// decodes as `.event`, so a newer server never breaks the feed.
    enum Kind: String, Codable, Sendable, CaseIterable {
        case pageview
        case event
        case outbound
        case buttonClick = "button_click"
        case copy
        case formSubmit = "form_submit"
        case inputChange = "input_change"

        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .event
        }

        var label: String {
            switch self {
            case .pageview: "Pageview"
            case .event: "Event"
            case .outbound: "Outbound"
            case .buttonClick: "Button click"
            case .copy: "Copy"
            case .formSubmit: "Form submit"
            case .inputChange: "Input change"
            }
        }

        var symbol: String {
            switch self {
            case .pageview: "eye"
            case .event: "bolt"
            case .outbound: "arrow.up.right.square"
            case .buttonClick: "cursorarrow.click"
            case .copy: "doc.on.doc"
            case .formSubmit: "paperplane"
            case .inputChange: "character.cursor.ibeam"
            }
        }
    }

    /// Stable across polls for the same row: how the feed tells a new row from one it has.
    let id: String
    /// When it happened, an ISO 8601 instant.
    let at: String
    let kind: Kind
    /// The event's name; nil for a pageview.
    let name: String?
    /// The page it happened on, as a path.
    let page: String
    /// The event's data, flattened to strings. Empty for a plain pageview.
    let properties: [String: String]
    /// The same for every row of one person; never a name.
    let visitor: String
    /// ISO 3166-1 alpha-2, or nil when the provider does not know.
    let country: String?
    let browser: String?
    let operatingSystem: String?
    let device: String?
    let referrer: String?

    var date: Date? { Instant.parse(at) }
}

struct AnalyticsStatus: Codable, Sendable, Equatable {
    let provider: String
    let siteId: String
    let ready: Bool
    let reason: String?
}

struct LiveVisitors: Codable, Sendable, Equatable {
    /// Distinct people seen in the last `windowMinutes`.
    let visitors: Double
    let windowMinutes: Int
    /// Distinct people seen in the last `onlineWindowMinutes`: the ones on the site right
    /// now. Optional: an older server only knows the whole window.
    var online: Double? = nil
    var onlineWindowMinutes: Int? = nil
    /// People seen per minute of the window, oldest first. Optional: an older server omits it.
    var series: [Double]? = nil
    let fetchedAt: String

    /// The figure to call "online". The tight count when the server sends one, otherwise the
    /// whole window rather than nothing, with `onlineMinutes` saying which it was.
    var onlineNow: Double { online ?? visitors }
    var onlineMinutes: Int { online == nil ? windowMinutes : (onlineWindowMinutes ?? windowMinutes) }

    /// One bar per minute of the window, oldest first: the series trimmed to its newest
    /// `windowMinutes` entries or padded with leading zeros, so the card always draws a full row.
    var bars: [Double] {
        let newest = Array((series ?? []).suffix(windowMinutes))
        return Array(repeating: 0, count: max(0, windowMinutes - newest.count)) + newest
    }
}

struct Summary: Codable, Sendable {
    let rows: Int
    let dates: Int
}

struct OpportunityDigest: Codable, Sendable {
    let latestDate: String?
    let signals: [OpportunitySignal]
}

struct OpportunitySignal: Codable, Sendable {
    let kind: String
    let label: String
}

struct HistoryDay: Codable, Sendable, Equatable {
    let date: String
    let impressions: Double
    let clicks: Double
    let ctr: Double
    let position: Double
}

struct DashboardStats: Equatable, Sendable {
    let clicks: Double
    let impressions: Double
    let ctr: Double
    let position: Double

    init(days: [HistoryDay]) {
        clicks = days.reduce(0) { $0 + $1.clicks }
        impressions = days.reduce(0) { $0 + $1.impressions }

        if impressions == 0 {
            ctr = 0
            position = 0
        } else {
            ctr = clicks / impressions
            position = days.reduce(0) { $0 + ($1.position * $1.impressions) } / impressions
        }
    }
}

/// Clicks, impressions, CTR and position for one window, as the server tidies them.
struct TidyMetrics: Codable, Sendable, Equatable {
    let impressions: Double
    let clicks: Double
    let ctr: Double
    let position: Double
}

/// `/api/queries`: the site's search terms over a window, strongest first.
struct QueriesReport: Codable, Sendable {
    let generatedAt: String
    let queries: [QueryRow]
}

struct QueryRow: Codable, Sendable, Equatable, Identifiable {
    let query: String
    let page: String
    let brand: Bool
    let current: TidyMetrics

    var id: String { query + "|" + page }
}

/// `/api/registry`: every target page the site tracks, with its metrics for the server's
/// own reporting window.
struct RegistryListReport: Codable, Sendable {
    let generatedAt: String
    let targets: [RegistryTarget]
}

struct RegistryTarget: Codable, Sendable, Equatable, Identifiable {
    /// A site-relative path, "/foo".
    let targetUrl: String
    let phase: String
    let status: String
    let window: TidyMetrics
    /// The provider's visits over the same 28 days. Nil when the site has no provider, has
    /// synced nothing yet, or the server predates the field.
    var visits: VisitsWindow? = nil

    var id: String { targetUrl }
}

/// Pageviews and visits over a window and the one before it, as the server tidies them.
struct VisitsWindow: Codable, Sendable, Equatable {
    struct Counts: Codable, Sendable, Equatable {
        let pageviews: Double
        let visits: Double
    }

    let current: Counts
    let previous: Counts
    let deltaPageviews: Double
    let deltaVisits: Double
}

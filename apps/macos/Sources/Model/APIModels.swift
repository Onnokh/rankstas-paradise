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

    var id: String { date }

    /// The day as a point in time (noon UTC), for plotting.
    var day: Date {
        (ISODay.date(date) ?? .distantPast).addingTimeInterval(12 * 3600)
    }

    var asHistoryDay: HistoryDay {
        HistoryDay(date: date, impressions: impressions, clicks: clicks, ctr: ctr, position: position)
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

    var id: String { targetUrl }
}

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

struct HistoryDay: Codable, Sendable {
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

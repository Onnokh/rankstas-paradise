import Foundation

/// The ways the server describes where a visit came from. The raw values are the server's
/// words; the labels are the cards' words. A dimension the server adds later is not here, and
/// `AcquisitionList` sets its rows aside rather than failing on them.
enum AcquisitionDimension: String, CaseIterable, Identifiable, Sendable {
    /// The referring host, `www.` stripped: `google.com`, `reddit.com`. A direct visit has none.
    case referrer
    /// The provider's own grouping of the origin: Direct, Organic Search, Organic Social, Referral…
    case channel
    /// The tags a link carried, as whoever made the link wrote them. An untagged link has none.
    case utmSource = "utm_source"
    case utmMedium = "utm_medium"
    case utmCampaign = "utm_campaign"

    var id: String { rawValue }

    /// The word on a card's switch.
    var label: String {
        switch self {
        case .referrer: "Referrers"
        case .channel: "Channels"
        case .utmSource: "UTM source"
        case .utmMedium: "UTM medium"
        case .utmCampaign: "UTM campaign"
        }
    }

    /// What a card says when the period has no rows for the dimension. The UTM ones say
    /// "tagged": nearly every visit is untagged, and that is not the same as no visits.
    var emptyMessage: String {
        switch self {
        case .referrer: "No referred visits in this period."
        case .channel: "No visits in this period."
        case .utmSource, .utmMedium, .utmCampaign: "No tagged visits in this period."
        }
    }

    /// The two cards: where visits came from, and how the links that brought them were tagged.
    /// Cut by the question a reader has, so nobody pages past channels to find a campaign.
    static let origins: [AcquisitionDimension] = [.referrer, .channel]
    static let tags: [AcquisitionDimension] = [.utmSource, .utmMedium, .utmCampaign]
}

/// One row of an acquisition card, whichever period it came from. A stored period carries the
/// previous period's count, so the row can show its move; today carries none, because there
/// is no previous today.
struct AcquisitionListRow: Identifiable, Equatable, Sendable {
    let dimension: AcquisitionDimension
    let value: String
    let current: Double
    let previous: Double?

    var id: String { "\(dimension.rawValue)|\(value)" }

    /// The move against the previous period, or nil when there is none to move from.
    var delta: Double? { previous.map { current - $0 } }
}

/// The card's reading of the server's rows: cut to one dimension, strongest first, capped.
enum AcquisitionList {
    /// The rows of one dimension, strongest first, at most `limit`. Equal counts keep the order
    /// they arrived in, which is the server's.
    static func rows(
        _ rows: [AcquisitionListRow],
        for dimension: AcquisitionDimension,
        limit: Int = RankingStore.rowLimit
    ) -> [AcquisitionListRow] {
        Array(rows.filter { $0.dimension == dimension }.sorted { $0.current > $1.current }.prefix(limit))
    }

    /// A stored period's rows. A row whose dimension this build does not know is dropped: the
    /// server may learn a new one before the app does, and one strange row must not cost the
    /// list the others.
    static func rows(from report: [AcquisitionRow]) -> [AcquisitionListRow] {
        report.compactMap { row in
            AcquisitionDimension(rawValue: row.dimension).map {
                AcquisitionListRow(dimension: $0, value: row.value, current: row.current, previous: row.previous)
            }
        }
    }

    /// Today's rows so far, with no previous period.
    static func rows(fromToday rows: [TodayAcquisition]) -> [AcquisitionListRow] {
        rows.compactMap { row in
            AcquisitionDimension(rawValue: row.dimension).map {
                AcquisitionListRow(dimension: $0, value: row.value, current: row.visits, previous: nil)
            }
        }
    }
}

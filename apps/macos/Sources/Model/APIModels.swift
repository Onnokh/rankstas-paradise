import Foundation

struct Site: Codable, Identifiable, Sendable, Equatable {
    let id: String
    let name: String
    let origin: String
    /// The provider blocks as the server resolved them, defaults filled in. Optional so
    /// snapshots and older servers still decode.
    var analytics: ResolvedAnalytics?
    var revenue: ResolvedRevenue?
    /// The country and language the site's keyword numbers describe, on the same terms.
    var market: ResolvedMarket?

    init(
        id: String,
        name: String,
        origin: String,
        analytics: ResolvedAnalytics? = nil,
        revenue: ResolvedRevenue? = nil,
        market: ResolvedMarket? = nil
    ) {
        self.id = id
        self.name = name
        self.origin = origin
        self.analytics = analytics
        self.revenue = revenue
        self.market = market
    }
}

/// A site's Market with the server's defaults filled: the country and language every search
/// volume on the site is measured in. A volume without its market is ambiguous, so anything
/// that shows one shows this too.
struct ResolvedMarket: Codable, Sendable, Equatable {
    let locationCode: Int
    let languageCode: String
    /// The country's name, for display.
    let label: String
    /// "labs" or "google-ads". Google-Ads markets carry no keyword difficulty and no search
    /// intent, so a screen can leave those out rather than show them empty.
    let provider: String

    /// The market in one line: "United States · EN".
    var summary: String { "\(label) · \(languageCode.uppercased())" }

    /// Whether the vendor reports keyword difficulty for this market at all.
    var hasDifficulty: Bool { provider != "google-ads" }
}

/// A site's analytics source with the server's defaults filled: what the adapter runs with.
struct ResolvedAnalytics: Codable, Sendable, Equatable {
    let provider: String
    let siteId: String
    let baseUrl: String?
    let timeZone: String
}

/// A site's revenue source with the server's defaults filled.
struct ResolvedRevenue: Codable, Sendable, Equatable {
    let provider: String
    let accountId: String?
    let keyVariable: String
    let baseUrl: String?
    let timeZone: String
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

/// The server's ISO 8601 instants, with or without fractional seconds.
enum Instant {
    static func parse(_ text: String) -> Date? {
        (try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
            ?? (try? Date(text, strategy: .iso8601))
    }
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

/// `/api/registry/health`: the plan judged on demand. Answers "was this worth planning",
/// which is the only question a site with no visibility yet can answer at all.
struct RegistryHealthReport: Codable, Sendable {
    let generatedAt: String
    /// The market every number here describes. Nil for a site with none, or an older server.
    var market: ResolvedMarket? = nil
    /// The site's Ahrefs domain rating, for reading `difficultyGap` against.
    let domainRating: Double?
    let totals: KeywordTotals
    /// Keywords with demand first, strongest first, then the rows to decide about.
    let keywords: [KeywordHealth]
}

// `totals.brand` is deliberately absent. The screen counts each verdict off `keywords`
// itself, so reading the server's count would add a field that must be kept in step for
// nothing — and a non-optional field with a default does NOT decode when the key is
// missing, so adding it would break every report already cached on disk.
struct KeywordTotals: Codable, Sendable, Equatable {
    let keywords: Int
    let unmeasured: Int
    let unreported: Int
    let noDemand: Int
    let hasDemand: Int
    /// Searches a month behind the whole plan. The size of the addressable market, NOT a
    /// traffic forecast: it counts every search, not the share a first-page ranking wins.
    let monthlyVolume: Double
}

/// One planned keyword, judged on whether anybody searches for it.
struct KeywordHealth: Codable, Sendable, Equatable, Identifiable {
    let keyword: String
    let targetUrl: String
    let cluster: String
    let priority: String
    /// The intent the plan claims.
    let intent: String
    /// "has-demand", "no-demand", "unreported", "unmeasured" or "brand" — see
    /// `KeywordVerdict`.
    let verdict: String
    let searchVolume: Double?
    let difficulty: Double?
    /// Difficulty minus the site's domain rating. Positive means the keyword scores harder
    /// than the site rates. A guide across two vendors' unrelated scales, never a verdict.
    let difficultyGap: Double?
    let costPerClick: Double?
    /// The intent the vendor observed, which may disagree with the plan's.
    let reportedIntent: String?
    /// The calendar month, 1-12, demand peaks in. Nil under two complete years of history.
    var peakMonth: Int? = nil
    /// How pronounced that peak is: 1.0 is a month carrying its even share of the year.
    var seasonality: Double? = nil

    var id: String { keyword }

    var verdictKind: KeywordVerdict { KeywordVerdict(rawValue: verdict) ?? .unmeasured }

    /// The month name the plan should aim at, when there is a season worth aiming at.
    /// `threshold` is the reader's: every term has a highest month, only some have a season.
    func peakLabel(seasonalAbove threshold: Double) -> String? {
        guard let peakMonth, let seasonality, seasonality >= threshold else { return nil }
        guard (1...12).contains(peakMonth) else { return nil }
        return DateFormatter().shortMonthSymbols?[peakMonth - 1]
            ?? Calendar.current.shortMonthSymbols[peakMonth - 1]
    }
}

/// What the vendor said about a planned keyword, as five distinct facts. A word this build
/// does not know reads as `unmeasured`: claiming the vendor said something it did not is
/// worse than admitting we have not asked.
enum KeywordVerdict: String, Sendable, CaseIterable {
    case hasDemand = "has-demand"
    case noDemand = "no-demand"
    case unreported = "unreported"
    case unmeasured = "unmeasured"
    /// The site's own name, which is never asked about. Apart from `unmeasured` because the
    /// two ask opposite things of the reader: measure that one, and leave this one alone.
    case brand = "brand"

    var label: String {
        switch self {
        case .hasDemand: "Worth writing"
        case .noDemand: "Aimed at nothing"
        case .unreported: "Too rare to measure"
        case .unmeasured: "Not measured"
        case .brand: "Your own brand"
        }
    }
}

/// `/api/log`: the site's work record, newest first — every Action taken on a page and
/// every Note written beside one.
///
/// The server calls the array `actions` even though it holds Notes too; the name is the
/// wire's, not this app's, so the store reads it into `entries`.
struct LogListReport: Codable, Sendable {
    let actions: [LogEntry]
}

/// One entry of a site's Log: a change made to a page, or a note written about one.
///
/// Attached to a Page by its path, never to a keyword, so many keyword rows sharing one
/// target share one entry.
struct LogEntry: Codable, Sendable, Equatable, Identifiable {
    /// The store's own row id, and the only stable identity an entry has: two notes can
    /// share a date, a path and a kind.
    let id: Int
    /// The day the work was done, "YYYY-MM-DD". Not the day it was recorded — that is
    /// `createdAt`, and the two differ whenever an entry is written up afterwards.
    let date: String
    /// A site-relative path, "/foo".
    let path: String
    /// The server's word for what was done: see `LogKind`.
    let kind: String
    /// The free text beside it. Empty is normal for an Action.
    let note: String
    /// When the entry was written, an ISO 8601 instant. Optional so a snapshot written
    /// before the field, and an older server, still decode.
    var createdAt: String? = nil
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
    /// Where the page stands, in the server's own word: see `RegistryPhase`.
    let phase: String
    let status: String
    let window: TidyMetrics
    /// The provider's visits over the same 28 days. Nil when the site has no provider, has
    /// synced nothing yet, or the server predates the field.
    var visits: VisitsWindow? = nil
    /// Google's last verdict on the page: "indexed", "not-indexed" or "unknown". Optional so
    /// an older server and a snapshot written before the field still decode.
    var indexed: String? = nil
    /// Google's own words for that verdict, "Submitted and indexed"; nil when the page was
    /// never inspected.
    var coverageState: String? = nil
    /// When Google last inspected the page, an ISO 8601 instant.
    var inspectedAt: String? = nil
    /// The registry's own fields for the page, from its first row. Every one is optional:
    /// a snapshot written before the field, or an older server, must still decode.
    var priority: String? = nil
    var intent: String? = nil
    var publishedAt: String? = nil
    var baselineDate: String? = nil
    var whyOpportunity: String? = nil
    /// The first day the window measures from.
    var measuredFrom: String? = nil
    /// The same figures before the page was published, when there is a baseline to compare
    /// the window against.
    var baseline: TidyMetrics? = nil
    /// The keywords mapped to the page. Absent for a page the sitemap contributed, and for a
    /// snapshot written before the field.
    var keywords: [RegistryKeyword]? = nil

    var id: String { targetUrl }

    /// Google reports the page is not in its index. A page Google has not spoken about
    /// ("unknown", or a server that sends nothing) is not called unindexed.
    var isUnindexed: Bool { indexed == "not-indexed" }

    var mappedKeywords: [RegistryKeyword] { keywords ?? [] }
}

/// One keyword mapped to a target page.
struct RegistryKeyword: Codable, Sendable, Equatable, Identifiable, Hashable {
    let keyword: String
    let cluster: String
    let intent: String
    /// What the vendor says about the keyword in the site's market. Nil means no answer is
    /// stored — not that the keyword has no demand.
    var demand: KeywordDemand? = nil

    /// The registry holds one row per keyword, so the keyword identifies it.
    var id: String { keyword }
}

/// What DataForSEO says about one keyword, as the server reports it. Every number is
/// optional twice over: the key is absent when no answer is stored, and a value inside is
/// null when the vendor was asked and had nothing. Neither is a zero.
struct KeywordDemand: Codable, Sendable, Equatable, Hashable {
    /// Average monthly searches over the newest twelve months. Nil means the term is too rare
    /// for the vendor to report, which is not the same as nobody searching it.
    let searchVolume: Double?
    /// 0-100. Nil for a Google-Ads market, which does not measure it.
    let difficulty: Double?
    let costPerClick: Double?
    let competition: Double?
    let intent: String?
    let fetchedAt: String

    /// The volume as a row shows it, or nil when there is none to show.
    var volumeLabel: String? {
        guard let searchVolume else { return nil }
        return "\(searchVolume.formatted(.number.precision(.fractionLength(0))))/mo"
    }

    /// The difficulty as a row shows it. Nil covers both a Google-Ads market and a term the
    /// vendor scored no difficulty for.
    var difficultyLabel: String? {
        guard let difficulty else { return nil }
        return "KD \(difficulty.formatted(.number.precision(.fractionLength(0))))"
    }
}

/// `/api/keywords/proposed`: keywords an expansion found that the registry does not hold.
/// The counterpart of `RegistryHealthReport` — that judges the plan the site HAS, this
/// offers keywords it does not.
struct KeywordProposalsReport: Codable, Sendable {
    let generatedAt: String
    /// The market these were found in. Nil for a site with none, or an older server.
    var market: ResolvedMarket? = nil
    /// `var` because a dismissal drops its rows from the held report rather than
    /// re-fetching: the server has the decision, and re-reading the list would replace
    /// rows the reader is still looking at.
    var totals: ProposalTotals
    /// Strongest demand first, so a reader who stops after ten rows read the ten worth it.
    var proposals: [KeywordProposal]
}

struct ProposalTotals: Codable, Sendable, Equatable {
    let proposals: Int
    /// Searches a month behind every proposal: the demand on offer.
    let monthlyVolume: Double
}

/// One proposed keyword, with the vendor's numbers AS THEY READ WHEN IT WAS PROPOSED.
/// Frozen on purpose, so a row may disagree with the same keyword's current metric — a
/// proposal is the record of why it looked worth the work then.
struct KeywordProposal: Codable, Sendable, Equatable, Identifiable {
    let keyword: String
    /// The keyword this was expanded from. Rows group by it, so a reader can see which of
    /// their terms opened which door.
    let seed: String
    /// "suggestions", "related" or "google-ads" — see `ProposalSource`.
    let source: String
    let searchVolume: Double?
    let difficulty: Double?
    let costPerClick: Double?
    let competition: Double?
    let intent: String?
    let status: String
    let discoveredAt: String

    var id: String { keyword }

    var volumeLabel: String? {
        guard let searchVolume else { return nil }
        return "\(searchVolume.formatted(.number.precision(.fractionLength(0))))/mo"
    }

    var difficultyLabel: String? {
        guard let difficulty else { return nil }
        return "KD \(difficulty.formatted(.number.precision(.fractionLength(0))))"
    }
}

/// Which expansion found a proposal. Worth showing, because it tells the reader how far
/// from their own subject the row is — and, for `googleAds`, why it has no difficulty.
enum ProposalSource: String, Sendable {
    /// A long-tail phrase containing the seed.
    case suggestions
    /// A term Google relates to the seed, which need not contain it.
    case related
    /// The Google Ads expansion, for markets DataForSEO Labs does not serve. Reports no
    /// difficulty and no intent at all.
    case googleAds = "google-ads"

    var label: String {
        switch self {
        case .suggestions: "Long tail"
        case .related: "Related"
        case .googleAds: "Google Ads"
        }
    }

    var help: String {
        switch self {
        case .suggestions: "A longer phrase built around your seed. The closest to what you already have."
        case .related: "A term Google relates to your seed. It need not contain it, so this is where a new subject comes from."
        case .googleAds: "From the Google Ads expansion, which serves this market. It reports no difficulty and no intent."
        }
    }
}

/// The server's word for where a page stands. A word this build does not know is shown as
/// the server sent it, with no colour and no explanation.
enum RegistryPhase: String, Sendable {
    /// Keywords mapped, and searches reached it in the window.
    case live = "LIVE"
    /// From the sitemap, with no keywords mapped: inventory.
    case page = "PAGE"
    /// Measuring, and no non-brand impression yet. Named for what it says rather than for
    /// the server's word, which would read as `Optional.none` at every use.
    case measuring = "NONE"
    /// Published, waiting for Search Console to finalise the days after it.
    case pre = "PRE"
    /// In the registry, with no observation at all yet.
    case new = "NEW"

    var meaning: String {
        switch self {
        case .live: "Keywords are mapped and searches reached the page in this window."
        case .page: "A page from the sitemap, with no keywords mapped to it."
        case .measuring: "Measuring: no non-brand impression in the window yet."
        case .pre: "Published: waiting for Search Console to finalise the days after it."
        case .new: "In the registry, with no Search Console observation yet."
        }
    }
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

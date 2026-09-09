import XCTest
@testable import RankstasParadise

/// The ranked lists hydrate in place: a refresh or a warm load never empties a card first.
@MainActor
final class RankingStoreTests: XCTestCase {
    private var cacheDirectory: URL!

    override func setUp() {
        super.setUp()
        cacheDirectory = FileManager.default.temporaryDirectory
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        StubServer.reset()
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: cacheDirectory)
        super.tearDown()
    }

    private func makeStore() -> RankingStore {
        let directory = cacheDirectory!
        return RankingStore(cacheDirectory: directory, makeClient: { StubServer.client() })
    }

    func testRefreshKeepsTheShownListsUntilTheNewOnesArrive() async {
        StubServer.queryLabel = "old"
        let store = makeStore()
        let key = RankingStore.KeywordsKey(siteID: "site", period: .d28)
        await store.load("site", period: .d28)
        XCTAssertEqual(store.keywords[key]?.first?.query, "old")
        XCTAssertEqual(store.registry["site"]?.count, 1)

        StubServer.queryLabel = "new"
        StubServer.delay = .seconds(5)
        let refresh = Task { await store.refresh("site", period: .d28) }
        for _ in 0..<100 where !store.loading.contains("site") {
            await Task.yield()
        }

        XCTAssertTrue(store.loading.contains("site"))
        XCTAssertEqual(store.keywords[key]?.first?.query, "old", "The old rows stay on screen while the fetch runs.")
        XCTAssertEqual(store.events[key]?.count, 1)
        XCTAssertNotNil(store.revenue[key])
        XCTAssertEqual(store.registry["site"]?.count, 1)

        refresh.cancel()
        await refresh.value
    }

    func testTheSixReadsGoOutTogetherRatherThanOneAfterAnother() async {
        // Held open long enough that overlapping requests are still open when the next
        // one starts. Awaited in turn, six of these cost six delays end to end and the
        // screens waited on the sum; sent together they cost one.
        StubServer.delay = .milliseconds(200)
        let store = makeStore()

        await store.load("site", period: .d28)

        XCTAssertEqual(StubServer.requests.count, 6)
        XCTAssertGreaterThanOrEqual(
            StubServer.peakOpenRequests, 4,
            "Awaited one after another the peak is 1. Per-group concurrency alone is 3."
        )
    }

    func testRefreshReplacesTheListsAndMarksOtherPeriodsForAFetch() async {
        StubServer.queryLabel = "old"
        let store = makeStore()
        await store.load("site", period: .d28)
        await store.load("site", period: .d7)
        let requestsBefore = StubServer.requests.count

        StubServer.queryLabel = "new"
        await store.refresh("site", period: .d28)

        XCTAssertEqual(store.keywords[RankingStore.KeywordsKey(siteID: "site", period: .d28)]?.first?.query, "new")
        XCTAssertEqual(store.keywords[RankingStore.KeywordsKey(siteID: "site", period: .d7)]?.first?.query, "old",
                       "The other period keeps its rows: they are not shown, and a fetch of their own replaces them.")
        XCTAssertEqual(StubServer.requests.count - requestsBefore, 6,
                       "Keywords, events, revenue, the registry, the plan's health, and its proposals.")

        await store.load("site", period: .d7)
        XCTAssertEqual(store.keywords[RankingStore.KeywordsKey(siteID: "site", period: .d7)]?.first?.query, "new",
                       "Showing the other period after a refresh fetches it again.")
    }

    func testAServerWithoutTheHealthEndpointStillGivesUpTheRegistry() async {
        // The endpoint is newer than the registry, so an older server 404s it. Losing the
        // registry list over a screen the reader may not even be on would be the wrong
        // trade, so the failure does not fail the registry.
        StubServer.healthOK = false
        let store = makeStore()
        await store.load("site", period: .d28)

        XCTAssertEqual(store.registry["site"]?.count, 1)
        XCTAssertNil(store.health["site"])
        XCTAssertNil(store.errors["site"], "A missing health endpoint is not an error to show.")
        // But the reason is kept. Without it the planning screen has to guess why it has
        // no report, and it guessed "this registry maps no keywords" — which reads as a
        // fact about the plan and was wrong about a registry holding forty-five rows.
        XCTAssertNotNil(store.healthErrors["site"],
                        "A screen with no report must be able to say why, not describe a plan it cannot see.")
    }

    func testProposalsArriveWithTheRegistry() async {
        let store = makeStore()
        await store.load("site", period: .d28)

        XCTAssertEqual(store.proposals["site"]?.proposals.count, 2)
        XCTAssertEqual(store.proposals["site"]?.proposals.first?.keyword, "mount tracker addon")
        XCTAssertEqual(store.proposals["site"]?.totals.monthlyVolume, 570)
    }

    func testAServerWithoutTheProposalsEndpointIsNotAnError() async {
        // Unlike the health report, an absent proposal list costs the reader nothing:
        // "none" is what a working server sends for a site nobody has run a discovery on.
        StubServer.proposalsOK = false
        let store = makeStore()
        await store.load("site", period: .d28)

        XCTAssertEqual(store.registry["site"]?.count, 1)
        XCTAssertNil(store.proposals["site"])
        XCTAssertNil(store.errors["site"])
    }

    func testDismissingDropsTheRowAndRecountsTheDemandOnOffer() async {
        // The total has to follow the list. A sum left at 570 beside one row reading 480
        // would be a claim about demand that no row supports.
        let store = makeStore()
        await store.load("site", period: .d28)

        await store.dismissProposals(["Mount Tracker App"], siteID: "site")

        XCTAssertEqual(store.proposals["site"]?.proposals.map(\.keyword), ["mount tracker addon"])
        XCTAssertEqual(store.proposals["site"]?.totals.proposals, 1)
        XCTAssertEqual(store.proposals["site"]?.totals.monthlyVolume, 480)
        XCTAssertNil(store.errors["site"])
    }

    func testDismissingNothingAsksTheServerNothing() async {
        let store = makeStore()
        await store.load("site", period: .d28)
        let before = StubServer.requests.count

        await store.dismissProposals([], siteID: "site")

        XCTAssertEqual(StubServer.requests.count, before,
                       "An empty dismissal is a no-op, not a request.")
    }

    func testAFailedHealthRefreshKeepsTheReportItAlreadyHad() async {
        // A server that regresses — redeployed older, or briefly broken — must not blank a
        // screen that was reading correctly a second earlier, and must not take the disk
        // cache down with it.
        let store = makeStore()
        await store.load("site", period: .d28)
        XCTAssertEqual(store.health["site"]?.totals.hasDemand, 1)

        StubServer.healthOK = false
        await store.refresh("site", period: .d28)

        XCTAssertEqual(store.health["site"]?.totals.hasDemand, 1,
                       "The held report stays until a newer one replaces it.")
        XCTAssertNotNil(store.healthErrors["site"])
    }

    func testASucceedingHealthFetchClearsAnEarlierReason() async {
        // The other direction: once the report arrives, the screen must stop apologising.
        StubServer.healthOK = false
        let store = makeStore()
        await store.load("site", period: .d28)
        XCTAssertNotNil(store.healthErrors["site"])

        StubServer.healthOK = true
        await store.refresh("site", period: .d28)

        XCTAssertNil(store.healthErrors["site"])
        XCTAssertEqual(store.health["site"]?.totals.hasDemand, 1)
    }

    func testTheHealthReportArrivesWithTheRegistry() async {
        // One fetch, so the two readings of the same plan can never be shown against each
        // other stale.
        let store = makeStore()
        await store.load("site", period: .d28)

        XCTAssertEqual(store.health["site"]?.totals.hasDemand, 1)
        XCTAssertEqual(store.health["site"]?.domainRating, 12)
        XCTAssertEqual(store.health["site"]?.keywords.first?.peakMonth, 10)
        XCTAssertEqual(store.health["site"]?.market?.label, "United States")
    }

    func testAWarmStoreShowsTheCachedListsBeforeTheServerAnswers() async {
        StubServer.queryLabel = "cached"
        await makeStore().load("site", period: .d28)

        StubServer.queryLabel = "fresh"
        StubServer.delay = .seconds(5)
        let store = makeStore()
        let key = RankingStore.KeywordsKey(siteID: "site", period: .d28)
        let load = Task { await store.load("site", period: .d28) }
        for _ in 0..<100 where store.keywords[key] == nil {
            await Task.yield()
        }

        XCTAssertEqual(store.keywords[key]?.first?.query, "cached")
        XCTAssertEqual(store.events[key]?.first?.name, "purchase")
        XCTAssertEqual(store.revenue[key]?.currency, "USD")
        XCTAssertEqual(store.registry["site"]?.first?.targetUrl, "/")
        XCTAssertTrue(store.loading.contains("site"), "The cache is shown, and the server is still asked.")

        load.cancel()
        await load.value
    }
}

// MARK: - Stub server

/// Answers the client's list requests from memory, after an optional delay.
private enum StubServer {
    nonisolated(unsafe) static var queryLabel = "query"
    nonisolated(unsafe) static var delay: Duration = .zero
    nonisolated(unsafe) static var requests: [URL] = []
    /// Set false to stand in for a server that does not serve /api/registry/health yet.
    nonisolated(unsafe) static var healthOK = true
    /// Set false to stand in for a server that does not serve /api/keywords/proposed yet.
    nonisolated(unsafe) static var proposalsOK = true

    /// The most requests that were open at the same time. This is what tells reads sent
    /// together from reads awaited one after another: awaited in turn they peak at one,
    /// whatever the wall clock says on a fast machine.
    nonisolated(unsafe) private static var openRequests = 0
    nonisolated(unsafe) private static var peak = 0
    /// Both counters are touched from the loader's queue and the delivery queue.
    private static let counter = NSLock()

    static func began() {
        counter.withLock {
            openRequests += 1
            peak = max(peak, openRequests)
        }
    }

    static func ended() {
        counter.withLock { openRequests -= 1 }
    }

    static var peakOpenRequests: Int {
        counter.withLock { peak }
    }

    static func reset() {
        queryLabel = "query"
        delay = .zero
        requests = []
        healthOK = true
        proposalsOK = true
        counter.withLock {
            openRequests = 0
            peak = 0
        }
    }

    static func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return APIClient(
            target: RemoteTarget(apiUrl: "https://stub.test", token: "token"),
            session: URLSession(configuration: configuration)
        )
    }

    static func body(for url: URL) -> Data {
        let json: String
        switch url.path {
        case "/api/queries":
            json = """
            {"generatedAt":"2026-09-08T07:00:00Z",
             "queries":[{"query":"\(queryLabel)","page":"/","brand":false,
                         "current":{"impressions":10,"clicks":1,"ctr":0.1,"position":5}}]}
            """
        case "/api/events":
            json = """
            {"generatedAt":"2026-09-08T07:00:00Z","windowDays":28,
             "events":[{"name":"purchase","current":12,"previous":9,"delta":3}]}
            """
        case "/api/revenue":
            json = """
            {"generatedAt":"2026-09-08T07:00:00Z","mode":"live",
             "revenue":{"provider":"polar","accountId":null,"ready":true,"reason":null},
             "windowDays":28,"currency":"USD",
             "days":[{"date":"2026-09-06","orders":2,"revenue":3998,"net":3998,"currency":"USD"}],
             "current":{"orders":2,"revenue":3998,"net":3998},
             "previous":{"orders":1,"revenue":1999,"net":1999},
             "delta":{"orders":1,"revenue":1999,"net":1999}}
            """
        case "/api/registry/health":
            // A server that predates this endpoint answers a 404, which decodes to
            // nothing. `healthOK = false` stands in for that, and the point of the case is
            // that the registry survives it.
            json = healthOK ? healthBody(queryLabel) : "{}"
        case "/api/keywords/proposed":
            // `proposalsOK = false` stands in for a server that predates this endpoint.
            // Unlike the health report, its absence is not reported: there is nothing to
            // say about keywords nobody has discovered.
            json = proposalsOK
                ? """
                {"generatedAt":"2026-09-08T07:00:00Z",
                 "totals":{"proposals":2,"monthlyVolume":570},
                 "proposals":[
                   {"keyword":"mount tracker addon","seed":"mount tracker",
                    "source":"suggestions","searchVolume":480,"difficulty":18,
                    "costPerClick":0.8,"competition":0.3,"intent":"informational",
                    "status":"proposed","discoveredAt":"2026-09-08T00:00:00Z"},
                   {"keyword":"mount tracker app","seed":"mount tracker",
                    "source":"related","searchVolume":90,"difficulty":null,
                    "costPerClick":null,"competition":null,"intent":null,
                    "status":"proposed","discoveredAt":"2026-09-08T00:00:00Z"}]}
                """
                : "{}"
        case "/api/keywords/dismiss":
            json = """
            {"dismissed":1}
            """
        case "/api/registry":
            json = """
            {"generatedAt":"2026-09-08T07:00:00Z",
             "targets":[{"targetUrl":"/","phase":"live","status":"published",
                         "window":{"impressions":10,"clicks":1,"ctr":0.1,"position":5}}]}
            """
        default:
            json = "{}"
        }
        return Data(json.utf8)
    }
}

private final class StubURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        StubServer.requests.append(url)
        StubServer.began()
        let data = StubServer.body(for: url)
        let delay = StubServer.delay
        // The protocol and its response are not Sendable; the test owns both, so handing
        // them to the delayed block is safe.
        nonisolated(unsafe) let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        nonisolated(unsafe) let loader = self
        // The whole duration, not only its whole seconds: a test that holds requests open
        // to see whether they overlap needs a delay shorter than a second.
        let held = TimeInterval(delay.components.seconds)
            + TimeInterval(delay.components.attoseconds) / 1e18
        DispatchQueue.global().asyncAfter(deadline: .now() + held) {
            StubServer.ended()
            loader.client?.urlProtocol(loader, didReceive: response, cacheStoragePolicy: .notAllowed)
            loader.client?.urlProtocol(loader, didLoad: data)
            loader.client?.urlProtocolDidFinishLoading(loader)
        }
    }

    override func stopLoading() {}
}

/// The health report for one keyword, matching the shape the server sends.
private func healthBody(_ keyword: String) -> String {
    """
    {"generatedAt":"2026-09-08T07:00:00Z","domainRating":12,
     "market":{"locationCode":2840,"languageCode":"en","label":"United States","provider":"labs"},
     "totals":{"keywords":1,"unmeasured":0,"unreported":0,"noDemand":0,"hasDemand":1,"monthlyVolume":720},
     "keywords":[{"keyword":"\(keyword)","targetUrl":"/","cluster":"c","priority":"P1",
                  "intent":"informational","verdict":"has-demand","searchVolume":720,
                  "difficulty":20,"difficultyGap":8,"costPerClick":null,"reportedIntent":null,
                  "peakMonth":10,"seasonality":1.8}]}
    """
}

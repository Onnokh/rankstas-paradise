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
        XCTAssertEqual(StubServer.requests.count - requestsBefore, 5,
                       "Keywords, events, revenue, the registry, and the plan's health.")

        await store.load("site", period: .d7)
        XCTAssertEqual(store.keywords[RankingStore.KeywordsKey(siteID: "site", period: .d7)]?.first?.query, "new",
                       "Showing the other period after a refresh fetches it again.")
    }

    func testAServerWithoutTheHealthEndpointStillGivesUpTheRegistry() async {
        // The endpoint is newer than the registry, so an older server 404s it. Losing the
        // registry list over a screen the reader may not even be on would be the wrong
        // trade, so the failure is swallowed and the planning screen shows its own empty
        // state.
        StubServer.healthOK = false
        let store = makeStore()
        await store.load("site", period: .d28)

        XCTAssertEqual(store.registry["site"]?.count, 1)
        XCTAssertNil(store.health["site"])
        XCTAssertNil(store.errors["site"], "A missing health endpoint is not an error to show.")
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

    static func reset() {
        queryLabel = "query"
        delay = .zero
        requests = []
        healthOK = true
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
        let data = StubServer.body(for: url)
        let delay = StubServer.delay
        // The protocol and its response are not Sendable; the test owns both, so handing
        // them to the delayed block is safe.
        nonisolated(unsafe) let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        nonisolated(unsafe) let loader = self
        DispatchQueue.global().asyncAfter(deadline: .now() + TimeInterval(delay.components.seconds)) {
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

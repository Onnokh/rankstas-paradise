import XCTest
@testable import RankstasParadise

@MainActor
final class OverviewStartupTests: XCTestCase {
    func testCachedOverviewIsVisibleWhileRefreshIsStillRunning() async {
        let cached = makeSnapshot(siteName: "Cached site")
        let refreshed = makeSnapshot(siteName: "Fresh site")
        let repository = StubOverviewRepository(
            cached: cached,
            update: OverviewUpdate(snapshot: refreshed, siteErrors: [:], cacheWarning: nil),
            refreshDelay: .seconds(5)
        )
        let model = OverviewModel(repository: repository)

        let startup = Task { await model.start() }
        for _ in 0..<100 where model.sites.isEmpty {
            await Task.yield()
        }

        XCTAssertEqual(model.sites.first?.name, "Cached site")
        XCTAssertTrue(model.isCached)
        XCTAssertTrue(model.isRefreshing)

        startup.cancel()
        await startup.value
    }

    func testColdStartAppliesTheRefreshedOverview() async {
        let refreshed = makeSnapshot(siteName: "Fresh site")
        let repository = StubOverviewRepository(
            cached: nil,
            update: OverviewUpdate(snapshot: refreshed, siteErrors: [:], cacheWarning: nil),
            refreshDelay: .zero
        )
        let model = OverviewModel(repository: repository)

        await model.start()

        XCTAssertEqual(model.sites.first?.name, "Fresh site")
        XCTAssertFalse(model.isCached)
        XCTAssertFalse(model.isRefreshing)
    }

    func testOverviewCacheRoundTripsTheSnapshot() throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = OverviewCache(fileURL: directory.appending(path: "overview.json"))
        let snapshot = makeSnapshot(siteName: "Cached site")

        try cache.save(snapshot)

        let restored = try XCTUnwrap(cache.load())
        XCTAssertEqual(restored.version, OverviewSnapshot.schemaVersion)
        XCTAssertEqual(restored.sites.first?.name, "Cached site")
        XCTAssertEqual(restored.dashboards["site"]?.history.first?.clicks, 12)
    }

    private func makeSnapshot(siteName: String) -> OverviewSnapshot {
        let site = Site(id: "site", name: siteName, origin: "https://example.com")
        let dashboard = DashboardEnvelope(
            generatedAt: "2026-09-03T12:00:00Z",
            mode: "live",
            summary: Summary(rows: 1, dates: 1),
            digest: OpportunityDigest(latestDate: "2026-09-02", signals: []),
            history: [
                HistoryDay(
                    date: "2026-09-02",
                    impressions: 120,
                    clicks: 12,
                    ctr: 0.1,
                    position: 4
                )
            ]
        )
        return OverviewSnapshot(sites: [site], dashboards: [site.id: dashboard])
    }
}

private struct StubOverviewRepository: OverviewLoading {
    let cached: OverviewSnapshot?
    let update: OverviewUpdate
    let refreshDelay: Duration

    func loadCached() async -> OverviewSnapshot? {
        cached
    }

    func refresh() async throws -> OverviewUpdate {
        try await Task.sleep(for: refreshDelay)
        return update
    }
}

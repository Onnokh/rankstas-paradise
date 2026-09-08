import XCTest
@testable import RankstasParadise

/// A settings backend that remembers what it was told, so the model's bookkeeping can be
/// checked without a server.
final class FakeSettingsBackend: SettingsBackend, @unchecked Sendable {
    var entries: [String: SiteEntry] = [:]
    var secrets: [String?: SecretsEnvelope] = [:]
    var storedSecrets: [String] = []

    private func site(for entry: SiteEntry) -> Site {
        Site(id: entry.id, name: entry.name ?? entry.id, origin: entry.origin ?? "https://\(entry.id).example")
    }

    func sites() async throws -> [Site] {
        entries.values.sorted { $0.id < $1.id }.map(site(for:))
    }

    func siteSettings(id: String) async throws -> SiteSettingsEnvelope {
        let entry = entries[id]!
        return SiteSettingsEnvelope(site: site(for: entry), settings: entry)
    }

    func saveSiteSettings(id: String, settings: SiteSettings) async throws -> SiteSettingsEnvelope {
        let entry = SiteEntry(id: id, settings: settings)
        entries[id] = entry
        return SiteSettingsEnvelope(site: site(for: entry), settings: entry)
    }

    func secrets(siteID: String?) async throws -> SecretsEnvelope {
        secrets[siteID] ?? SecretsEnvelope(encryption: EncryptionStatus(configured: true, reason: nil), slots: [])
    }

    func setSecret(siteID: String?, purpose: String, value: String) async throws -> SecretStatus {
        storedSecrets.append("\(siteID ?? "app"):\(purpose)=\(value)")
        let status = SecretStatus(scope: siteID, purpose: purpose, last4: String(value.suffix(4)), updatedAt: "2026-09-08T00:00:00Z")
        secrets[siteID] = SecretsEnvelope(
            encryption: EncryptionStatus(configured: true, reason: nil),
            slots: [SecretSlot(purpose: purpose, variable: "\(purpose.uppercased())_API_KEY", stored: status, inEnvironment: false)]
        )
        return status
    }
}

@MainActor
final class SettingsModelTests: XCTestCase {
    private final class Box: @unchecked Sendable {
        var notifications = 0
    }

    private func makeModel(backend: FakeSettingsBackend, box: Box, target: RemoteTarget? = RemoteTarget(apiUrl: "https://rp.example", token: "shared")) -> SettingsModel {
        SettingsModel(
            makeBackend: { _ in backend },
            loadTarget: {
                guard let target else { throw ConfigurationError.missing(path: "/nowhere/client.json") }
                return target
            },
            notify: { box.notifications += 1 }
        )
    }

    func testLoadFetchesSitesTheirSettingsAndKeys() async {
        let backend = FakeSettingsBackend()
        backend.entries["shop"] = SiteEntry(id: "shop", settings: SiteSettings(name: "Shop", siteUrl: "sc-domain:shop.example"))
        let model = makeModel(backend: backend, box: Box())

        await model.load()

        XCTAssertEqual(model.target?.apiUrl, "https://rp.example")
        XCTAssertEqual(model.sites.map(\.id), ["shop"])
        XCTAssertEqual(model.entries["shop"]?.name, "Shop")
        XCTAssertNotNil(model.siteSecrets["shop"])
        XCTAssertNotNil(model.appSecrets)
        XCTAssertNil(model.errorMessage)
    }

    func testAMissingTargetIsReportedNotFatal() async {
        let model = makeModel(backend: FakeSettingsBackend(), box: Box(), target: nil)
        await model.load()
        XCTAssertNil(model.target)
        XCTAssertNotNil(model.targetError)
        XCTAssertTrue(model.sites.isEmpty)
    }

    func testSavingASiteUpdatesTheListAndNotifies() async {
        let backend = FakeSettingsBackend()
        backend.entries["shop"] = SiteEntry(id: "shop", settings: SiteSettings(siteUrl: "sc-domain:shop.example"))
        let box = Box()
        let model = makeModel(backend: backend, box: box)
        await model.load()

        var settings = model.entries["shop"]!.settings
        settings.name = "Renamed"
        let saved = await model.saveSite(id: "shop", settings: settings)
        XCTAssertTrue(saved)
        XCTAssertEqual(model.sites.first?.name, "Renamed")
        XCTAssertEqual(model.entries["shop"]?.name, "Renamed")
        XCTAssertEqual(box.notifications, 1)
    }

    func testStoringAKeyReloadsTheSlotsAndKeepsTheValueOutOfTheModel() async {
        let backend = FakeSettingsBackend()
        backend.entries["shop"] = SiteEntry(id: "shop", settings: SiteSettings(siteUrl: "sc-domain:shop.example"))
        let model = makeModel(backend: backend, box: Box())
        await model.load()

        let stored = await model.setSecret(siteID: "shop", purpose: "polar", value: "polar-secret-1234")
        XCTAssertTrue(stored)
        XCTAssertEqual(model.siteSecrets["shop"]?.slots.first?.stored?.last4, "1234")
        XCTAssertEqual(backend.storedSecrets, ["shop:polar=polar-secret-1234"])
    }

    func testDraftKeepsProviderBlocksAndEditsTheirFields() {
        var stored = SiteSettings(siteUrl: "sc-domain:shop.example")
        stored.analytics = AnalyticsSettings(provider: "rybbit", siteId: "1", baseUrl: nil, timeZone: nil)
        stored.revenue = RevenueSettings(provider: "polar", accountId: nil, keyVariable: "POLAR_API_KEY_SHOP", baseUrl: nil, timeZone: nil)

        var draft = SiteSettingsPage.Draft(stored)
        draft.analyticsSiteId = "42"
        draft.brandTerms = "shop, the shop"
        let result = draft.settings(over: stored)

        XCTAssertEqual(result.analytics?.siteId, "42")
        XCTAssertEqual(result.analytics?.provider, "rybbit")
        XCTAssertEqual(result.revenue?.keyVariable, "POLAR_API_KEY_SHOP")
        XCTAssertEqual(result.brandTerms, ["shop", "the shop"])
    }

    func testBrandTermsRoundTrip() {
        XCTAssertEqual(BrandTerms.parse(" sleevy, sleevy app ,, "), ["sleevy", "sleevy app"])
        XCTAssertNil(BrandTerms.parse("  "))
        XCTAssertEqual(BrandTerms.format(["a", "b"]), "a, b")
        XCTAssertEqual(BrandTerms.format(nil), "")
    }
}

import Foundation

// The wire shapes of the settings routes (docs/http-api.md): a site's stored settings and
// the vendor-key slots. Mirrors `packages/domain/src/config/schema.ts` and
// `secrets/schema.ts`.

/// The `analytics` block of a site's settings.
struct AnalyticsSettings: Codable, Sendable, Equatable {
    var provider: String
    var siteId: String
    var baseUrl: String?
    var timeZone: String?
}

/// The `revenue` block of a site's settings.
struct RevenueSettings: Codable, Sendable, Equatable {
    var provider: String
    var accountId: String?
    var keyVariable: String?
    var baseUrl: String?
    var timeZone: String?
}

/// Everything a site entry holds except its id: what `PUT /api/sites/:id/settings` takes.
struct SiteSettings: Codable, Sendable, Equatable {
    var name: String?
    var siteUrl: String
    var origin: String?
    var sitemapUrl: String?
    var brandTerms: [String]?
    var analytics: AnalyticsSettings?
    var revenue: RevenueSettings?

    static let empty = SiteSettings(siteUrl: "")
}

/// A catalog entry: the id with its settings, as `POST /api/sites` takes and every settings
/// response returns under `settings`.
struct SiteEntry: Codable, Sendable, Equatable {
    var id: String
    var name: String?
    var siteUrl: String
    var origin: String?
    var sitemapUrl: String?
    var brandTerms: [String]?
    var analytics: AnalyticsSettings?
    var revenue: RevenueSettings?

    init(id: String, settings: SiteSettings) {
        self.id = id
        name = settings.name
        siteUrl = settings.siteUrl
        origin = settings.origin
        sitemapUrl = settings.sitemapUrl
        brandTerms = settings.brandTerms
        analytics = settings.analytics
        revenue = settings.revenue
    }

    var settings: SiteSettings {
        SiteSettings(
            name: name,
            siteUrl: siteUrl,
            origin: origin,
            sitemapUrl: sitemapUrl,
            brandTerms: brandTerms,
            analytics: analytics,
            revenue: revenue
        )
    }
}

struct SiteSettingsEnvelope: Codable, Sendable {
    let site: Site
    let settings: SiteEntry
}

/// What the server says about a stored vendor key. Never the value.
struct SecretStatus: Codable, Sendable, Equatable {
    let scope: String?
    let purpose: String
    let last4: String
    let updatedAt: String
}

struct EncryptionStatus: Codable, Sendable, Equatable {
    let configured: Bool
    let reason: String?
}

/// One vendor key a scope calls for: what it is for, the variable the adapter reads, what
/// is stored, and whether the server's environment would supply a fallback.
struct SecretSlot: Codable, Sendable, Equatable, Identifiable {
    let purpose: String
    let variable: String
    let stored: SecretStatus?
    let inEnvironment: Bool

    var id: String { purpose }
}

struct SecretsEnvelope: Codable, Sendable, Equatable {
    let encryption: EncryptionStatus
    let slots: [SecretSlot]
}

struct SecretEnvelope: Codable, Sendable {
    let secret: SecretStatus
}

/// The body of a key write.
struct SecretInput: Codable, Sendable {
    let value: String
}

/// The settings routes, as the settings model needs them. `APIClient` is the real one; tests
/// hand in a fake.
protocol SettingsBackend: Sendable {
    func sites() async throws -> [Site]
    func siteSettings(id: String) async throws -> SiteSettingsEnvelope
    func saveSiteSettings(id: String, settings: SiteSettings) async throws -> SiteSettingsEnvelope
    func secrets(siteID: String?) async throws -> SecretsEnvelope
    func setSecret(siteID: String?, purpose: String, value: String) async throws -> SecretStatus
}

extension APIClient: SettingsBackend {
    private func secretsPath(siteID: String?) -> String {
        siteID.map { "/api/sites/\($0)/secrets" } ?? "/api/secrets"
    }

    func siteSettings(id: String) async throws -> SiteSettingsEnvelope {
        try await get(path: "/api/sites/\(id)/settings")
    }

    func saveSiteSettings(id: String, settings: SiteSettings) async throws -> SiteSettingsEnvelope {
        try await send(method: "PUT", path: "/api/sites/\(id)/settings", body: settings)
    }

    func secrets(siteID: String?) async throws -> SecretsEnvelope {
        try await get(path: secretsPath(siteID: siteID))
    }

    func setSecret(siteID: String?, purpose: String, value: String) async throws -> SecretStatus {
        let envelope: SecretEnvelope = try await send(
            method: "PUT",
            path: "\(secretsPath(siteID: siteID))/\(purpose)",
            body: SecretInput(value: value)
        )
        return envelope.secret
    }
}

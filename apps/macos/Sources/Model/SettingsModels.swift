import Foundation

// The wire shapes of the settings routes (docs/http-api.md): a site's stored settings, the
// vendor-key slots, and the clients. Mirrors `packages/domain/src/config/schema.ts`,
// `secrets/schema.ts`, and `clients/schema.ts`.

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

struct SiteRemovedEnvelope: Codable, Sendable {
    let removed: String
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

struct SecretRemovedEnvelope: Codable, Sendable {
    let removed: String
}

/// The body of a key write.
struct SecretInput: Codable, Sendable {
    let value: String
}

/// One client with its own token. The token itself is only ever in `ClientCreatedEnvelope`.
struct ClientRecord: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let label: String
    let createdAt: String
    let lastUsedAt: String?
    let revokedAt: String?
}

struct ClientsEnvelope: Codable, Sendable {
    let clients: [ClientRecord]
}

struct ClientCreatedEnvelope: Codable, Sendable {
    let client: ClientRecord
    let token: String
}

struct ClientEnvelope: Codable, Sendable {
    let client: ClientRecord
}

struct ClientInput: Codable, Sendable {
    let label: String
}

/// The settings routes, as the settings model needs them. `APIClient` is the real one; tests
/// hand in a fake.
protocol SettingsBackend: Sendable {
    func sites() async throws -> [Site]
    func siteSettings(id: String) async throws -> SiteSettingsEnvelope
    func saveSiteSettings(id: String, settings: SiteSettings) async throws -> SiteSettingsEnvelope
    func addSite(_ entry: SiteEntry) async throws -> SiteSettingsEnvelope
    func removeSite(id: String) async throws
    func secrets(siteID: String?) async throws -> SecretsEnvelope
    func setSecret(siteID: String?, purpose: String, value: String) async throws -> SecretStatus
    func removeSecret(siteID: String?, purpose: String) async throws
    func clients() async throws -> [ClientRecord]
    func createClient(label: String) async throws -> ClientCreatedEnvelope
    func revokeClient(id: String) async throws -> ClientRecord
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

    func addSite(_ entry: SiteEntry) async throws -> SiteSettingsEnvelope {
        try await send(method: "POST", path: "/api/sites", body: entry)
    }

    func removeSite(id: String) async throws {
        let _: SiteRemovedEnvelope = try await send(method: "DELETE", path: "/api/sites/\(id)", body: Optional<Int>.none)
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

    func removeSecret(siteID: String?, purpose: String) async throws {
        let _: SecretRemovedEnvelope = try await send(
            method: "DELETE",
            path: "\(secretsPath(siteID: siteID))/\(purpose)",
            body: Optional<Int>.none
        )
    }

    func clients() async throws -> [ClientRecord] {
        let envelope: ClientsEnvelope = try await get(path: "/api/clients")
        return envelope.clients
    }

    func createClient(label: String) async throws -> ClientCreatedEnvelope {
        try await send(method: "POST", path: "/api/clients", body: ClientInput(label: label))
    }

    func revokeClient(id: String) async throws -> ClientRecord {
        let envelope: ClientEnvelope = try await send(method: "DELETE", path: "/api/clients/\(id)", body: Optional<Int>.none)
        return envelope.client
    }
}

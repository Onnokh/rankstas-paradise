import Foundation
import Observation

extension Notification.Name {
    /// Posted after a site was added, changed, or removed in Settings, so the main window
    /// fetches the catalog again.
    static let settingsDidChangeSites = Notification.Name("rp.settingsDidChangeSites")
}

/// The state behind the Settings window: the server target, every site's stored settings and
/// key slots, the app-wide keys, and the clients. One object for the whole window, so the
/// sidebar and the detail pages agree on what is loaded and what failed.
@MainActor
@Observable
final class SettingsModel {
    private(set) var target: RemoteTarget?
    private(set) var targetError: String?
    private(set) var sites: [Site] = []
    private(set) var entries: [Site.ID: SiteEntry] = [:]
    private(set) var siteSecrets: [Site.ID: SecretsEnvelope] = [:]
    private(set) var appSecrets: SecretsEnvelope?
    private(set) var clients: [ClientRecord] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    @ObservationIgnored private let makeBackend: @Sendable (RemoteTarget) -> any SettingsBackend
    @ObservationIgnored private let loadTarget: @Sendable () throws -> RemoteTarget
    @ObservationIgnored private let saveTarget: @Sendable (RemoteTarget) throws -> Void
    @ObservationIgnored private let notify: @Sendable () -> Void

    init(
        makeBackend: @escaping @Sendable (RemoteTarget) -> any SettingsBackend = { APIClient(target: $0) },
        loadTarget: @escaping @Sendable () throws -> RemoteTarget = { try ClientConfiguration.load() },
        saveTarget: @escaping @Sendable (RemoteTarget) throws -> Void = { try ClientConfiguration.save($0) },
        notify: @escaping @Sendable () -> Void = {
            NotificationCenter.default.post(name: .settingsDidChangeSites, object: nil)
        }
    ) {
        self.makeBackend = makeBackend
        self.loadTarget = loadTarget
        self.saveTarget = saveTarget
        self.notify = notify
    }

    private var backend: (any SettingsBackend)? {
        target.map(makeBackend)
    }

    // MARK: Loading

    /// Resolve the target and fetch everything the window shows. Safe to call again.
    func load() async {
        isLoading = true
        defer { isLoading = false }
        errorMessage = nil
        do {
            target = try loadTarget()
            targetError = nil
        } catch {
            target = nil
            targetError = error.localizedDescription
            return
        }
        guard let backend else { return }
        do {
            sites = try await backend.sites()
            appSecrets = try await backend.secrets(siteID: nil)
            clients = try await backend.clients()
            for site in sites {
                entries[site.id] = try await backend.siteSettings(id: site.id).settings
                siteSecrets[site.id] = try await backend.secrets(siteID: site.id)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: Server

    /// Keep a new server address and token for later launches, then load against them.
    func saveTarget(apiUrl: String, token: String) async {
        let target = RemoteTarget(apiUrl: apiUrl.trimmingCharacters(in: .whitespaces), token: token)
        do {
            try saveTarget(target)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Ask the server for a token of this Mac's own, keep it, and use it from now on. The
    /// shared token that made the request keeps working elsewhere.
    func adoptOwnToken(label: String) async {
        guard let backend, let target else { return }
        do {
            let created = try await backend.createClient(label: label)
            let own = RemoteTarget(apiUrl: target.apiUrl, token: created.token)
            try saveTarget(own)
            self.target = own
            clients = try await makeBackend(own).clients()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: Sites

    func saveSite(id: Site.ID, settings: SiteSettings) async -> Bool {
        guard let backend else { return false }
        do {
            let envelope = try await backend.saveSiteSettings(id: id, settings: settings)
            entries[id] = envelope.settings
            sites = sites.map { $0.id == id ? envelope.site : $0 }
            siteSecrets[id] = try await backend.secrets(siteID: id)
            notify()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func addSite(id: String, settings: SiteSettings) async -> Site? {
        guard let backend else { return nil }
        do {
            let envelope = try await backend.addSite(SiteEntry(id: id, settings: settings))
            entries[envelope.site.id] = envelope.settings
            sites.append(envelope.site)
            siteSecrets[envelope.site.id] = try await backend.secrets(siteID: envelope.site.id)
            notify()
            return envelope.site
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func removeSite(id: Site.ID) async -> Bool {
        guard let backend else { return false }
        do {
            try await backend.removeSite(id: id)
            sites.removeAll { $0.id == id }
            entries[id] = nil
            siteSecrets[id] = nil
            notify()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    // MARK: Vendor keys

    func setSecret(siteID: Site.ID?, purpose: String, value: String) async -> Bool {
        guard let backend else { return false }
        do {
            _ = try await backend.setSecret(siteID: siteID, purpose: purpose, value: value)
            await reloadSecrets(siteID: siteID, backend: backend)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func removeSecret(siteID: Site.ID?, purpose: String) async {
        guard let backend else { return }
        do {
            try await backend.removeSecret(siteID: siteID, purpose: purpose)
            await reloadSecrets(siteID: siteID, backend: backend)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func reloadSecrets(siteID: Site.ID?, backend: any SettingsBackend) async {
        do {
            let envelope = try await backend.secrets(siteID: siteID)
            if let siteID {
                siteSecrets[siteID] = envelope
            } else {
                appSecrets = envelope
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: Clients

    /// Issue a token for another client and hand it back once, for the sheet to show.
    func createClient(label: String) async -> ClientCreatedEnvelope? {
        guard let backend else { return nil }
        do {
            let created = try await backend.createClient(label: label)
            clients = try await backend.clients()
            return created
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func revokeClient(id: String) async {
        guard let backend else { return }
        do {
            _ = try await backend.revokeClient(id: id)
            clients = try await backend.clients()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func clearError() {
        errorMessage = nil
    }
}

/// Brand terms travel as an array; the form edits them as one comma-separated line.
enum BrandTerms {
    static func parse(_ text: String) -> [String]? {
        let terms = text
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return terms.isEmpty ? nil : terms
    }

    static func format(_ terms: [String]?) -> String {
        (terms ?? []).joined(separator: ", ")
    }
}

/// An optional text setting: blank in the form means absent on the wire.
enum OptionalText {
    static func fromForm(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? nil : trimmed
    }
}

import Foundation
import Observation

extension Notification.Name {
    /// Posted after a site was added, changed, or removed in Settings, so the main window
    /// fetches the catalog again.
    static let settingsDidChangeSites = Notification.Name("rp.settingsDidChangeSites")
}

/// The state behind the Settings window: every site's stored settings and key slots, and the
/// app-wide keys.
@MainActor
@Observable
final class SettingsModel {
    private(set) var target: RemoteTarget?
    private(set) var targetError: String?
    private(set) var sites: [Site] = []
    private(set) var entries: [Site.ID: SiteEntry] = [:]
    private(set) var siteSecrets: [Site.ID: SecretsEnvelope] = [:]
    private(set) var appSecrets: SecretsEnvelope?
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    @ObservationIgnored private let makeBackend: @Sendable (RemoteTarget) -> any SettingsBackend
    @ObservationIgnored private let loadTarget: @Sendable () throws -> RemoteTarget
    @ObservationIgnored private let notify: @Sendable () -> Void

    init(
        makeBackend: @escaping @Sendable (RemoteTarget) -> any SettingsBackend = { APIClient(target: $0) },
        loadTarget: @escaping @Sendable () throws -> RemoteTarget = { try ClientConfiguration.load() },
        notify: @escaping @Sendable () -> Void = {
            NotificationCenter.default.post(name: .settingsDidChangeSites, object: nil)
        }
    ) {
        self.makeBackend = makeBackend
        self.loadTarget = loadTarget
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
            for site in sites {
                entries[site.id] = try await backend.siteSettings(id: site.id).settings
                siteSecrets[site.id] = try await backend.secrets(siteID: site.id)
            }
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

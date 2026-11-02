import Foundation
import Observation

/// Whether this phone is signed in to a server, and to which.
///
/// Signing in asks the server for its sites before anything is stored, so a wrong address or a
/// revoked key is answered on the sign-in screen and never becomes the app's state.
@MainActor
@Observable
final class Account {
    private(set) var target: RemoteTarget?
    /// New on every sign-in. The shell is keyed on it, so a second server starts from empty
    /// stores rather than showing the first one's sites under the new name.
    private(set) var session = UUID()

    init() {
        #if DEBUG
        Self.seedFromEnvironment()
        #endif
        target = StoredTarget.load()
    }

    #if DEBUG
    /// A Debug build launched with `RP_API_URL` and `RP_TOKEN` — the Mac's two variables, set
    /// in the scheme or with `SIMCTL_CHILD_` on `simctl launch` — signs in with them once, so a
    /// fresh simulator shows real sites without typing a key on its keyboard.
    private static func seedFromEnvironment() {
        let environment = ProcessInfo.processInfo.environment
        guard StoredTarget.load() == nil,
              let apiUrl = environment["RP_API_URL"], !apiUrl.isEmpty,
              let token = environment["RP_TOKEN"], !token.isEmpty
        else { return }
        try? StoredTarget.save(RemoteTarget(apiUrl: apiUrl, token: token))
    }
    #endif

    func signIn(address: String, key: String) async throws {
        let target = RemoteTarget(apiUrl: Self.normalised(address), token: key.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !target.token.isEmpty else { throw SignInError.noKey }
        guard let url = target.baseURL, url.host() != nil else { throw SignInError.badAddress }
        _ = try await APIClient(target: target).sites()
        Self.clearCaches()
        try StoredTarget.save(target)
        self.target = target
        session = UUID()
    }

    func signOut() {
        StoredTarget.delete()
        Self.clearCaches()
        target = nil
    }

    /// "rp.example.com" means the server over HTTPS: a scheme is the one part of an address a
    /// reader leaves out.
    static func normalised(_ address: String) -> String {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.contains("://") ? trimmed : "https://" + trimmed
    }

    /// The stores keep what they read on disk, next to the overview snapshot. Another server's
    /// sites must never show, not even for the moment before a refresh lands.
    private static func clearCaches() {
        try? FileManager.default.removeItem(at: OverviewCache.defaultURL.deletingLastPathComponent())
    }
}

enum SignInError: LocalizedError {
    case badAddress
    case noKey

    var errorDescription: String? {
        switch self {
        case .badAddress: "Type the server's address, for example rp.example.com."
        case .noKey: "Paste an API key."
        }
    }
}

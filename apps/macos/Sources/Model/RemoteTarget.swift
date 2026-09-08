import Foundation

struct RemoteTarget: Codable, Sendable, Equatable {
    let apiUrl: String
    let token: String

    var baseURL: URL? {
        URL(string: apiUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
    }
}

/// Resolves where the app talks to and with which token. In order:
/// 1. `RP_API_URL` and `RP_TOKEN` from the process environment (a developer override);
/// 2. the store (the Keychain; see `RemoteTargetStore`);
/// 3. the legacy `client.json` in the app home, which the TUI and Electron client also read.
///    A target found there is copied into the store so later launches skip the file. The
///    file is left in place because the other clients still need it.
enum ClientConfiguration {
    static func load() throws -> RemoteTarget {
        try load(
            environment: ProcessInfo.processInfo.environment,
            store: KeychainRemoteTargetStore(),
            legacyFile: legacyFileURL(environment: ProcessInfo.processInfo.environment)
        )
    }

    /// Store a target chosen in the app (the settings page) for later launches.
    static func save(_ target: RemoteTarget) throws {
        try KeychainRemoteTargetStore().save(target)
    }

    static func load(
        environment: [String: String],
        store: RemoteTargetStore,
        legacyFile: URL
    ) throws -> RemoteTarget {
        if let apiUrl = environment["RP_API_URL"],
           let token = environment["RP_TOKEN"],
           !apiUrl.isEmpty,
           !token.isEmpty {
            return RemoteTarget(apiUrl: apiUrl, token: token)
        }

        if let stored = try store.load(), stored.isUsable {
            return stored
        }

        let target = try loadLegacyFile(at: legacyFile)
        // Best effort: a Keychain refusal must not stop the app from starting.
        try? store.save(target)
        return target
    }

    static func legacyFileURL(environment: [String: String]) -> URL {
        let configHome = environment["XDG_CONFIG_HOME"]
            .map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appending(path: ".config", directoryHint: .isDirectory)
        return configHome
            .appending(path: "rankstas-paradise", directoryHint: .isDirectory)
            .appending(path: "client.json", directoryHint: .notDirectory)
    }

    private static func loadLegacyFile(at configURL: URL) throws -> RemoteTarget {
        guard FileManager.default.fileExists(atPath: configURL.path) else {
            throw ConfigurationError.missing(path: configURL.path)
        }
        do {
            let target = try JSONDecoder().decode(RemoteTarget.self, from: Data(contentsOf: configURL))
            guard target.isUsable else {
                throw ConfigurationError.invalid(path: configURL.path)
            }
            return target
        } catch let error as ConfigurationError {
            throw error
        } catch {
            throw ConfigurationError.invalid(path: configURL.path)
        }
    }
}

private extension RemoteTarget {
    var isUsable: Bool { !token.isEmpty && baseURL != nil }
}

enum ConfigurationError: LocalizedError {
    case missing(path: String)
    case invalid(path: String)

    var errorDescription: String? {
        switch self {
        case .missing(let path):
            "No client configuration found. Set RP_API_URL and RP_TOKEN, or create \(path)."
        case .invalid(let path):
            "The client configuration at \(path) must contain valid apiUrl and token strings."
        }
    }
}

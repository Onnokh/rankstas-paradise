import Foundation

struct RemoteTarget: Codable, Sendable, Equatable {
    let apiUrl: String
    let token: String

    var baseURL: URL? {
        URL(string: apiUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
    }
}

/// Resolves where the app talks to and with which token: `RP_API_URL` and `RP_TOKEN` from the
/// process environment, else `client.json` in the app home, the same file the TUI reads.
/// No Keychain: every fresh build of an unsigned app would prompt for it.
enum ClientConfiguration {
    static func load() throws -> RemoteTarget {
        let environment = ProcessInfo.processInfo.environment
        return try load(environment: environment, file: fileURL(environment: environment))
    }

    static func load(environment: [String: String], file: URL) throws -> RemoteTarget {
        if let apiUrl = environment["RP_API_URL"],
           let token = environment["RP_TOKEN"],
           !apiUrl.isEmpty,
           !token.isEmpty {
            return RemoteTarget(apiUrl: apiUrl, token: token)
        }

        guard FileManager.default.fileExists(atPath: file.path) else {
            throw ConfigurationError.missing(path: file.path)
        }
        do {
            let target = try JSONDecoder().decode(RemoteTarget.self, from: Data(contentsOf: file))
            guard !target.token.isEmpty, target.baseURL != nil else {
                throw ConfigurationError.invalid(path: file.path)
            }
            return target
        } catch let error as ConfigurationError {
            throw error
        } catch {
            throw ConfigurationError.invalid(path: file.path)
        }
    }

    static func fileURL(environment: [String: String]) -> URL {
        let configHome = environment["XDG_CONFIG_HOME"]
            .map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appending(path: ".config", directoryHint: .isDirectory)
        return configHome
            .appending(path: "rankstas-paradise", directoryHint: .isDirectory)
            .appending(path: "client.json", directoryHint: .notDirectory)
    }
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

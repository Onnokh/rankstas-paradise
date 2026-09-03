import Foundation

struct RemoteTarget: Decodable, Sendable {
    let apiUrl: String
    let token: String

    var baseURL: URL? {
        URL(string: apiUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
    }
}

enum ClientConfiguration {
    static func load() throws -> RemoteTarget {
        let environment = ProcessInfo.processInfo.environment
        if let apiUrl = environment["RP_API_URL"],
           let token = environment["RP_TOKEN"],
           !apiUrl.isEmpty,
           !token.isEmpty {
            return RemoteTarget(apiUrl: apiUrl, token: token)
        }

        let configHome = environment["XDG_CONFIG_HOME"]
            .map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appending(path: ".config", directoryHint: .isDirectory)
        let configURL = configHome
            .appending(path: "rankstas-paradise", directoryHint: .isDirectory)
            .appending(path: "client.json", directoryHint: .notDirectory)

        guard FileManager.default.fileExists(atPath: configURL.path) else {
            throw ConfigurationError.missing(path: configURL.path)
        }

        do {
            let target = try JSONDecoder().decode(RemoteTarget.self, from: Data(contentsOf: configURL))
            guard !target.token.isEmpty, target.baseURL != nil else {
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


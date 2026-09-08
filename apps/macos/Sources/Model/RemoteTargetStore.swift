import Foundation
import Security

/// Where the app keeps the server address and bearer token between launches.
/// The real store is the login Keychain; tests hand in a memory store.
protocol RemoteTargetStore: Sendable {
    func load() throws -> RemoteTarget?
    func save(_ target: RemoteTarget) throws
    func clear() throws
}

/// One generic-password item holding the target as JSON, so the token never sits in a
/// plain file the way `client.json` did.
struct KeychainRemoteTargetStore: RemoteTargetStore {
    var service = "com.rankstasparadise.mac"
    var account = "remote-target"

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func load() throws -> RemoteTarget? {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data else { return nil }
            return try JSONDecoder().decode(RemoteTarget.self, from: data)
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.status(status)
        }
    }

    func save(_ target: RemoteTarget) throws {
        let data = try JSONEncoder().encode(target)
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert[kSecValueData as String] = data
            let added = SecItemAdd(insert as CFDictionary, nil)
            guard added == errSecSuccess else { throw KeychainError.status(added) }
            return
        }
        guard status == errSecSuccess else { throw KeychainError.status(status) }
    }

    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.status(status)
        }
    }
}

enum KeychainError: LocalizedError {
    case status(OSStatus)

    var errorDescription: String? {
        switch self {
        case .status(let status):
            let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
            return "The Keychain refused the request: \(message)"
        }
    }
}

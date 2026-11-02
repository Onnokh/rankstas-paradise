import Foundation
import os
import Security

/// The server and the key the reader signed in with, kept in the Keychain.
///
/// One item holds both, as the same JSON `client.json` holds on the Mac, so they cannot drift
/// apart. Every store asks for the target on every request (see `ClientConfiguration`), and a
/// feed polls every few seconds, so the item is read once and then held in memory.
enum StoredTarget {
    private static let service = "com.rankstasparadise.ios"
    private static let account = "remote-target"
    private static let memo = OSAllocatedUnfairLock<RemoteTarget?>(initialState: nil)

    static func load() -> RemoteTarget? {
        if let held = memo.withLock({ $0 }) { return held }
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let target = try? JSONDecoder().decode(RemoteTarget.self, from: data)
        else { return nil }
        memo.withLock { $0 = target }
        return target
    }

    static func save(_ target: RemoteTarget) throws {
        delete()
        var item = baseQuery
        item[kSecValueData as String] = try JSONEncoder().encode(target)
        // Readable while the phone is locked, for a refresh that lands after the screen goes
        // dark; never copied to another device in a backup.
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw StoredTargetError(status: status) }
        memo.withLock { $0 = target }
    }

    static func delete() {
        SecItemDelete(baseQuery as CFDictionary)
        memo.withLock { $0 = nil }
    }

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

struct StoredTargetError: LocalizedError {
    let status: OSStatus

    var errorDescription: String? {
        let reason = SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"
        return "Could not keep the key in the Keychain: \(reason)."
    }
}

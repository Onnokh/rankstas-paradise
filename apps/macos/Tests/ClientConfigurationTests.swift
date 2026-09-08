import XCTest
@testable import RankstasParadise

/// A store that only remembers; what the Keychain does in the app.
final class MemoryRemoteTargetStore: RemoteTargetStore, @unchecked Sendable {
    var stored: RemoteTarget?
    var saves = 0

    func load() throws -> RemoteTarget? { stored }
    func save(_ target: RemoteTarget) throws {
        stored = target
        saves += 1
    }
    func clear() throws { stored = nil }
}

final class ClientConfigurationTests: XCTestCase {
    private var directory: URL!
    private var legacyFile: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appending(path: "rp-client-config-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        legacyFile = directory.appending(path: "client.json", directoryHint: .notDirectory)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func writeLegacy(apiUrl: String, token: String) throws {
        let json = """
        {"apiUrl": "\(apiUrl)", "token": "\(token)"}
        """
        try json.write(to: legacyFile, atomically: true, encoding: .utf8)
    }

    func testEnvironmentWinsOverStoreAndFile() throws {
        let store = MemoryRemoteTargetStore()
        store.stored = RemoteTarget(apiUrl: "https://stored.example", token: "stored")
        try writeLegacy(apiUrl: "https://file.example", token: "file")

        let target = try ClientConfiguration.load(
            environment: ["RP_API_URL": "https://env.example", "RP_TOKEN": "env"],
            store: store,
            legacyFile: legacyFile
        )
        XCTAssertEqual(target, RemoteTarget(apiUrl: "https://env.example", token: "env"))
        XCTAssertEqual(store.saves, 0)
    }

    func testStoreIsUsedBeforeTheLegacyFile() throws {
        let store = MemoryRemoteTargetStore()
        store.stored = RemoteTarget(apiUrl: "https://stored.example", token: "stored")
        try writeLegacy(apiUrl: "https://file.example", token: "file")

        let target = try ClientConfiguration.load(environment: [:], store: store, legacyFile: legacyFile)
        XCTAssertEqual(target.apiUrl, "https://stored.example")
        XCTAssertEqual(store.saves, 0)
    }

    func testLegacyFileIsCopiedIntoTheStoreAndKept() throws {
        let store = MemoryRemoteTargetStore()
        try writeLegacy(apiUrl: "https://file.example", token: "file-token")

        let target = try ClientConfiguration.load(environment: [:], store: store, legacyFile: legacyFile)
        XCTAssertEqual(target, RemoteTarget(apiUrl: "https://file.example", token: "file-token"))
        XCTAssertEqual(store.stored, target)
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacyFile.path))
    }

    func testNothingConfiguredIsAnError() {
        let store = MemoryRemoteTargetStore()
        XCTAssertThrowsError(
            try ClientConfiguration.load(environment: [:], store: store, legacyFile: legacyFile)
        ) { error in
            XCTAssertTrue(error is ConfigurationError)
        }
    }

    func testAnEmptyStoredTokenFallsThrough() throws {
        let store = MemoryRemoteTargetStore()
        store.stored = RemoteTarget(apiUrl: "https://stored.example", token: "")
        try writeLegacy(apiUrl: "https://file.example", token: "file-token")

        let target = try ClientConfiguration.load(environment: [:], store: store, legacyFile: legacyFile)
        XCTAssertEqual(target.token, "file-token")
    }
}

import XCTest
@testable import RankstasParadise

final class ClientConfigurationTests: XCTestCase {
    private var directory: URL!
    private var file: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appending(path: "rp-client-config-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        file = directory.appending(path: "client.json", directoryHint: .notDirectory)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func write(apiUrl: String, token: String) throws {
        try """
        {"apiUrl": "\(apiUrl)", "token": "\(token)"}
        """.write(to: file, atomically: true, encoding: .utf8)
    }

    func testEnvironmentWinsOverTheFile() throws {
        try write(apiUrl: "https://file.example", token: "file")
        let target = try ClientConfiguration.load(
            environment: ["RP_API_URL": "https://env.example", "RP_TOKEN": "env"],
            file: file
        )
        XCTAssertEqual(target, RemoteTarget(apiUrl: "https://env.example", token: "env"))
    }

    func testTheFileIsReadWhenTheEnvironmentIsIncomplete() throws {
        try write(apiUrl: "https://file.example", token: "file-token")
        let target = try ClientConfiguration.load(environment: ["RP_API_URL": "https://env.example"], file: file)
        XCTAssertEqual(target, RemoteTarget(apiUrl: "https://file.example", token: "file-token"))
    }

    func testNothingConfiguredIsAnError() {
        XCTAssertThrowsError(try ClientConfiguration.load(environment: [:], file: file)) { error in
            XCTAssertTrue(error is ConfigurationError)
        }
    }

    func testAnEmptyTokenInTheFileIsInvalid() throws {
        try write(apiUrl: "https://file.example", token: "")
        XCTAssertThrowsError(try ClientConfiguration.load(environment: [:], file: file))
    }
}

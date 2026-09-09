import XCTest

@testable import RankstasParadise

@MainActor
final class PlanningPreferencesTests: XCTestCase {
    private var directory: URL!
    private var fileURL: URL!

    override func setUp() {
        super.setUp()
        directory = URL.temporaryDirectory.appending(
            path: "rp-planning-\(UUID().uuidString)",
            directoryHint: .isDirectory
        )
        fileURL = directory.appending(path: "planning.json", directoryHint: .notDirectory)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    func testNothingSetMeansTheDefaultDecides() {
        let preferences = PlanningPreferences(fileURL: fileURL)
        XCTAssertNil(
            preferences.reach(for: "shadertown"),
            "Absent, not zero: zero is a threshold the reader chose, and this is the absence of a choice."
        )
    }

    func testAReachSurvivesARelaunch() {
        // The whole reason this is not tab state: a judgement about a site should be made
        // once, not every launch.
        PlanningPreferences(fileURL: fileURL).setReach(18, for: "shadertown")

        let reopened = PlanningPreferences(fileURL: fileURL)
        XCTAssertEqual(reopened.reach(for: "shadertown"), 18)
    }

    func testEachSiteKeepsItsOwn() {
        let preferences = PlanningPreferences(fileURL: fileURL)
        preferences.setReach(18, for: "shadertown")
        preferences.setReach(60, for: "missingmounts")

        let reopened = PlanningPreferences(fileURL: fileURL)
        XCTAssertEqual(reopened.reach(for: "shadertown"), 18)
        XCTAssertEqual(reopened.reach(for: "missingmounts"), 60)
        XCTAssertNil(reopened.reach(for: "sleevy"))
    }

    func testClearingHandsTheThresholdBackToTheDefault() {
        // Not the same as setting it to the default's current value: a cleared threshold
        // follows the site's domain rating as that moves, and a pinned number cannot.
        let preferences = PlanningPreferences(fileURL: fileURL)
        preferences.setReach(18, for: "shadertown")
        preferences.clearReach(for: "shadertown")

        XCTAssertNil(preferences.reach(for: "shadertown"))
        XCTAssertNil(PlanningPreferences(fileURL: fileURL).reach(for: "shadertown"))
    }

    func testAnUnreadableFileReadsAsNoPreferencesRatherThanFailing() {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? Data("not json".utf8).write(to: fileURL)

        let preferences = PlanningPreferences(fileURL: fileURL)
        XCTAssertNil(preferences.reach(for: "shadertown"))
        // And it still works for this session, overwriting the unreadable file.
        preferences.setReach(12, for: "shadertown")
        XCTAssertEqual(PlanningPreferences(fileURL: fileURL).reach(for: "shadertown"), 12)
    }
}

import AppKit
import SwiftUI
import XCTest
@testable import RankstasParadise

/// Writes a still to /tmp so it can be looked at, and asserts the two things that were
/// wrong the first time: that it is dark, and that it is not blank below the header.
@MainActor
final class TabSnapshotsTests: XCTestCase {
    func testAStillIsDarkAndCarriesTheScreen() throws {
        let model = OverviewModel.preview
        let workspace = Workspace()
        workspace.reconcile(siteIDs: model.sites.map(\.id))
        let snapshots = TabSnapshots()

        let tab = TabID.site(model.sites[0].id)
        let image = try XCTUnwrap(snapshots.draw(
            AnyView(
                TabScreen(
                    tab: tab,
                    workspace: workspace,
                    model: model,
                    history: HistoryStore(),
                    rankings: RankingStore(),
                    preferences: PlanningPreferences(),
                    live: LiveStore(),
                    log: LogStore(),
                    favicons: FaviconStore(),
                    actions: .none
                )
                .environment(\.isTabPreview, true)
                .frame(width: TabSnapshots.cardSize.width, height: TabSnapshots.cardSize.height, alignment: .top)
                .background(Palette.panel)
            )
        ))

        let url = URL(fileURLWithPath: "/tmp/still-site.png")
        let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
        try rep.representation(using: .png, properties: [:])!.write(to: url)
        print("STILL written to \(url.path) — \(Int(image.size.width))x\(Int(image.size.height))")

        // The still must be drawn in the app's appearance, not ImageRenderer's default of
        // light. Judged against the appearance this machine is in, so the test says the same
        // thing in either mode.
        let isDark = (NSApp?.effectiveAppearance ?? NSAppearance(named: .darkAqua)!)
            .bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        let luma = Self.meanLuminance(rep)
        print("STILL mean luminance: \(String(format: "%.3f", luma)) — app is \(isDark ? "dark" : "light")")
        if isDark {
            XCTAssertLessThan(luma, 0.4, "The still came out light while the app is dark.")
        } else {
            XCTAssertGreaterThan(luma, 0.6, "The still came out dark while the app is light.")
        }

        // Not blank below the header: the band under the header row must carry contrast.
        let spread = Self.luminanceSpread(rep, fromFraction: 0.25, toFraction: 0.95)
        print("STILL contrast below the header: \(String(format: "%.3f", spread))")
        XCTAssertGreaterThan(spread, 0.05, "The still is empty below the header. ImageRenderer draws no ScrollView content.")
    }

    private func plainContent() -> AnyView {
        AnyView(Color.red.frame(width: 40, height: 20))
    }

    func testAStillIsRenderedAfterTheBeatAndNotDuringTheSwitch() async throws {
        let snapshots = TabSnapshots()
        snapshots.scheduleCard(.overview) { self.plainContent() }

        XCTAssertNil(
            snapshots.card(for: .overview),
            "A still drawn during the switch would put its 16 ms in front of the click."
        )

        try await Task.sleep(for: TabSnapshots.delay + .milliseconds(500))
        XCTAssertNotNil(snapshots.card(for: .overview))
    }

    /// Leaving and returning to a tab in quick succession must render once, not twice.
    func testASecondScheduleReplacesTheOneWaiting() async throws {
        let snapshots = TabSnapshots()
        var renders = 0
        for _ in 0..<5 {
            snapshots.scheduleCard(.site("a")) {
                renders += 1
                return self.plainContent()
            }
        }

        try await Task.sleep(for: TabSnapshots.delay + .milliseconds(500))
        XCTAssertEqual(renders, 1, "Each schedule rendered instead of replacing the one waiting.")
    }

    /// Nothing is drawn while the peek is on screen: a render there costs it a frame.
    func testNothingIsRenderedWhileThePeekIsOpen() async throws {
        let snapshots = TabSnapshots()
        var open = true
        snapshots.canRender = { !open }
        snapshots.scheduleCard(.overview) { self.plainContent() }

        try await Task.sleep(for: TabSnapshots.delay + .milliseconds(500))
        XCTAssertNil(snapshots.card(for: .overview), "A still was drawn while the peek was open.")

        open = false
        try await Task.sleep(for: .milliseconds(700))
        XCTAssertNotNil(snapshots.card(for: .overview), "The still never arrived after the peek closed.")
    }

    func testScheduleAllLeavesTheStillsItAlreadyHas() async throws {
        let snapshots = TabSnapshots()
        snapshots.scheduleCard(.overview) { self.plainContent() }
        try await Task.sleep(for: TabSnapshots.delay + .milliseconds(500))

        var rendered: [TabID] = []
        snapshots.scheduleAll([.overview, .site("a")]) { tab in
            rendered.append(tab)
            return self.plainContent()
        }
        try await Task.sleep(for: TabSnapshots.delay + .milliseconds(700))

        XCTAssertEqual(rendered, [.site("a")], "The overview already had a still.")
    }

    private static func meanLuminance(_ rep: NSBitmapImageRep) -> Double {
        var total = 0.0
        var count = 0.0
        for y in stride(from: 0, to: rep.pixelsHigh, by: 8) {
            for x in stride(from: 0, to: rep.pixelsWide, by: 8) {
                guard let colour = rep.colorAt(x: x, y: y) else { continue }
                total += Double(colour.brightnessComponent)
                count += 1
            }
        }
        return count == 0 ? 0 : total / count
    }

    /// Standard deviation of luminance over a horizontal band, as a stand-in for "something
    /// is drawn here". A blank band has none.
    private static func luminanceSpread(_ rep: NSBitmapImageRep, fromFraction: Double, toFraction: Double) -> Double {
        let top = Int(Double(rep.pixelsHigh) * fromFraction)
        let bottom = Int(Double(rep.pixelsHigh) * toFraction)
        var values: [Double] = []
        for y in stride(from: top, to: bottom, by: 4) {
            for x in stride(from: 0, to: rep.pixelsWide, by: 4) {
                guard let colour = rep.colorAt(x: x, y: y) else { continue }
                values.append(Double(colour.brightnessComponent))
            }
        }
        guard values.count > 1 else { return 0 }
        let mean = values.reduce(0, +) / Double(values.count)
        return (values.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(values.count)).squareRoot()
    }
}

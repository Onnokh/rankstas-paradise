import SwiftUI
import XCTest
@testable import RankstasParadise

/// `TabContentStack`'s body re-runs whenever a tab is activated, and hands each mounted
/// screen a fresh pair of `actions` closures. Without an equality that ignores them, every
/// mounted screen re-evaluated on the frame a tab is chosen.
@MainActor
final class TabScreenEqualityTests: XCTestCase {
    private func screen(
        tab: TabID = .overview,
        model: OverviewModel,
        live: LiveStore,
        actions: TabActions
    ) -> TabScreen {
        TabScreen(
            tab: tab,
            workspace: workspace,
            model: model,
            history: history,
            rankings: rankings,
            preferences: preferences,
            live: live,
            log: log,
            favicons: favicons,
            actions: actions
        )
    }

    private let workspace = Workspace()
    private let history = HistoryStore()
    private let rankings = RankingStore()
    private let preferences = PlanningPreferences()
    private let log = LogStore()
    private let favicons = FaviconStore()

    func testFreshActionsDoNotMakeAScreenUnequal() {
        let model = OverviewModel.preview
        let live = LiveStore()
        var activated: [TabID] = []
        let first = screen(model: model, live: live, actions: TabActions(activate: { activated.append($0) }, refresh: { _ in }))
        let second = screen(model: model, live: live, actions: TabActions(activate: { _ in }, refresh: { _ in }))
        XCTAssertEqual(first, second, "A new pair of action closures rebuilt the screen.")
        XCTAssertTrue(activated.isEmpty)
    }

    func testTheTabAndTheStoresStillTellScreensApart() {
        let model = OverviewModel.preview
        let live = LiveStore()
        let overview = screen(tab: .overview, model: model, live: live, actions: .none)
        XCTAssertNotEqual(overview, screen(tab: .site("a"), model: model, live: live, actions: .none))
        XCTAssertNotEqual(overview, screen(model: model, live: LiveStore(), actions: .none))
        XCTAssertNotEqual(overview, screen(model: OverviewModel.preview, live: live, actions: .none))
    }
}

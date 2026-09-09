import XCTest
@testable import RankstasParadise

/// The planning screen holds no list of its own: what it shows is a pure function of the
/// report, the filters, and the reach threshold.
final class PlanningListTests: XCTestCase {
    private func keyword(
        _ name: String,
        verdict: KeywordVerdict = .hasDemand,
        volume: Double? = 1_000,
        difficulty: Double? = 20,
        peakMonth: Int? = nil,
        seasonality: Double? = nil,
        cluster: String = "Mounts",
        target: String = "/mounts"
    ) -> KeywordHealth {
        KeywordHealth(
            keyword: name,
            targetUrl: target,
            cluster: cluster,
            priority: "P1",
            intent: "informational",
            verdict: verdict.rawValue,
            searchVolume: volume,
            difficulty: difficulty,
            difficultyGap: difficulty.map { $0 - 12 },
            costPerClick: nil,
            reportedIntent: nil,
            peakMonth: peakMonth,
            seasonality: seasonality
        )
    }

    // MARK: Filtering

    func testNoFilterKeepsTheServersOrder() {
        // The server already sorts demand first and strongest first, so this narrows and
        // re-ranks rather than deciding from scratch.
        let rows = PlanningList.rows([keyword("a"), keyword("b"), keyword("c")])
        XCTAssertEqual(rows.map(\.keyword), ["a", "b", "c"])
    }

    func testVerdictFilterKeepsOnlyWhatTheVendorSaid() {
        let all = [
            keyword("has", verdict: .hasDemand),
            keyword("none", verdict: .noDemand, volume: 0),
            keyword("rare", verdict: .unreported, volume: nil),
            keyword("cold", verdict: .unmeasured, volume: nil, difficulty: nil),
        ]
        XCTAssertEqual(
            PlanningList.rows(all, verdicts: [.noDemand]).map(\.keyword),
            ["none"]
        )
        // Two verdicts select the union, and an empty set is every row rather than none —
        // the reader has not said what they are looking for yet.
        XCTAssertEqual(
            PlanningList.rows(all, verdicts: [.noDemand, .unreported]).map(\.keyword),
            ["none", "rare"]
        )
        XCTAssertEqual(PlanningList.rows(all, verdicts: []).count, 4)
    }

    func testSearchMatchesTheKeywordItsClusterAndItsPage() {
        let all = [
            keyword("mount tracker", cluster: "Trackers", target: "/tracker"),
            keyword("collection log", cluster: "Logs", target: "/log"),
        ]
        XCTAssertEqual(PlanningList.rows(all, search: "tracker").count, 1)
        XCTAssertEqual(PlanningList.rows(all, search: "LOGS").map(\.keyword), ["collection log"])
        XCTAssertEqual(PlanningList.rows(all, search: "/log").map(\.keyword), ["collection log"])
        XCTAssertEqual(PlanningList.rows(all, search: "  ").count, 2)
    }

    func testTheReachFilterKeepsAKeywordWithNoDifficultyAtAll() {
        // Unknown is not the same as out of reach. Dropping it would hide the row instead
        // of showing the reader that nobody knows.
        let all = [
            keyword("easy", difficulty: 8),
            keyword("hard", difficulty: 70),
            keyword("unknown", difficulty: nil),
        ]
        XCTAssertEqual(
            PlanningList.rows(all, reach: 12).map(\.keyword),
            ["easy", "unknown"]
        )
    }

    // MARK: Counting

    func testMeasuredExcludesOnlyTheNeverAsked() {
        // The denominator of every claim the screen makes. A "1 of 3" is honest where a
        // "1 of 29" would not be, because the other 26 were never asked about.
        let all = [
            keyword("has", verdict: .hasDemand),
            keyword("none", verdict: .noDemand, volume: 0),
            keyword("rare", verdict: .unreported, volume: nil),
            keyword("cold", verdict: .unmeasured, volume: nil, difficulty: nil),
        ]
        XCTAssertEqual(PlanningList.measured(all).map(\.keyword), ["has", "none", "rare"])
    }

    func testWithinReachDoesNotCountAKeywordWithNoDifficulty() {
        // The mirror of the filter: for a count, unknown must not be claimed as reachable.
        let all = [keyword("easy", difficulty: 8), keyword("unknown", difficulty: nil)]
        XCTAssertEqual(PlanningList.withinReach(all, reach: 12).map(\.keyword), ["easy"])
    }

    // MARK: Seasons

    func testAFlatTermHasNoSeasonToShow() {
        // Every term has a highest month. Only some have a season, and below the threshold
        // a peak is noise the rows must not present as a publishing date.
        let flat = keyword("flat", peakMonth: 3, seasonality: 1.02)
        XCTAssertNil(flat.peakLabel(seasonalAbove: 1.25))
        // The same row does have a label when the bar is lowered.
        XCTAssertNotNil(flat.peakLabel(seasonalAbove: 1.0))
    }

    func testAKeywordWithNoHistoryHasNoPeak() {
        // Under two complete years the server sends nulls, and nothing may be invented.
        let cold = keyword("cold", peakMonth: nil, seasonality: nil)
        XCTAssertNil(cold.peakLabel(seasonalAbove: 1.25))
    }

    func testAnUnknownVerdictReadsAsNotMeasured() {
        // Claiming the vendor said something it did not is worse than admitting we have
        // not asked, so a word this build does not know falls back to unmeasured.
        let future = keyword("odd")
        let decoded = try? JSONDecoder().decode(
            KeywordHealth.self,
            from: Data("""
            {
              "keyword": "odd", "targetUrl": "/odd", "cluster": "c", "priority": "P1",
              "intent": "informational", "verdict": "something-new",
              "searchVolume": 10, "difficulty": null, "difficultyGap": null,
              "costPerClick": null, "reportedIntent": null
            }
            """.utf8)
        )
        XCTAssertEqual(decoded?.verdictKind, .unmeasured)
        XCTAssertEqual(future.verdictKind, .hasDemand)
    }

    func testAReportFromAnOlderServerStillDecodes() throws {
        // `peakMonth` and `seasonality` arrived after the endpoint did.
        let report = try JSONDecoder().decode(
            RegistryHealthReport.self,
            from: Data("""
            {
              "generatedAt": "2026-09-08T00:00:00.000Z",
              "domainRating": null,
              "totals": {
                "keywords": 1, "unmeasured": 1, "unreported": 0,
                "noDemand": 0, "hasDemand": 0, "monthlyVolume": 0
              },
              "keywords": [{
                "keyword": "cold", "targetUrl": "/cold", "cluster": "c", "priority": "",
                "intent": "", "verdict": "unmeasured", "searchVolume": null,
                "difficulty": null, "difficultyGap": null, "costPerClick": null,
                "reportedIntent": null
              }]
            }
            """.utf8)
        )
        XCTAssertNil(report.market)
        XCTAssertNil(report.keywords[0].peakMonth)
        XCTAssertEqual(report.keywords[0].verdictKind, .unmeasured)
    }
}

// MARK: - What the screen is looking at

extension PlanningListTests {
    func testAReportMeansTheScreenShowsThePlan() {
        XCTAssertEqual(
            PlanningList.state(report: emptyReport, reason: nil, loading: false),
            .plan,
            "A report with no keywords is still a report: an empty plan is a fact about the plan."
        )
    }

    func testNoReportAndNoReasonIsWaiting() {
        XCTAssertEqual(PlanningList.state(report: nil, reason: nil, loading: true), .waiting)
        XCTAssertEqual(PlanningList.state(report: nil, reason: nil, loading: false), .waiting)
    }

    func testNoReportWithAReasonNamesTheReason() {
        // The bug this type exists for: the screen used to reach this state and say "the
        // registry maps no keywords yet", which is a claim about the plan — and it was
        // wrong about a registry holding forty-five rows.
        XCTAssertEqual(
            PlanningList.state(report: nil, reason: "404 not found", loading: false),
            .unavailable("404 not found")
        )
    }

    func testAHeldReportOutranksAnOlderFailure() {
        // A refresh that failed leaves both a report and a reason. The report is what the
        // reader can act on, so it wins.
        XCTAssertEqual(
            PlanningList.state(report: emptyReport, reason: "404 not found", loading: false),
            .plan
        )
    }

    private var emptyReport: RegistryHealthReport {
        RegistryHealthReport(
            generatedAt: "2026-09-08T00:00:00Z",
            market: nil,
            domainRating: nil,
            totals: KeywordTotals(
                keywords: 0,
                unmeasured: 0,
                unreported: 0,
                noDemand: 0,
                hasDemand: 0,
                monthlyVolume: 0
            ),
            keywords: []
        )
    }
}

// MARK: - Proposals

extension PlanningListTests {
    func testTheSearchBoxMatchesAProposalsKeywordAndItsSeed() {
        let rows = [
            proposal("mount tracker addon", seed: "mount tracker"),
            // A related run answers with terms that need not contain the seed, which is
            // the case the seed match exists for — and the only one that tests it.
            proposal("gold farming route", seed: "wow gold"),
        ]

        XCTAssertEqual(
            PlanningList.proposals(rows, search: "addon").map(\.keyword),
            ["mount tracker addon"]
        )
        // The seed is how a reader finds the group a run just produced, and this needle
        // appears in neither keyword.
        XCTAssertEqual(
            PlanningList.proposals(rows, search: "wow gold").map(\.keyword),
            ["gold farming route"]
        )
        XCTAssertEqual(PlanningList.proposals(rows, search: "  ").count, 2,
                       "A blank filter keeps every row.")
    }

    func testAHardProposalIsKeptRatherThanHidden() {
        // The reach slider colours a difficulty; it never removes a row. Hiding one would
        // answer "what is within reach" with a list that cannot be checked.
        let rows = [proposal("mount tracker addon", seed: "mount tracker", difficulty: 90)]
        XCTAssertEqual(PlanningList.proposals(rows).count, 1)
    }

    func testAProposalRowComparesEveryValueItDraws() {
        // The row is drawn with `.equatable()`, so this `==` decides whether a changed
        // number reaches the screen. It ignores the dismiss closure, which cannot be
        // compared — everything else it draws has to be in here.
        let row = ProposalRow(proposal: proposal("a", seed: "s", difficulty: 20), reach: 10, onDismiss: {})

        XCTAssertEqual(row, ProposalRow(proposal: row.proposal, reach: 10, onDismiss: {}),
                       "The closure is not part of it: two rows over the same values are equal.")
        XCTAssertNotEqual(row, ProposalRow(proposal: row.proposal, reach: 40, onDismiss: {}),
                          "Reach colours the difficulty, so moving it has to redraw the row.")
        XCTAssertNotEqual(
            row,
            ProposalRow(proposal: proposal("a", seed: "s", difficulty: 90), reach: 10, onDismiss: {}),
            "A re-sync that changed the difficulty has to reach the screen."
        )
    }

    private func proposal(
        _ keyword: String,
        seed: String,
        difficulty: Double? = 20
    ) -> KeywordProposal {
        KeywordProposal(
            keyword: keyword,
            seed: seed,
            source: "suggestions",
            searchVolume: 100,
            difficulty: difficulty,
            costPerClick: nil,
            competition: nil,
            intent: nil,
            status: "proposed",
            discoveredAt: "2026-09-08T00:00:00Z"
        )
    }
}

// MARK: - The brand verdict

extension PlanningListTests {
    func testABrandVerdictIsItsOwnFilterAndItsOwnAdvice() {
        // The bug: a planned keyword that is the site's own name read as "Not measured",
        // whose help text tells the reader to configure a DataForSEO key and sync. That
        // would change nothing — a brand query is never asked about, key or no key.
        XCTAssertEqual(KeywordVerdict(rawValue: "brand"), .brand)
        XCTAssertEqual(KeywordVerdict.brand.label, "Brand")
        XCTAssertTrue(
            PlanningList.verdictFilters.contains(.brand),
            "The chips are built from verdictFilters, so a verdict missing there cannot be filtered on."
        )
    }

    func testTheFiltersLeaveOutTheVerdictsThatCannotBeActedOn() {
        // A chip that can only ever read 0 is worse than no chip. The vendor answers a term
        // nobody searches for with no volume at all — `unreported` — so `no-demand` needs a
        // literal zero it does not send; and `unmeasured` is our missing key, not a verdict
        // on a keyword, which is what the Measured figure above the list reports.
        XCTAssertFalse(PlanningList.verdictFilters.contains(.noDemand))
        XCTAssertFalse(PlanningList.verdictFilters.contains(.unmeasured))
        // Both are still verdicts a row can carry and name for itself.
        XCTAssertEqual(KeywordVerdict(rawValue: "no-demand"), .noDemand)
        XCTAssertEqual(KeywordVerdict(rawValue: "unmeasured"), .unmeasured)
    }

    func testAVerdictThisBuildDoesNotKnowStillReadsAsUnmeasured() {
        // A newer server may add a verdict. Claiming the vendor said something it did not
        // is worse than admitting we have not asked.
        let unknown = KeywordHealth(
            keyword: "x",
            targetUrl: "/x",
            cluster: "c",
            priority: "P1",
            intent: "informational",
            verdict: "something-new",
            searchVolume: nil,
            difficulty: nil,
            difficultyGap: nil,
            costPerClick: nil,
            reportedIntent: nil
        )
        XCTAssertEqual(unknown.verdictKind, .unmeasured)
    }
}

// MARK: - The default reach

extension PlanningListTests {
    func testTheDefaultReachNeverSitsBelowTheFloor() {
        // A domain rating of 0 does not mean the site can only rank for keywords scored 0.
        // Taking the rating literally at the bottom of the scale hides the entire long tail
        // a new site can actually take — which, at DR 0, is the only thing it can take.
        XCTAssertEqual(PlanningList.defaultReach(domainRating: 0), 10)
        XCTAssertEqual(PlanningList.defaultReach(domainRating: 4.7), 10)
        XCTAssertEqual(PlanningList.defaultReach(domainRating: nil), 10)
    }

    func testAboveTheFloorTheDefaultIsTheRatingItself() {
        // No headroom added: above the floor the rating is the honest comparison, and the
        // reader can move the slider if they disagree.
        XCTAssertEqual(PlanningList.defaultReach(domainRating: 34), 34)
        XCTAssertEqual(PlanningList.defaultReach(domainRating: 71.5), 71.5)
    }
}

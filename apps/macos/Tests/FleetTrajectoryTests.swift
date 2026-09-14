import XCTest
@testable import RankstasParadise

/// The Overview draws one source across every project, so the projects' runs have to be added
/// on one axis. These are the things that adding can get wrong.
@MainActor
final class FleetTrajectoryTests: XCTestCase {
    // MARK: Adding runs

    private func run(_ values: [Double], previous: [Double] = [], isAverage: Bool = false) -> ComparisonRun {
        let start = Date(timeIntervalSince1970: 1_757_000_000)
        return ComparisonRun(
            current: values.enumerated().map { index, value in
                ComparisonRun.Point(date: start.addingTimeInterval(Double(index) * 86_400), value: value)
            },
            previous: previous,
            previousIsAverage: isAverage
        )
    }

    func testRunsOfOneLengthAddPointForPoint() {
        let sum = ComparisonRun.sum([run([1, 2, 3]), run([10, 20, 30])])
        XCTAssertEqual(sum.current.map(\.value), [11, 22, 33])
    }

    /// The one that matters: a site that started counting last week has a shorter run, and
    /// both runs end on the same day. Added from the end, it lifts only its own days.
    func testAShorterRunOnlyAddsToTheDaysItMeasured() {
        let sum = ComparisonRun.sum([run([1, 1, 1, 1]), run([5, 5])])
        XCTAssertEqual(sum.current.map(\.value), [1, 1, 6, 6])
        XCTAssertEqual(sum.current.count, 4, "The sum runs as long as the longest run, not as long as the shortest.")
    }

    func testTheLastDayOfTheSumIsTheLastDayOfTheLongestRun() {
        let long = run([1, 2, 3])
        let sum = ComparisonRun.sum([long, run([9])])
        XCTAssertEqual(sum.current.map(\.date), long.current.map(\.date))
    }

    func testAnEmptyRunAddsNothing() {
        let sum = ComparisonRun.sum([run([2, 2]), run([])])
        XCTAssertEqual(sum.current.map(\.value), [2, 2])
    }

    func testNoRunAtAllIsAnEmptySum() {
        XCTAssertTrue(ComparisonRun.sum([run([]), run([])]).current.isEmpty)
    }

    /// A fleet with no earlier period must read as "nothing to compare", not as a run of
    /// zeros — a grey line along the floor would say the fleet was flat at nothing.
    func testTheEarlierRunIsEmptyWhenNoRunHasOne() {
        let sum = ComparisonRun.sum([run([1, 2]), run([3, 4])])
        XCTAssertTrue(sum.previous.isEmpty)
    }

    func testTheEarlierRunsAddTheSameWay() {
        let sum = ComparisonRun.sum([
            run([1, 1, 1], previous: [2, 2, 2]),
            run([1, 1], previous: [3, 3]),
        ])
        XCTAssertEqual(sum.previous, [2, 5, 5])
    }

    /// The sales report keeps the period before as one total, spread evenly. One such run in
    /// the sum makes the sum a stand-in too, and the chart dashes it rather than claiming
    /// days nobody measured.
    func testOneStandInMakesTheSumAStandIn() {
        let sum = ComparisonRun.sum([
            run([1, 1], previous: [1, 1]),
            run([2, 2], previous: [2, 2], isAverage: true),
        ])
        XCTAssertTrue(sum.previousIsAverage)
    }

    // MARK: The fleet's figures

    private func project(
        id: String,
        clicks: Growth,
        visits: Growth? = nil,
        sales: (Growth, String)? = nil
    ) -> ProjectTrajectory {
        ProjectTrajectory(
            site: Site(id: id, name: id, origin: "https://\(id).test"),
            errorMessage: nil,
            clicks: clicks,
            clicksRun: run([clicks.current]),
            visits: visits,
            visitsRun: run(visits.map { [$0.current] } ?? []),
            sales: sales.map { growth, currency in
                ProjectTrajectory.Sales(growth: growth, currency: currency, run: run([growth.current]))
            },
            plan: nil
        )
    }

    func testTheFleetAddsEveryProjectsPeriodAndThePeriodBefore() {
        let fleet = FleetTrajectory.make([
            project(id: "a", clicks: Growth(current: 10, previous: 5)),
            project(id: "b", clicks: Growth(current: 4, previous: 1)),
        ])
        XCTAssertEqual(fleet.clicks.current, 14)
        XCTAssertEqual(fleet.clicks.previous, 6)
    }

    /// A source no project has is nothing to draw, and the strip says so rather than showing
    /// a zero that reads as "nobody bought anything".
    func testASourceNoProjectHasIsNil() {
        let fleet = FleetTrajectory.make([project(id: "a", clicks: Growth(current: 1, previous: nil))])
        XCTAssertNil(fleet.visits)
        XCTAssertNil(fleet.sales)
        XCTAssertNil(fleet.growth(.sales))
    }

    /// One project with a provider is enough for the fleet to have the source; the projects
    /// without it add nothing rather than counting as zero.
    func testOneProjectWithTheSourceGivesTheFleetTheSource() {
        let fleet = FleetTrajectory.make([
            project(id: "a", clicks: Growth(current: 1, previous: nil)),
            project(id: "b", clicks: Growth(current: 1, previous: nil), visits: Growth(current: 90, previous: 60)),
        ])
        XCTAssertEqual(fleet.visits?.current, 90)
        XCTAssertEqual(fleet.visits?.previous, 60)
    }

    func testThePeriodBeforeIsNilWhenNoProjectHasOne() {
        let fleet = FleetTrajectory.make([
            project(id: "a", clicks: Growth(current: 3, previous: nil)),
            project(id: "b", clicks: Growth(current: 2, previous: nil)),
        ])
        XCTAssertEqual(fleet.clicks.current, 5)
        XCTAssertNil(fleet.clicks.previous, "A fleet that only started counting has nothing to be set against.")
    }

    func testTheCurrencyComesFromTheProjectThatSells() {
        let fleet = FleetTrajectory.make([
            project(id: "a", clicks: Growth(current: 1, previous: nil)),
            project(id: "b", clicks: Growth(current: 1, previous: nil), sales: (Growth(current: 1_000, previous: 500), "EUR")),
        ])
        XCTAssertEqual(fleet.currency, "EUR")
        XCTAssertEqual(fleet.sales?.current, 1_000)
    }

    /// The figure over the chart and the figures on the tiles are one arithmetic, so they
    /// cannot drift apart: the fleet is the projects added.
    func testTheFleetIsTheProjectsAdded() {
        let projects = [
            project(id: "a", clicks: Growth(current: 10, previous: 5), visits: Growth(current: 100, previous: 80)),
            project(id: "b", clicks: Growth(current: 7, previous: 9), visits: Growth(current: 20, previous: 10)),
        ]
        let fleet = FleetTrajectory.make(projects)
        for source in OverviewSource.allCases {
            let tiles = projects.compactMap { $0.growth(source)?.current }.reduce(0, +)
            XCTAssertEqual(fleet.growth(source)?.current ?? 0, tiles, "\(source.label) disagrees with its tiles")
        }
    }
}

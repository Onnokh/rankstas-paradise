import XCTest
@testable import RankstasParadise

/// The log screen holds no list of its own: what it shows is a pure function of the entries
/// the store holds, the kind filter and the search.
final class LogListTests: XCTestCase {
    private func entry(
        _ id: Int,
        date: String,
        path: String = "/a",
        kind: String = "publish",
        note: String = "",
        createdAt: String? = nil
    ) -> LogEntry {
        LogEntry(id: id, date: date, path: path, kind: kind, note: note, createdAt: createdAt)
    }

    private func decode<T: Decodable>(_ json: String, as type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    // MARK: Wire

    func testLogListReportDecodesTheServersShape() throws {
        // The array is called `actions` on the wire even though it holds Notes too. That is
        // the server's name, and the screen has to read it as the whole record — reading it
        // as actions only would drop every note.
        let report = try decode("""
        {"generatedAt":"2026-09-08T07:00:00.000Z","mode":"live",
         "actions":[
           {"id":12,"date":"2026-09-08","path":"/shaders","kind":"publish","note":"","createdAt":"2026-09-08T09:14:02.000Z"},
           {"id":11,"date":"2026-09-07","path":"/pricing","kind":"note","note":"Checkout looked slow","createdAt":"2026-09-08T09:13:00.000Z"}
         ]}
        """, as: LogListReport.self)

        XCTAssertEqual(report.actions.count, 2)
        XCTAssertEqual(report.actions[0].id, 12)
        XCTAssertEqual(report.actions[0].knownKind, .publish)
        XCTAssertEqual(report.actions[0].note, "")
        XCTAssertEqual(report.actions[1].knownKind, .note)
        XCTAssertFalse(report.actions[1].isAction)
    }

    func testAnEntryWithoutCreatedAtStillDecodes() throws {
        // A snapshot written before the field, and an older server, must still read.
        let report = try decode("""
        {"generatedAt":"2026-09-08T07:00:00.000Z","mode":"live",
         "actions":[{"id":1,"date":"2026-09-08","path":"/a","kind":"publish","note":""}]}
        """, as: LogListReport.self)
        XCTAssertNil(report.actions[0].createdAt)
    }

    // MARK: Kinds

    func testEveryKindExceptNoteIsAnAction() {
        // An Action changed the page and can be measured before and after; a Note only says
        // something about it. The whole screen leans on that split, so it is stated once.
        for kind in LogKind.allCases where kind != .note {
            XCTAssertTrue(kind.isAction, "\(kind.rawValue) should be an action")
        }
        XCTAssertFalse(LogKind.note.isAction)
    }

    func testAnUnknownKindIsKeptAndReadsAsAnAction() {
        // A word this build does not know still happened. Dropping the row would understate
        // the work done on the page, and counting it as a note would understate it too:
        // every kind the server has ever had except `note` is an action.
        let unknown = entry(1, date: "2026-09-08", kind: "schema-markup")
        XCTAssertNil(unknown.knownKind)
        XCTAssertTrue(unknown.isAction)
        // The server's own word is what the badge shows.
        XCTAssertEqual(unknown.kindLabel, "schema-markup")
        XCTAssertEqual(LogList.rows([unknown]).count, 1)
    }

    // MARK: Order

    func testOrdersNewestDayFirstAndTheLastWrittenFirstWithinADay() {
        // The server sends `order by date desc, id desc`. This restates it rather than
        // trusting it, so a cached list and a fresh one read the same whichever arrived
        // first — the cache is written in whatever order it was received.
        let rows = LogList.rows([
            entry(1, date: "2026-09-01"),
            entry(7, date: "2026-09-08"),
            entry(4, date: "2026-09-08"),
            entry(2, date: "2026-09-05"),
        ])
        XCTAssertEqual(rows.map(\.id), [7, 4, 2, 1])
    }

    func testGroupsRowsIntoDaysKeepingTheirOrder() {
        let rows = LogList.rows([
            entry(1, date: "2026-09-01"),
            entry(7, date: "2026-09-08"),
            entry(4, date: "2026-09-08"),
        ])
        let days = LogList.days(rows)
        XCTAssertEqual(days.map(\.date), ["2026-09-08", "2026-09-01"])
        XCTAssertEqual(days.first?.entries.map(\.id), [7, 4])
        XCTAssertEqual(days.last?.entries.map(\.id), [1])
    }

    // MARK: Filters

    func testNoKindSelectedKeepsEveryEntry() {
        // Nothing selected is the honest default: the reader has not said what they are
        // looking for yet.
        let entries = [
            entry(1, date: "2026-09-08", kind: "publish"),
            entry(2, date: "2026-09-08", kind: "note"),
            entry(3, date: "2026-09-08", kind: "schema-markup"),
        ]
        XCTAssertEqual(LogList.rows(entries).count, 3)
    }

    func testAKindFilterDropsAnUnknownKindRatherThanClaimingItMatches() {
        // An entry whose kind this build does not know was never matched against the chosen
        // kind, so it cannot be shown as one of them.
        let entries = [
            entry(1, date: "2026-09-08", kind: "publish"),
            entry(2, date: "2026-09-08", kind: "schema-markup"),
        ]
        XCTAssertEqual(LogList.rows(entries, kinds: [.publish]).map(\.id), [1])
    }

    func testFiltersByKindPathAndSearch() {
        let entries = [
            entry(1, date: "2026-09-08", path: "/shaders", kind: "publish", note: "First cut"),
            entry(2, date: "2026-09-07", path: "/pricing", kind: "note", note: "Checkout looked slow"),
            entry(3, date: "2026-09-06", path: "/shaders", kind: "title-change", note: ""),
        ]
        XCTAssertEqual(LogList.rows(entries, kinds: [.note, .publish]).map(\.id), [1, 2])
        XCTAssertEqual(LogList.rows(entries, path: "/shaders").map(\.id), [1, 3])
        // The search reads the path, the note and the kind's label — the three things a row
        // shows, so what is on screen is what can be searched.
        XCTAssertEqual(LogList.rows(entries, search: "pricing").map(\.id), [2])
        XCTAssertEqual(LogList.rows(entries, search: "SLOW").map(\.id), [2])
        XCTAssertEqual(LogList.rows(entries, search: "title change").map(\.id), [3])
        XCTAssertEqual(LogList.rows(entries, search: "  shaders  ").map(\.id), [1, 3])
        XCTAssertEqual(LogList.rows(entries, search: "nothing here").count, 0)
    }

    // MARK: Tally

    func testTallyCountsActionsNotesAndPagesApart() {
        let entries = [
            entry(1, date: "2026-09-08", path: "/shaders", kind: "publish"),
            entry(2, date: "2026-09-07", path: "/shaders", kind: "note"),
            entry(3, date: "2026-09-06", path: "/pricing", kind: "internal-links"),
        ]
        let tally = LogList.tally(entries)
        XCTAssertEqual(tally.entries, 3)
        XCTAssertEqual(tally.actions, 2)
        XCTAssertEqual(tally.notes, 1)
        // Two entries against one page is one page, not two: the figure says whether the
        // work is spread or concentrated.
        XCTAssertEqual(tally.pages, 2)
        XCTAssertEqual(tally.latest, "2026-09-08")
    }

    func testTallyOfAnEmptyRecordNamesNoLatestDay() {
        let tally = LogList.tally([])
        XCTAssertEqual(tally.entries, 0)
        XCTAssertNil(tally.latest)
        XCTAssertEqual(tally.pages, 0)
    }

    func testKindCountsIgnoreUnknownKindsAndAreTakenBeforeTheFilter() {
        // The chips' figures must not move as chips are pressed, so they are counted off
        // the whole record.
        let counts = LogList.kindCounts([
            entry(1, date: "2026-09-08", kind: "publish"),
            entry(2, date: "2026-09-08", kind: "publish"),
            entry(3, date: "2026-09-08", kind: "note"),
            entry(4, date: "2026-09-08", kind: "schema-markup"),
        ])
        XCTAssertEqual(counts[.publish], 2)
        XCTAssertEqual(counts[.note], 1)
        XCTAssertNil(counts[.titleChange])
        XCTAssertEqual(counts.values.reduce(0, +), 3)
    }

    // MARK: Dates

    func testParsesADayInTheReadersOwnZone() {
        // The Log's dates are days, not instants: the day the work was done, wherever the
        // person doing it was. Parsed as local midnight so "today" means today here.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Amsterdam") ?? .gmt
        let parsed = LogList.parse("2026-09-08", calendar: calendar)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(calendar.component(.day, from: parsed!), 8)
        XCTAssertNil(LogList.parse("not a date"))
        XCTAssertNil(LogList.parse("2026-09"))
    }

    func testRecordedAtReadsSqlitesOwnTimestampAsUTC() {
        // `created_at` defaults to SQLite's `current_timestamp`: "YYYY-MM-DD HH:MM:SS" in
        // UTC with no zone written on it. Read as local it lands hours out, and near
        // midnight that names the wrong day — which is the whole point of the field.
        let written = LogList.recordedAt("2026-08-21 07:50:43")
        XCTAssertEqual(written, Date(timeIntervalSince1970: 1_787_298_643))

        // An ISO instant is read too: only the column's default produces the space form.
        XCTAssertEqual(
            LogList.recordedAt("2026-08-21T07:50:43.000Z"),
            Date(timeIntervalSince1970: 1_787_298_643)
        )
        XCTAssertNil(LogList.recordedAt("whenever"))
    }

    func testDayLabelNamesTodayAndYesterday() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Amsterdam") ?? .gmt
        let today = calendar.date(from: DateComponents(year: 2026, month: 9, day: 8))!
        XCTAssertEqual(LogList.dayLabel("2026-09-08", today: today, calendar: calendar), "Today")
        XCTAssertEqual(LogList.dayLabel("2026-09-07", today: today, calendar: calendar), "Yesterday")
        // Any other day is spelled out, and a date this build cannot read leaves the
        // screen showing the server's own string.
        XCTAssertNotNil(LogList.dayLabel("2026-09-01", today: today, calendar: calendar))
        XCTAssertNil(LogList.dayLabel("whenever", today: today, calendar: calendar))
    }
}

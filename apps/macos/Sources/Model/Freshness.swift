import Foundation

/// When what a pane shows was last read from the server.
///
/// One reading for the whole app, because the reader asks the question once: is what I am
/// looking at current? Every page used to answer it in its own footer, in its own words —
/// "Updated 13m ago" on a project, "Feed updated 1m ago" on the Realtime — beside a count of
/// the sites that had loaded, which said nothing once they all had.
///
/// What is newest depends on the pane, so the answer does too: a project and the Overview are
/// drawn from dashboards the server generates, and the Realtime is drawn from the feed it
/// polls. Each names the moment its own figures were true.
enum Freshness {
    /// Takes the two things it reads rather than the stores that hold them, so the label in
    /// the bar is invalidated by a feed landing and the window around it is not.
    static func updatedAt(_ tab: TabID, overviews: [SiteOverview], feeds: [Site.ID: LiveFeed]) -> Date? {
        switch tab {
        case .overview:
            // The whole fleet is on the page, so the oldest reading is the honest one: the
            // page is only as current as the project that has waited longest.
            generated(overviews).min()
        case .realtime:
            feeds.values.compactMap(\.fetchedAt).max()
        case .site(let siteID):
            generated(overviews.filter { $0.id == siteID }).first
        }
    }

    private static func generated(_ overviews: [SiteOverview]) -> [Date] {
        overviews.compactMap { overview in
            overview.dashboard.flatMap { Instant.parse($0.generatedAt) }
        }
    }
}

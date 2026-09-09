import Foundation
import Observation

/// The reader's own planning thresholds, per site, kept across launches.
///
/// Its own store rather than a field on `SiteTabState`, for one reason: tab state is
/// deliberately not persisted — it is where you were, and being returned to yesterday's
/// scroll position is not a feature. A reach threshold is the opposite: a judgement about
/// a site that took thought, and having to make it again every launch is what would make
/// the reader stop moving the slider and distrust the tile instead.
///
/// A file under Application Support, like every other thing this app keeps, and written on
/// every change: the value is 8 bytes a site, so there is nothing to batch.
@MainActor
@Observable
final class PlanningPreferences {
    /// The difficulty each site's reader counts as within reach. Absent means they have
    /// not said, and `PlanningList.defaultReach` decides.
    private(set) var reach: [Site.ID: Double] = [:]

    @ObservationIgnored private let fileURL: URL

    init(fileURL: URL = PlanningPreferences.defaultURL) {
        self.fileURL = fileURL
        if let data = try? Data(contentsOf: fileURL),
           let stored = try? JSONDecoder().decode([Site.ID: Double].self, from: data) {
            reach = stored
        }
    }

    static let defaultURL = OverviewCache.defaultURL
        .deletingLastPathComponent()
        .appending(path: "planning.json", directoryHint: .notDirectory)

    /// What this site's reader has chosen, or nil when they have not.
    func reach(for siteID: Site.ID) -> Double? { reach[siteID] }

    func setReach(_ value: Double, for siteID: Site.ID) {
        reach[siteID] = value
        write()
    }

    /// Forget the reader's value, so the default decides again — and follows the site's
    /// domain rating as that moves.
    func clearReach(for siteID: Site.ID) {
        reach.removeValue(forKey: siteID)
        write()
    }

    private func write() {
        // A preference that cannot be saved is not worth an error on screen: the slider
        // still works for this session, and the next launch starts from the default.
        try? FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        guard let data = try? JSONEncoder().encode(reach) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}

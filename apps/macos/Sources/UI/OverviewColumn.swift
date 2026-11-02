import SwiftUI

/// The Overview in the peek's grid: the fleet's figures in a column beside the project cards,
/// and at its foot the one link that opens the page.
///
/// No card. The Overview is no tab, so it has no pill to grow from, and there is a whole page
/// behind it now: a card here would be a second, smaller dashboard standing among the real
/// projects and claiming to be one of them. The column reads as the grid's other half instead
/// — "Overview" is written on the line "Projects" is written on — and says only what the
/// cards beside it cannot, which is the fleet as one property. Each project's own figures are
/// on its own card, an arm's length away, so repeating them here would be saying twice what
/// the grid already says once. See `PeekLayout.overviewColumnFrame`.
///
/// The figures are the days each dashboard carries, which is what is on disk at launch and
/// the period the Overview's own page opens on. How they moved is the page's business: a move
/// needs the earlier period, and that is in the daily series — summing hundreds of days per
/// site would then sit in the path of every frame of the peek.
struct OverviewColumn: View {
    let model: OverviewModel
    /// The height of the grid's heading band, so "Overview" sits on the "Projects" line.
    let headingHeight: CGFloat
    let onOpen: () -> Void

    /// Every site's days read as one property: clicks and impressions sum, the rate and the
    /// position are the fleet's own, weighted by impressions — see `DashboardStats`.
    private var totals: DashboardStats {
        DashboardStats(days: model.overviews.flatMap { $0.dashboard?.history ?? [] })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Overview")
                .font(.title3.weight(.semibold))
                .frame(height: headingHeight, alignment: .leading)

            // The figures share the height the grid gives the column, but only so far: past
            // the gap they are one list rather than four figures adrift, so the slack of a
            // tall window collects above the link instead, which keeps the foot.
            figure(OverviewSource.clicks.label, GlanceFigure.count(totals.clicks), dot: OverviewSource.clicks.dot)
            gap
            figure(OverviewSource.impressions.label, GlanceFigure.count(totals.impressions), dot: OverviewSource.impressions.dot)
            gap
            figure(OverviewSource.ctr.label, GlanceFigure.rate(totals.ctr))
            gap
            figure("Position", GlanceFigure.position(totals.position))

            Spacer(minLength: 20)

            link
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Overview")
    }

    /// The room between two figures: enough to part them, never enough to strand them.
    private var gap: some View {
        Spacer(minLength: 14)
            .frame(maxHeight: 34)
    }

    /// One figure, written the way the Overview's page writes it — the label over the value,
    /// the series dot before the label, the digits monospaced. Not `Metric` itself: that one
    /// is `fixedSize`, which a column this narrow cannot promise, so the value here gives way
    /// rather than run past the column's edge.
    private func figure(_ label: String, _ value: String, dot: Color? = nil) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if let dot {
                    Circle()
                        .fill(dot)
                        .frame(width: 6, height: 6)
                }
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Text(value)
                .font(.system(size: 24, weight: .medium))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .accessibilityElement(children: .combine)
    }

    /// The only thing in the column that can be clicked, and it says where it goes. It wears
    /// the app's one clickable look, so it answers the pointer the way every other surface
    /// does; its fill is pulled back under the words by the same inset it is padded with, so
    /// the link's text stands on the column's line like everything above it.
    private var link: some View {
        Button(action: onOpen) {
            HStack(spacing: 5) {
                Text("To overview")
                    .font(.callout.weight(.medium))
                Image(systemName: "arrow.right")
                    .font(.system(size: 11, weight: .semibold))
            }
            .padding(.horizontal, Self.linkInset)
            .padding(.vertical, 6)
        }
        .clickableSurface(cornerRadius: 6)
        .padding(.leading, -Self.linkInset)
        .accessibilityHint("Open the overview")
    }

    private static let linkInset: CGFloat = 7
}

import SwiftUI

/// The overview tab's peek content: totals across all sites and one quick line per site.
/// Lays itself out for whatever size the card gives it, from a strip card to the tall grid card.
struct OverviewSummaryCard: View {
    let model: OverviewModel

    private var totals: (clicks: Double, impressions: Double) {
        model.overviews.reduce(into: (0, 0)) { partial, overview in
            partial.clicks += overview.stats?.clicks ?? 0
            partial.impressions += overview.stats?.impressions ?? 0
        }
    }

    var body: some View {
        GeometryReader { proxy in
            // Laid out once at a logical size and scaled as a transform, like the site previews.
            // The scale follows the width only: the height is what grows while a tab opens,
            // and content must stay put while the card reveals it.
            let unit = max(0.6, proxy.size.width / 200)
            let logical = CGSize(width: proxy.size.width / unit, height: proxy.size.height / unit)

            content
                .frame(width: logical.width, height: logical.height, alignment: .topLeading)
                .scaleEffect(unit, anchor: .topLeading)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Total(label: "Clicks", value: totals.clicks)
                Spacer(minLength: 0)
                Total(label: "Impressions", value: totals.impressions)
            }

            VStack(spacing: 4) {
                ForEach(model.overviews) { overview in
                    HStack(spacing: 8) {
                        Text(overview.site.name)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        Text(overview.stats.map { $0.clicks.formatted(.number.precision(.fractionLength(0))) } ?? "—")
                            .monospacedDigit()
                        Text(overview.stats.map { $0.impressions.formatted(.number.precision(.fractionLength(0))) } ?? "—")
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 40, alignment: .trailing)
                    }
                    .font(.system(size: 11))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.primary.opacity(0.05), in: .rect(cornerRadius: 5))
                }
            }

            Spacer(minLength: 0)
        }
        .padding(10)
    }
}

private struct Total: View {
    let label: String
    let value: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value.formatted(.number.precision(.fractionLength(0))))
                .font(.system(size: 22, weight: .semibold))
                .monospacedDigit()
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
        }
    }
}

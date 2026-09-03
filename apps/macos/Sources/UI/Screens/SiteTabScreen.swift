import SwiftUI

struct SiteTabScreen: View {
    let overview: SiteOverview
    @Bindable var state: SiteTabState
    let isRefreshing: Bool
    let onRefresh: () -> Void

    var body: some View {
        // The path lives in the tab state, so the screen you were on survives a switch.
        // A plain switch instead of NavigationStack: that would install a window toolbar,
        // which clashes with the tab bar owning the title bar area.
        ZStack {
            if let screen = state.path.last {
                switch screen {
                case .opportunities:
                    OpportunitiesScreen(overview: overview) {
                        state.path.removeLast()
                    }
                    .transition(.move(edge: .trailing))
                }
            } else {
                root
                    .transition(.move(edge: .leading))
            }
        }
        .clipped()
        .animation(.snappy(duration: 0.3), value: state.path)
    }

    private var root: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(overview.site.name)
                        .font(.largeTitle)
                    Text(overview.site.origin)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }

                Spacer()

                if isRefreshing {
                    ProgressView()
                        .controlSize(.small)
                }

                Button("Refresh", systemImage: "arrow.clockwise", action: onRefresh)
                    .disabled(isRefreshing)
            }

            SiteMetrics(overview: overview)

            OpportunitiesBox(overview: overview) {
                state.path.append(.opportunities)
            }

            Spacer()
        }
        .padding(24)
    }
}

private struct SiteMetrics: View {
    let overview: SiteOverview

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: 4)

    var body: some View {
        LazyVGrid(columns: columns, spacing: 12) {
            MetricCard(title: "Clicks", value: overview.stats?.clicks, style: .number)
            MetricCard(title: "Impressions", value: overview.stats?.impressions, style: .number)
            MetricCard(title: "CTR", value: overview.stats?.ctr, style: .percent)
            MetricCard(title: "Position", value: overview.stats?.position, style: .decimal)
        }
    }
}

private struct OpportunitiesBox: View {
    let overview: SiteOverview
    let onShowAll: () -> Void

    private var signals: [OpportunitySignal] {
        overview.dashboard?.digest.signals ?? []
    }

    var body: some View {
        GroupBox {
            if signals.isEmpty {
                ContentUnavailableView(
                    "No opportunities",
                    systemImage: "checkmark.circle",
                    description: Text("Nothing needs attention in the current snapshot.")
                )
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(signals.prefix(5).enumerated()), id: \.offset) { _, signal in
                        Label(signal.label, systemImage: "sparkles")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
            }
        } label: {
            HStack {
                Text("Opportunities")
                Spacer()
                if !signals.isEmpty {
                    Button("Show all \(signals.count)", action: onShowAll)
                        .controlSize(.small)
                }
            }
        }
    }
}

/// Sub-screen listing every opportunity signal of a site.
private struct OpportunitiesScreen: View {
    let overview: SiteOverview
    let onBack: () -> Void

    @Environment(\.isTabPreview) private var isPreview

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Button(overview.site.name, systemImage: "chevron.left", action: onBack)
                    .keyboardShortcut(isPreview ? nil : KeyboardShortcut("[", modifiers: .command))
                Spacer()
            }

            Text("Opportunities")
                .font(.largeTitle)

            let signals = overview.dashboard?.digest.signals ?? []
            if signals.isEmpty {
                ContentUnavailableView(
                    "No opportunities",
                    systemImage: "checkmark.circle",
                    description: Text("Nothing needs attention in the current snapshot.")
                )
            } else {
                List(Array(signals.enumerated()), id: \.offset) { _, signal in
                    HStack {
                        Label(signal.label, systemImage: "sparkles")
                        Spacer()
                        Text(signal.kind)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(24)
    }
}

private struct MetricCard: View {
    let title: String
    let value: Double?
    let style: MetricText.Style

    var body: some View {
        GroupBox(title) {
            MetricText(value, style: style)
                .font(.title2)
                .fontWeight(.semibold)
                .padding(.vertical, 8)
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview("Site tab") {
    SiteTabScreen(
        overview: OverviewModel.preview.overviews[0],
        state: SiteTabState(siteID: "sleevy"),
        isRefreshing: false,
        onRefresh: {}
    )
    .frame(width: 980, height: 560)
}

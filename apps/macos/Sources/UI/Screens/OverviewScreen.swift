import SwiftUI

struct OverviewScreen: View {
    let model: OverviewModel
    @Bindable var state: OverviewTabState
    let onOpenSite: (Site.ID) -> Void

    @Environment(\.isTabPreview) private var isPreview

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading) {
                    Text("Overview")
                        .font(.title)
                    Text("All Ranksta's Paradise sites")
                        .foregroundStyle(.secondary)
                }

                Spacer()

                if model.isRefreshing, !model.sites.isEmpty {
                    ProgressView()
                        .controlSize(.small)
                }

                Button("Refresh", systemImage: "arrow.clockwise") {
                    Task { await model.refresh() }
                }
                .disabled(model.isRefreshing)
            }

            if model.sites.isEmpty, model.errorMessage == nil {
                Spacer()
                ProgressView("Loading sites…")
                    .frame(maxWidth: .infinity)
                Spacer()
            } else if let errorMessage = model.errorMessage, model.sites.isEmpty {
                Spacer()
                ErrorView(message: errorMessage) {
                    Task { await model.refresh() }
                }
                Spacer()
            } else if isPreview {
                // A real Table is an AppKit view that re-lays out on every animation tick.
                // Previews are scaled and inert, so a lookalike is enough and far cheaper.
                SiteTableLookalike(overviews: model.overviews, selection: state.selectedSiteID)
            } else {
                SiteTable(
                    overviews: model.overviews,
                    selection: $state.selectedSiteID,
                    onOpen: onOpenSite
                )

                HStack {
                    Text("\(model.loadedSiteCount) of \(model.sites.count) sites loaded")
                    if model.isCached {
                        Text("Cached")
                    }
                    Spacer()
                    Text("Double-click a site to open it")
                    if let errorMessage = model.errorMessage {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }
                .font(.callout)
                .foregroundStyle(.secondary)
            }
        }
        .padding(24)
    }
}

private struct SiteTable: View {
    let overviews: [SiteOverview]
    @Binding var selection: Site.ID?
    let onOpen: (Site.ID) -> Void

    var body: some View {
        Table(overviews, selection: $selection) {
            TableColumn("Site") { overview in
                VStack(alignment: .leading, spacing: 2) {
                    Text(overview.site.name)
                    Text(overview.errorMessage ?? overview.site.origin)
                        .font(.caption)
                        .foregroundStyle(overview.errorMessage == nil ? Color.secondary : Color.red)
                        .lineLimit(1)
                        .help(overview.errorMessage ?? overview.site.origin)
                }
            }
            .width(min: 180, ideal: 240)

            TableColumn("Clicks") { overview in
                MetricText(overview.stats?.clicks, style: .number)
            }
            .width(70)

            TableColumn("Impressions") { overview in
                MetricText(overview.stats?.impressions, style: .number)
            }
            .width(90)

            TableColumn("CTR") { overview in
                MetricText(overview.stats?.ctr, style: .percent)
            }
            .width(65)

            TableColumn("Position") { overview in
                MetricText(overview.stats?.position, style: .decimal)
            }
            .width(70)

            TableColumn("Opportunities") { overview in
                Text(overview.dashboard?.digest.signals.count.formatted() ?? "—")
                    .monospacedDigit()
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .width(95)
        }
        // Double-click or Return opens the site; a single click only selects the row,
        // so the selection survives as part of the overview tab's state.
        .contextMenu(forSelectionType: Site.ID.self) { _ in
        } primaryAction: { siteIDs in
            if let siteID = siteIDs.first {
                onOpen(siteID)
            }
        }
    }
}

/// Plain SwiftUI stand-in for `SiteTable`, used only in scaled previews.
private struct SiteTableLookalike: View {
    let overviews: [SiteOverview]
    let selection: Site.ID?

    private let columns: [(String, CGFloat)] = [
        ("Clicks", 70), ("Impressions", 90), ("CTR", 65), ("Position", 70), ("Opportunities", 95)
    ]

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                Text("Site")
                    .frame(maxWidth: .infinity, alignment: .leading)
                ForEach(columns, id: \.0) { column in
                    Text(column.0)
                        .frame(width: column.1, alignment: .leading)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)

            Divider()

            ForEach(Array(overviews.enumerated()), id: \.element.id) { index, overview in
                HStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(overview.site.name)
                        Text(overview.site.origin)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    MetricText(overview.stats?.clicks, style: .number).frame(width: 70)
                    MetricText(overview.stats?.impressions, style: .number).frame(width: 90)
                    MetricText(overview.stats?.ctr, style: .percent).frame(width: 65)
                    MetricText(overview.stats?.position, style: .decimal).frame(width: 70)
                    Text(overview.dashboard?.digest.signals.count.formatted() ?? "—")
                        .monospacedDigit()
                        .frame(width: 95, alignment: .trailing)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(
                    overview.id == selection
                        ? Color.accentColor.opacity(0.35)
                        : (index.isMultiple(of: 2) ? Color.clear : Color.primary.opacity(0.04))
                )
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5), in: .rect(cornerRadius: 6))
    }
}

struct MetricText: View {
    enum Style {
        case number
        case percent
        case decimal
    }

    let value: Double?
    let style: Style

    init(_ value: Double?, style: Style) {
        self.value = value
        self.style = style
    }

    var body: some View {
        Text(formattedValue)
            .monospacedDigit()
            .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var formattedValue: String {
        guard let value else { return "—" }
        switch style {
        case .number:
            return value.formatted(.number.precision(.fractionLength(0)))
        case .percent:
            return value.formatted(.percent.precision(.fractionLength(1)))
        case .decimal:
            return value.formatted(.number.precision(.fractionLength(1)))
        }
    }
}

private struct ErrorView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title)
                .foregroundStyle(.secondary)
            Text(message)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
            Button("Try Again", action: retry)
        }
        .frame(maxWidth: .infinity)
    }
}

import SwiftUI

struct ContentView: View {
    @State private var model: OverviewModel

    init(model: OverviewModel = OverviewModel()) {
        _model = State(initialValue: model)
    }

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
            } else {
                SiteTable(overviews: model.overviews)

                HStack {
                    Text("\(model.loadedSiteCount) of \(model.sites.count) sites loaded")
                    if model.isCached {
                        Text("Cached")
                    }
                    Spacer()
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
        .task {
            await model.start()
        }
    }
}

private struct SiteTable: View {
    let overviews: [SiteOverview]

    var body: some View {
        Table(overviews) {
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
    }
}

private struct MetricText: View {
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

#Preview("Overview") {
    ContentView(model: .preview)
        .frame(width: 980, height: 480)
}

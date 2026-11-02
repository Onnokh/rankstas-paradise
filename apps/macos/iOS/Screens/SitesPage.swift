import SwiftUI

/// Every site, one quiet row each: the Mac's tab bar, laid down as a list. A row says how the
/// site does over four weeks against the four before, so the list is worth reading before a tap.
struct SitesPage: View {
    @Environment(OverviewModel.self) private var model
    @Environment(HistoryStore.self) private var history

    var body: some View {
        NavigationStack {
            PhonePage(symbol: PhoneTab.sites.symbol, title: "Sites") {
                Text("28d clicks").font(.caption).foregroundStyle(.secondary)
            } content: {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        let rows = OverviewGlance.rows(overviews: model.overviews, series: history.series, period: .d28)
                        ForEach(rows) { row in
                            NavigationLink(value: SiteRoute(siteID: row.site.id)) {
                                SiteRow(row: row)
                            }
                            .buttonStyle(PressedSurface())
                        }
                        if model.sites.isEmpty {
                            if let error = model.errorMessage {
                                ErrorLine(message: error).padding(.top, 16)
                            } else {
                                ProgressView().padding(.top, 40)
                            }
                        }
                    }
                }
                .refreshable { await model.refresh() }
            }
            .navigationDestination(for: SiteRoute.self) { route in
                SitePage(siteID: route.siteID)
            }
        }
        .task(id: model.sites.map(\.id)) {
            let siteIDs = model.sites.map(\.id)
            await withTaskGroup(of: Void.self) { group in
                for siteID in siteIDs {
                    group.addTask { await history.load(siteID) }
                }
            }
        }
    }
}

/// The favicon, the name over the host, then the clicks and their growth in two fixed zones.
private struct SiteRow: View {
    let row: SiteGlance

    var body: some View {
        let growth = Growth(
            current: row.comparison.currentStats.clicks,
            previous: row.comparison.previousStats?.clicks
        )
        QuietRow(height: 60) {
            HStack(spacing: 12) {
                SiteIcon(site: row.site, size: 20)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.site.name).font(.body.weight(.medium)).lineLimit(1)
                    Text(row.site.host).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 8)
                Text(GlanceFigure.count(row.comparison.currentStats.clicks))
                    .font(.body)
                    .monospacedDigit()
                    .frame(width: 64, alignment: .trailing)
                Text(GrowthReading.label(growth))
                    .font(.callout.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(GrowthReading.tint(growth) ?? .secondary)
                    .lineLimit(1)
                    .frame(width: 60, alignment: .trailing)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

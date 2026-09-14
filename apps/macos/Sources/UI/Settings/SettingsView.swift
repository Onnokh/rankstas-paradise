import SwiftUI

/// The Settings window (⌘,): the pages down the left, the open page on the right.
///
/// Two surfaces, like the main window: the sidebar stands on the void, the page on a panel,
/// with the hairline between them. The page scrolls; the sidebar does not move.
struct SettingsView: View {
    @State private var model: SettingsModel
    @State private var page: SettingsPage
    @State private var favicons = FaviconStore()
    /// What the sidebar's search holds. Narrows the pages and the rows on the open page.
    @State private var query = ""

    init(model: SettingsModel = SettingsModel(), page: SettingsPage = .server) {
        _model = State(initialValue: model)
        _page = State(initialValue: page)
    }

    var body: some View {
        HStack(spacing: 0) {
            SettingsSidebar(model: model, favicons: favicons, page: $page, query: $query)

            Rectangle()
                .fill(Palette.line)
                .frame(width: 1)

            ScrollView {
                pageContent
                    .frame(maxWidth: SettingsLayout.columnWidth, alignment: .leading)
                    .padding(.horizontal, SettingsLayout.columnInset)
                    .padding(.top, SettingsSidebar.topInset)
                    .padding(.bottom, 40)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Palette.panel)
            .environment(\.settingsQuery, query)
        }
        .frame(minWidth: 900, minHeight: 560)
        // One text colour for the window, as in the main one. See `Palette.text`.
        .foregroundStyle(Palette.text)
        // The window has no title bar; the top strip is still the window's to drag.
        .ignoresSafeArea(.container, edges: .top)
        .background {
            SettingsWindowChrome()
                .frame(width: 0, height: 0)
        }
        .task {
            await model.load()
            await favicons.load(model.sites)
        }
        .alert("Something went wrong", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.clearError() } }
        )) {
            Button("OK") { model.clearError() }
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    @ViewBuilder
    private var pageContent: some View {
        switch page {
        case .server:
            ServerSettingsPage(model: model)
        case .keys:
            AppKeysPage(model: model)
        case .site(let id):
            if let entry = model.entries[id] {
                SiteSettingsPage(
                    model: model,
                    entry: entry,
                    resolved: model.sites.first { $0.id == id },
                    secrets: model.siteSecrets[id]
                )
                .id(id)
            } else {
                ProgressView()
            }
        }
    }
}

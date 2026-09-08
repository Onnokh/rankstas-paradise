import SwiftUI

/// What the Settings sidebar can select: a site, or the keys that apply to the whole app.
enum SettingsPage: Hashable {
    case site(Site.ID)
    case app
}

/// The Settings window (⌘,): sites on the left; the chosen site's settings and keys on the
/// right. Nothing else.
struct SettingsView: View {
    @State private var model = SettingsModel()
    @State private var page: SettingsPage?

    var body: some View {
        NavigationSplitView {
            List(selection: $page) {
                ForEach(model.sites) { site in
                    Text(site.name).tag(SettingsPage.site(site.id))
                }
                Section {
                    Text("App keys").tag(SettingsPage.app)
                }
            }
            .navigationSplitViewColumnWidth(min: 160, ideal: 180)
        } detail: {
            detail
                .frame(minWidth: 440, minHeight: 360)
        }
        .task {
            await model.load()
            if page == nil, let first = model.sites.first { page = .site(first.id) }
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
    private var detail: some View {
        switch page {
        case .site(let id):
            if let entry = model.entries[id] {
                SiteSettingsPage(model: model, entry: entry, secrets: model.siteSecrets[id])
                    .id(id)
            } else {
                ProgressView()
            }
        case .app:
            Form {
                if let secrets = model.appSecrets {
                    KeysSection(secrets: secrets, siteID: nil, model: model)
                }
            }
            .formStyle(.grouped)
        case .none:
            if let error = model.targetError ?? model.errorMessage {
                Text(error).foregroundStyle(.secondary).padding()
            } else {
                ProgressView()
            }
        }
    }
}

import SwiftUI

/// What the picker can select: a site, or the keys that apply to the whole app.
enum SettingsPage: Hashable {
    case site(Site.ID)
    case app
}

/// The Settings window (⌘,): a picker for the site at the top, its settings and keys below.
/// Fixed width, plain column form, nothing else.
struct SettingsView: View {
    @State private var model = SettingsModel()
    @State private var page: SettingsPage = .app

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Picker("Site", selection: $page) {
                ForEach(model.sites) { site in
                    Text(site.name).tag(SettingsPage.site(site.id))
                }
                Text("App").tag(SettingsPage.app)
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            switch page {
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
            case .app:
                Form {
                    if let secrets = model.appSecrets {
                        KeysSection(secrets: secrets, siteID: nil, model: model)
                    } else if let error = model.targetError ?? model.errorMessage {
                        Text(error).foregroundStyle(.secondary)
                    } else {
                        ProgressView()
                    }
                }
                .formStyle(.columns)
            }
        }
        .padding(20)
        .frame(width: 560)
        .task {
            await model.load()
            if let first = model.sites.first { page = .site(first.id) }
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
}

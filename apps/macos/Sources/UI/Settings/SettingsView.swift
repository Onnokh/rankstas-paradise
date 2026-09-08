import SwiftUI

/// What the Settings sidebar can select.
enum SettingsPage: Hashable {
    case server
    case site(Site.ID)
    case addSite
    case keys
    case clients
}

/// The Settings window (⌘,): a sidebar of pages and the page itself. Server first, because
/// nothing else loads until it is right; then one page per site; then what applies to the
/// whole app.
struct SettingsView: View {
    @State private var model = SettingsModel()
    @State private var page: SettingsPage? = .server

    var body: some View {
        NavigationSplitView {
            List(selection: $page) {
                Section {
                    Label("Server", systemImage: "network")
                        .tag(SettingsPage.server)
                }
                Section("Sites") {
                    ForEach(model.sites) { site in
                        Label(site.name, systemImage: "globe")
                            .tag(SettingsPage.site(site.id))
                    }
                    Label("Add Site…", systemImage: "plus")
                        .tag(SettingsPage.addSite)
                }
                Section("App") {
                    Label("Keys", systemImage: "key")
                        .tag(SettingsPage.keys)
                    Label("Clients", systemImage: "laptopcomputer.and.iphone")
                        .tag(SettingsPage.clients)
                }
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200)
        } detail: {
            detail
                .frame(minWidth: 460, minHeight: 420)
        }
        .task { await model.load() }
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
        case .server, .none:
            ServerPage(model: model)
        case .site(let id):
            if let entry = model.entries[id] {
                SiteSettingsPage(
                    model: model,
                    entry: entry,
                    secrets: model.siteSecrets[id],
                    onRemoved: { page = .server }
                )
                .id(id)
            } else {
                ProgressView("Loading…")
            }
        case .addSite:
            AddSitePage(model: model) { site in page = .site(site.id) }
        case .keys:
            KeysPage(model: model)
        case .clients:
            ClientsPage(model: model)
        }
    }
}

/// The server address and the token this Mac uses, and the switch to a token of its own.
struct ServerPage: View {
    let model: SettingsModel
    @State private var apiUrl = ""
    @State private var token = ""
    @State private var isSaving = false

    var body: some View {
        Form {
            Section {
                TextField("Server", text: $apiUrl, prompt: Text("https://rp.example.com"))
                    .textContentType(.URL)
                SecureField("Token", text: $token)
                HStack {
                    Spacer()
                    Button("Save") {
                        isSaving = true
                        Task {
                            await model.saveTarget(apiUrl: apiUrl, token: token)
                            token = ""
                            isSaving = false
                        }
                    }
                    .disabled(apiUrl.isEmpty || token.isEmpty || isSaving)
                }
            } header: {
                Text("Connection")
            } footer: {
                if let target = model.target {
                    Text("Connected to \(target.apiUrl). The token is kept in your login Keychain.")
                } else if let error = model.targetError {
                    Text(error).foregroundStyle(Palette.coral)
                }
            }

            if model.target != nil {
                Section {
                    Button("Use a token of this Mac's own") {
                        Task { await model.adoptOwnToken(label: Host.current().localizedName ?? "Mac") }
                    }
                } header: {
                    Text("This Mac")
                } footer: {
                    Text(
                        "Asks the server for a client token for this Mac and keeps it in the Keychain, "
                        + "so the shared token can be revoked without locking this Mac out."
                    )
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { apiUrl = model.target?.apiUrl ?? "" }
        .onChange(of: model.target?.apiUrl) { _, value in apiUrl = value ?? apiUrl }
    }
}

/// The form to add a site: only what the catalog requires. Everything else is edited on the
/// site's own page once it exists.
struct AddSitePage: View {
    let model: SettingsModel
    let onAdded: (Site) -> Void
    @State private var id = ""
    @State private var siteUrl = ""
    @State private var name = ""
    @State private var isAdding = false

    var body: some View {
        Form {
            Section {
                TextField("Id", text: $id, prompt: Text("my-site"))
                TextField("Search Console property", text: $siteUrl, prompt: Text("sc-domain:example.com"))
                TextField("Name", text: $name, prompt: Text("Optional"))
            } footer: {
                Text("The id is used in URLs and as a folder name: lower-case letters, digits, and hyphens.")
            }
            HStack {
                Spacer()
                Button("Add Site") {
                    isAdding = true
                    Task {
                        var settings = SiteSettings(siteUrl: siteUrl.trimmingCharacters(in: .whitespaces))
                        settings.name = OptionalText.fromForm(name)
                        if let site = await model.addSite(id: id.trimmingCharacters(in: .whitespaces), settings: settings) {
                            onAdded(site)
                        }
                        isAdding = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(id.isEmpty || siteUrl.isEmpty || isAdding)
            }
        }
        .formStyle(.grouped)
    }
}

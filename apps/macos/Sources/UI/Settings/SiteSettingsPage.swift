import SwiftUI

/// One site's settings: the general fields, the analytics and revenue providers with their
/// keys, and the way out. Edits live in the form until Save; Revert puts the stored values
/// back.
struct SiteSettingsPage: View {
    let model: SettingsModel
    let entry: SiteEntry
    let secrets: SecretsEnvelope?
    let onRemoved: () -> Void

    @State private var draft: Draft
    @State private var isSaving = false
    @State private var confirmRemove = false

    /// The form's copy of the settings, as text.
    struct Draft: Equatable {
        var name = ""
        var siteUrl = ""
        var origin = ""
        var sitemapUrl = ""
        var brandTerms = ""
        var hasAnalytics = false
        var analyticsProvider = "rybbit"
        var analyticsSiteId = ""
        var analyticsBaseUrl = ""
        var analyticsTimeZone = ""
        var hasRevenue = false
        var revenueProvider = "polar"
        var revenueAccountId = ""
        var revenueBaseUrl = ""
        var revenueTimeZone = ""

        init(_ settings: SiteSettings) {
            name = settings.name ?? ""
            siteUrl = settings.siteUrl
            origin = settings.origin ?? ""
            sitemapUrl = settings.sitemapUrl ?? ""
            brandTerms = BrandTerms.format(settings.brandTerms)
            if let analytics = settings.analytics {
                hasAnalytics = true
                analyticsProvider = analytics.provider
                analyticsSiteId = analytics.siteId
                analyticsBaseUrl = analytics.baseUrl ?? ""
                analyticsTimeZone = analytics.timeZone ?? ""
            }
            if let revenue = settings.revenue {
                hasRevenue = true
                revenueProvider = revenue.provider
                revenueAccountId = revenue.accountId ?? ""
                revenueBaseUrl = revenue.baseUrl ?? ""
                revenueTimeZone = revenue.timeZone ?? ""
            }
        }

        /// The settings the form describes. `keyVariable` is kept from the stored entry: it
        /// is a deployment detail, not something to edit here.
        func settings(keeping stored: SiteSettings) -> SiteSettings {
            var settings = SiteSettings(siteUrl: siteUrl.trimmingCharacters(in: .whitespaces))
            settings.name = OptionalText.fromForm(name)
            settings.origin = OptionalText.fromForm(origin)
            settings.sitemapUrl = OptionalText.fromForm(sitemapUrl)
            settings.brandTerms = BrandTerms.parse(brandTerms)
            if hasAnalytics {
                settings.analytics = AnalyticsSettings(
                    provider: analyticsProvider.trimmingCharacters(in: .whitespaces),
                    siteId: analyticsSiteId.trimmingCharacters(in: .whitespaces),
                    baseUrl: OptionalText.fromForm(analyticsBaseUrl),
                    timeZone: OptionalText.fromForm(analyticsTimeZone)
                )
            }
            if hasRevenue {
                settings.revenue = RevenueSettings(
                    provider: revenueProvider.trimmingCharacters(in: .whitespaces),
                    accountId: OptionalText.fromForm(revenueAccountId),
                    keyVariable: stored.revenue?.keyVariable,
                    baseUrl: OptionalText.fromForm(revenueBaseUrl),
                    timeZone: OptionalText.fromForm(revenueTimeZone)
                )
            }
            return settings
        }
    }

    init(model: SettingsModel, entry: SiteEntry, secrets: SecretsEnvelope?, onRemoved: @escaping () -> Void) {
        self.model = model
        self.entry = entry
        self.secrets = secrets
        self.onRemoved = onRemoved
        _draft = State(initialValue: Draft(entry.settings))
    }

    private var isDirty: Bool { draft != Draft(entry.settings) }

    private func slot(for purpose: String) -> SecretSlot? {
        secrets?.slots.first { $0.purpose == purpose }
    }

    var body: some View {
        Form {
            Section("General") {
                TextField("Name", text: $draft.name, prompt: Text(entry.id))
                TextField("Search Console property", text: $draft.siteUrl, prompt: Text("sc-domain:example.com"))
                TextField("Origin", text: $draft.origin, prompt: Text("Derived from the property"))
                TextField("Sitemap URL", text: $draft.sitemapUrl, prompt: Text("https://…/sitemap.xml"))
                TextField("Brand terms", text: $draft.brandTerms, prompt: Text("Comma-separated; defaults to the id"))
            }

            Section {
                Toggle("Reads visits from an analytics provider", isOn: $draft.hasAnalytics)
                if draft.hasAnalytics {
                    TextField("Provider", text: $draft.analyticsProvider, prompt: Text("rybbit"))
                    TextField("Site id at the provider", text: $draft.analyticsSiteId)
                    TextField("Base URL", text: $draft.analyticsBaseUrl, prompt: Text("The provider's cloud when blank"))
                    TextField("Time zone", text: $draft.analyticsTimeZone, prompt: Text("UTC"))
                    if !isDirty, let slot = slot(for: entry.analytics?.provider ?? "") {
                        KeySlotRow(slot: slot, encryption: secrets?.encryption, siteID: entry.id, model: model)
                    } else if draft.hasAnalytics, isDirty {
                        Text("Save the settings, then enter the provider's key here.")
                            .foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("Analytics")
            }

            Section {
                Toggle("Reads sales from a commerce provider", isOn: $draft.hasRevenue)
                if draft.hasRevenue {
                    TextField("Provider", text: $draft.revenueProvider, prompt: Text("polar"))
                    TextField("Account id", text: $draft.revenueAccountId, prompt: Text("When the token spans several"))
                    TextField("Base URL", text: $draft.revenueBaseUrl, prompt: Text("The provider's production API when blank"))
                    TextField("Time zone", text: $draft.revenueTimeZone, prompt: Text("The analytics zone, else UTC"))
                    if !isDirty, let slot = slot(for: entry.revenue?.provider ?? "") {
                        KeySlotRow(slot: slot, encryption: secrets?.encryption, siteID: entry.id, model: model)
                    } else if draft.hasRevenue, isDirty {
                        Text("Save the settings, then enter the provider's key here.")
                            .foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("Revenue")
            }

            Section {
                HStack {
                    Button("Remove Site…", role: .destructive) { confirmRemove = true }
                    Spacer()
                    Button("Revert") { draft = Draft(entry.settings) }
                        .disabled(!isDirty || isSaving)
                    Button("Save") {
                        isSaving = true
                        Task {
                            _ = await model.saveSite(id: entry.id, settings: draft.settings(keeping: entry.settings))
                            isSaving = false
                        }
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isDirty || isSaving || draft.siteUrl.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } footer: {
                Text("Removing a site takes it out of the catalog. Its data on the server's disk is left alone.")
            }
        }
        .formStyle(.grouped)
        .navigationTitle(entry.name ?? entry.id)
        .onChange(of: entry) { _, stored in draft = Draft(stored.settings) }
        .confirmationDialog(
            "Remove \(entry.name ?? entry.id) from the catalog?",
            isPresented: $confirmRemove,
            titleVisibility: .visible
        ) {
            Button("Remove Site", role: .destructive) {
                Task {
                    if await model.removeSite(id: entry.id) { onRemoved() }
                }
            }
        }
    }
}

/// One vendor key: where it comes from now, a field to store a new value, and a way to
/// remove the stored one. The value is write-only; the row only ever shows the last four.
struct KeySlotRow: View {
    let slot: SecretSlot
    let encryption: EncryptionStatus?
    let siteID: Site.ID?
    let model: SettingsModel

    @State private var value = ""
    @State private var isSaving = false

    private var canStore: Bool { encryption?.configured ?? false }

    private var status: String {
        if let stored = slot.stored {
            let tail = stored.last4.isEmpty ? "" : " ending in \(stored.last4)"
            return "Stored key\(tail), from \(stored.updatedAt.prefix(10))."
        }
        if slot.inEnvironment {
            return "From the server's environment (\(slot.variable))."
        }
        return "No key. The provider will not be read."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabeledContent("\(slot.purpose.capitalized) key") {
                Text(status)
                    .foregroundStyle(slot.stored != nil || slot.inEnvironment ? .secondary : Palette.amber)
                    .multilineTextAlignment(.trailing)
            }
            if canStore {
                HStack {
                    SecureField("New key", text: $value, prompt: Text(slot.stored == nil ? "Paste the key" : "Paste a new key to replace it"))
                    Button(slot.stored == nil ? "Store" : "Replace") {
                        isSaving = true
                        Task {
                            if await model.setSecret(siteID: siteID, purpose: slot.purpose, value: value) {
                                value = ""
                            }
                            isSaving = false
                        }
                    }
                    .disabled(value.trimmingCharacters(in: .whitespaces).isEmpty || isSaving)
                    if slot.stored != nil {
                        Button("Remove") {
                            Task { await model.removeSecret(siteID: siteID, purpose: slot.purpose) }
                        }
                        .disabled(isSaving)
                    }
                }
            } else {
                Text(encryption?.reason ?? "The server cannot store keys: set RP_MASTER_KEY.")
                    .font(.callout)
                    .foregroundStyle(Palette.amber)
            }
        }
    }
}

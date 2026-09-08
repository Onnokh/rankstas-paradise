import SwiftUI

/// One site: its settings as plain fields, and one field per key.
struct SiteSettingsPage: View {
    let model: SettingsModel
    let entry: SiteEntry
    let secrets: SecretsEnvelope?

    @State private var draft: Draft
    @State private var isSaving = false

    /// The form's copy of the settings, as text. Provider blocks are edited in place when the
    /// site has them; adding or removing a provider is not done here.
    struct Draft: Equatable {
        var name = ""
        var siteUrl = ""
        var origin = ""
        var sitemapUrl = ""
        var brandTerms = ""
        var analyticsSiteId = ""
        var analyticsBaseUrl = ""
        var analyticsTimeZone = ""
        var revenueAccountId = ""
        var revenueBaseUrl = ""
        var revenueTimeZone = ""

        init(_ settings: SiteSettings) {
            name = settings.name ?? ""
            siteUrl = settings.siteUrl
            origin = settings.origin ?? ""
            sitemapUrl = settings.sitemapUrl ?? ""
            brandTerms = BrandTerms.format(settings.brandTerms)
            analyticsSiteId = settings.analytics?.siteId ?? ""
            analyticsBaseUrl = settings.analytics?.baseUrl ?? ""
            analyticsTimeZone = settings.analytics?.timeZone ?? ""
            revenueAccountId = settings.revenue?.accountId ?? ""
            revenueBaseUrl = settings.revenue?.baseUrl ?? ""
            revenueTimeZone = settings.revenue?.timeZone ?? ""
        }

        func settings(over stored: SiteSettings) -> SiteSettings {
            var settings = stored
            settings.name = OptionalText.fromForm(name)
            settings.siteUrl = siteUrl.trimmingCharacters(in: .whitespaces)
            settings.origin = OptionalText.fromForm(origin)
            settings.sitemapUrl = OptionalText.fromForm(sitemapUrl)
            settings.brandTerms = BrandTerms.parse(brandTerms)
            if var analytics = stored.analytics {
                analytics.siteId = analyticsSiteId.trimmingCharacters(in: .whitespaces)
                analytics.baseUrl = OptionalText.fromForm(analyticsBaseUrl)
                analytics.timeZone = OptionalText.fromForm(analyticsTimeZone)
                settings.analytics = analytics
            }
            if var revenue = stored.revenue {
                revenue.accountId = OptionalText.fromForm(revenueAccountId)
                revenue.baseUrl = OptionalText.fromForm(revenueBaseUrl)
                revenue.timeZone = OptionalText.fromForm(revenueTimeZone)
                settings.revenue = revenue
            }
            return settings
        }
    }

    init(model: SettingsModel, entry: SiteEntry, secrets: SecretsEnvelope?) {
        self.model = model
        self.entry = entry
        self.secrets = secrets
        _draft = State(initialValue: Draft(entry.settings))
    }

    private var isDirty: Bool { draft != Draft(entry.settings) }

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $draft.name, prompt: Text(entry.id))
                TextField("Property", text: $draft.siteUrl)
                TextField("Origin", text: $draft.origin, prompt: Text("derived"))
                TextField("Sitemap", text: $draft.sitemapUrl, prompt: Text("derived"))
                TextField("Brand terms", text: $draft.brandTerms, prompt: Text(entry.id))
            }

            if let analytics = entry.analytics {
                Section("Analytics · \(analytics.provider)") {
                    TextField("Site id", text: $draft.analyticsSiteId)
                    TextField("Base URL", text: $draft.analyticsBaseUrl, prompt: Text("provider cloud"))
                    TextField("Time zone", text: $draft.analyticsTimeZone, prompt: Text("UTC"))
                }
            }

            if let revenue = entry.revenue {
                Section("Revenue · \(revenue.provider)") {
                    TextField("Account id", text: $draft.revenueAccountId, prompt: Text("none"))
                    TextField("Base URL", text: $draft.revenueBaseUrl, prompt: Text("production"))
                    TextField("Time zone", text: $draft.revenueTimeZone, prompt: Text("analytics zone"))
                }
            }

            if let secrets {
                KeysSection(secrets: secrets, siteID: entry.id, model: model)
            }
        }
        .formStyle(.grouped)
        .navigationTitle(entry.name ?? entry.id)
        .toolbar {
            Button("Save") {
                isSaving = true
                Task {
                    _ = await model.saveSite(id: entry.id, settings: draft.settings(over: entry.settings))
                    isSaving = false
                }
            }
            .disabled(!isDirty || isSaving || draft.siteUrl.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .onChange(of: entry) { _, stored in draft = Draft(stored.settings) }
    }
}

/// One row per key: its state on the right, a field to store a new value.
struct KeysSection: View {
    let secrets: SecretsEnvelope
    let siteID: Site.ID?
    let model: SettingsModel

    var body: some View {
        Section {
            ForEach(secrets.slots) { slot in
                KeyRow(slot: slot, siteID: siteID, model: model)
            }
        } header: {
            Text("Keys")
        } footer: {
            if !secrets.encryption.configured {
                Text(secrets.encryption.reason ?? "Set RP_MASTER_KEY on the server.")
                    .foregroundStyle(Palette.amber)
            }
        }
    }
}

struct KeyRow: View {
    let slot: SecretSlot
    let siteID: Site.ID?
    let model: SettingsModel

    @State private var value = ""

    private var state: String {
        if let stored = slot.stored { return stored.last4.isEmpty ? "stored" : "stored ····\(stored.last4)" }
        if slot.inEnvironment { return "server env" }
        return "not set"
    }

    var body: some View {
        LabeledContent(slot.purpose.capitalized) {
            HStack(spacing: 8) {
                Text(state)
                    .font(.callout)
                    .foregroundStyle(slot.stored == nil && !slot.inEnvironment ? Palette.amber : .secondary)
                SecureField("", text: $value, prompt: Text("key"))
                    .frame(width: 180)
                Button("Store") {
                    Task {
                        if await model.setSecret(siteID: siteID, purpose: slot.purpose, value: value) { value = "" }
                    }
                }
                .disabled(value.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }
}

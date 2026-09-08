import SwiftUI

/// One site: its settings as plain fields, and one field per key. An empty optional field
/// shows the value the server uses in its place, as read from the resolved site.
struct SiteSettingsPage: View {
    let model: SettingsModel
    let entry: SiteEntry
    let resolved: Site?
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

    init(model: SettingsModel, entry: SiteEntry, resolved: Site?, secrets: SecretsEnvelope?) {
        self.model = model
        self.entry = entry
        self.resolved = resolved
        self.secrets = secrets
        _draft = State(initialValue: Draft(entry.settings))
    }

    private var isDirty: Bool { draft != Draft(entry.settings) }

    private var sitemapDefault: String {
        guard let origin = resolved?.origin, let host = URL(string: origin)?.host() else { return "derived" }
        return "https://\(host)/sitemap.xml"
    }

    var body: some View {
        Form {
            TextField("Name", text: $draft.name, prompt: Text(entry.id))
            TextField("Property", text: $draft.siteUrl)
            TextField("Origin", text: $draft.origin, prompt: Text(resolved?.origin ?? "derived"))
            TextField("Sitemap", text: $draft.sitemapUrl, prompt: Text(sitemapDefault))
            TextField("Brand terms", text: $draft.brandTerms, prompt: Text(entry.id))

            if let analytics = entry.analytics {
                Section("Analytics (\(analytics.provider))") {
                    TextField("Site id", text: $draft.analyticsSiteId)
                    TextField("Base URL", text: $draft.analyticsBaseUrl, prompt: Text("\(analytics.provider) cloud"))
                    TextField("Time zone", text: $draft.analyticsTimeZone, prompt: Text(resolved?.analytics?.timeZone ?? "UTC"))
                }
            }

            if let revenue = entry.revenue {
                Section("Revenue (\(revenue.provider))") {
                    TextField("Account id", text: $draft.revenueAccountId, prompt: Text("the token's own"))
                    TextField("Base URL", text: $draft.revenueBaseUrl, prompt: Text("\(revenue.provider) production"))
                    TextField("Time zone", text: $draft.revenueTimeZone, prompt: Text(resolved?.revenue?.timeZone ?? "UTC"))
                }
            }

            if let secrets {
                KeysSection(secrets: secrets, siteID: entry.id, model: model)
            }

            HStack {
                Spacer()
                Button("Save") {
                    isSaving = true
                    Task {
                        _ = await model.saveSite(id: entry.id, settings: draft.settings(over: entry.settings))
                        isSaving = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!isDirty || isSaving || draft.siteUrl.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .formStyle(.columns)
        .onChange(of: entry) { _, stored in draft = Draft(stored.settings) }
    }
}

/// One row per key: a field whose placeholder says where the key comes from now, and Store.
struct KeysSection: View {
    let secrets: SecretsEnvelope
    let siteID: Site.ID?
    let model: SettingsModel

    var body: some View {
        Section("Keys") {
            ForEach(secrets.slots) { slot in
                KeyRow(slot: slot, siteID: siteID, model: model)
            }
            if !secrets.encryption.configured {
                Text(secrets.encryption.reason ?? "Set RP_MASTER_KEY on the server.")
                    .font(.callout)
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
        HStack {
            SecureField(slot.purpose.capitalized, text: $value, prompt: Text(state))
            Button("Store") {
                Task {
                    if await model.setSecret(siteID: siteID, purpose: slot.purpose, value: value) { value = "" }
                }
            }
            .disabled(value.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }
}

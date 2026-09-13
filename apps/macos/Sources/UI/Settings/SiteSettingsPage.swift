import SwiftUI

/// One site: its settings as rows, one control each, and one row per key. An empty optional
/// field shows the value the server uses in its place, as read from the resolved site.
///
/// Edits collect in a draft and go to the server on Save, which stands in the header: the
/// settings travel as one document, so half a change is never what the server has.
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

    private var canSave: Bool {
        isDirty && !isSaving && !draft.siteUrl.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private var sitemapDefault: String {
        guard let origin = resolved?.origin, let host = URL(string: origin)?.host() else { return "Derived from the origin" }
        return "https://\(host)/sitemap.xml"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsPageHeader(resolved?.name ?? entry.name ?? entry.id, subtitle: resolved?.origin ?? entry.siteUrl) {
                Button("Save", action: save)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSave)
            }

            SettingsSection("Site") {
                SettingsRow("Name", detail: "How the site is called across the app.") {
                    SettingsField(label: "Name", text: $draft.name, prompt: entry.id)
                }
                SettingsRow("Property", detail: "The Search Console property the site's results come from.") {
                    SettingsField(label: "Property", text: $draft.siteUrl, prompt: "sc-domain:example.com")
                }
                SettingsRow("Origin", detail: "Where the site's pages live. Blank derives it from the property.") {
                    SettingsField(label: "Origin", text: $draft.origin, prompt: resolved?.origin ?? "Derived from the property")
                }
                SettingsRow("Sitemap", detail: "The sitemap the registry is read from.") {
                    SettingsField(label: "Sitemap", text: $draft.sitemapUrl, prompt: sitemapDefault)
                }
                SettingsRow("Brand terms", detail: "Comma-separated. A query with one of these counts as brand.") {
                    SettingsField(label: "Brand terms", text: $draft.brandTerms, prompt: entry.id)
                }
            }

            if let analytics = entry.analytics {
                SettingsSection("Analytics · \(analytics.provider)") {
                    SettingsRow("Site id", detail: "The site as \(analytics.provider) knows it.") {
                        SettingsField(label: "Analytics site id", text: $draft.analyticsSiteId)
                    }
                    SettingsRow("Base URL", detail: "Blank uses the \(analytics.provider) cloud.") {
                        SettingsField(label: "Analytics base URL", text: $draft.analyticsBaseUrl, prompt: "\(analytics.provider) cloud")
                    }
                    SettingsRow("Time zone", detail: "The zone the provider's days are cut in.") {
                        SettingsField(label: "Analytics time zone", text: $draft.analyticsTimeZone, prompt: resolved?.analytics?.timeZone ?? "UTC")
                    }
                }
            }

            if let revenue = entry.revenue {
                SettingsSection("Revenue · \(revenue.provider)") {
                    SettingsRow("Account id", detail: "Blank uses the account the token belongs to.") {
                        SettingsField(label: "Revenue account id", text: $draft.revenueAccountId, prompt: "The token's own")
                    }
                    SettingsRow("Base URL", detail: "Blank uses \(revenue.provider) production.") {
                        SettingsField(label: "Revenue base URL", text: $draft.revenueBaseUrl, prompt: "\(revenue.provider) production")
                    }
                    SettingsRow("Time zone", detail: "The zone the provider's days are cut in.") {
                        SettingsField(label: "Revenue time zone", text: $draft.revenueTimeZone, prompt: resolved?.revenue?.timeZone ?? "UTC")
                    }
                }
            }

            if let secrets {
                KeysSection(title: "Keys", secrets: secrets, siteID: entry.id, model: model)
            }
        }
        .onSubmit(save)
        .onChange(of: entry) { _, stored in draft = Draft(stored.settings) }
    }

    private func save() {
        guard canSave else { return }
        isSaving = true
        Task {
            _ = await model.saveSite(id: entry.id, settings: draft.settings(over: entry.settings))
            isSaving = false
        }
    }
}

import SwiftUI

/// Where this Mac's app talks to. Read from the environment or `client.json`, so the page
/// reports it and does not edit it.
struct ServerSettingsPage: View {
    let model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsPageHeader("Account", subtitle: "The Ranksta's Paradise server this Mac is signed in to")

            SettingsSection("Server") {
                SettingsRow("Address", detail: "Every request from this app goes here.") {
                    SettingsValue(text: model.target?.apiUrl ?? "Not configured", isMonospaced: model.target != nil)
                }
                SettingsRow("Token", detail: "The bearer token sent with each request. Never shown.") {
                    SettingsValue(text: model.target == nil ? "Not configured" : "Set")
                }
                SettingsRow("Read from", detail: "The environment wins over the file when both are set.") {
                    SettingsValue(text: ClientConfiguration.sourceDescription(), isMonospaced: true)
                }
            }

            if let error = model.targetError {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(Palette.coral)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 20)
            }
        }
    }
}

/// The vendor keys that serve every site: one account each, so no Site setting names them.
struct AppKeysPage: View {
    let model: SettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsPageHeader("Keys", subtitle: "Vendor keys that serve every site")

            if let secrets = model.appSecrets {
                KeysSection(title: "Account keys", secrets: secrets, siteID: nil, model: model)
            } else if let error = model.targetError ?? model.errorMessage {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.top, 28)
            } else {
                ProgressView()
                    .padding(.top, 28)
            }
        }
    }
}

/// One row per key slot. Where the key comes from now is the row's detail; a new value is
/// typed on the right and stored with one click.
struct KeysSection: View {
    let title: String
    let secrets: SecretsEnvelope
    let siteID: Site.ID?
    let model: SettingsModel

    var body: some View {
        SettingsSection(title) {
            ForEach(secrets.slots) { slot in
                KeyRow(slot: slot, siteID: siteID, model: model)
            }
            if !secrets.encryption.configured {
                Text(secrets.encryption.reason ?? "Set RP_MASTER_KEY on the server.")
                    .font(.callout)
                    .foregroundStyle(Palette.amber)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 8)
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
        if let stored = slot.stored {
            return stored.last4.isEmpty ? "Stored on the server." : "Stored on the server, ends in \(stored.last4)."
        }
        if slot.inEnvironment { return "From the server's environment, \(slot.variable)." }
        return "Not set."
    }

    private var canStore: Bool {
        !value.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        SettingsRow(slot.purpose.capitalized, detail: state) {
            HStack(spacing: 8) {
                SettingsField(label: "\(slot.purpose.capitalized) key", text: $value, prompt: "New key", isSecure: true)
                    .onSubmit(store)
                    // Enter here stores the key; it is not the site's Save.
                    .submitScope()
                Button("Store", action: store)
                    .disabled(!canStore)
            }
        }
    }

    private func store() {
        guard canStore else { return }
        Task {
            if await model.setSecret(siteID: siteID, purpose: slot.purpose, value: value) { value = "" }
        }
    }
}

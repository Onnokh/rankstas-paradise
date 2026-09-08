import SwiftUI

/// The keys that apply to every site: Ahrefs today. The same row as a site's keys, without a
/// site.
struct KeysPage: View {
    let model: SettingsModel

    var body: some View {
        Form {
            if let secrets = model.appSecrets {
                Section {
                    ForEach(secrets.slots) { slot in
                        KeySlotRow(slot: slot, encryption: secrets.encryption, siteID: nil, model: model)
                    }
                } header: {
                    Text("App-wide keys")
                } footer: {
                    if secrets.encryption.configured {
                        Text("Keys are stored encrypted on the server. A stored key replaces the environment variable of the same name.")
                    } else {
                        Text(secrets.encryption.reason ?? "The server cannot store keys: set RP_MASTER_KEY.")
                            .foregroundStyle(Palette.amber)
                    }
                }
            } else if model.isLoading {
                ProgressView()
            } else {
                Text("Connect to a server first.")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

/// Every client with a token of its own, and the way to issue one more or end one.
struct ClientsPage: View {
    let model: SettingsModel
    @State private var newLabel = ""
    @State private var issued: ClientCreatedEnvelope?
    @State private var isCreating = false

    private func when(_ iso: String?) -> String {
        guard let iso, let date = Instant.parse(iso) else { return "never" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    var body: some View {
        Form {
            Section {
                if model.clients.isEmpty {
                    Text("No clients yet. Every program still uses the shared token.")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.clients) { client in
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(client.label)
                                .strikethrough(client.revokedAt != nil)
                            Text(client.revokedAt != nil
                                 ? "Revoked \(when(client.revokedAt))"
                                 : "Last used \(when(client.lastUsedAt)) · created \(when(client.createdAt))")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if client.revokedAt == nil {
                            Button("Revoke") {
                                Task { await model.revokeClient(id: client.id) }
                            }
                        }
                    }
                }
            } header: {
                Text("Clients")
            } footer: {
                Text("A client's token is shown once, when it is created. Revoking a client ends its token at the next request; the shared token stays valid.")
            }

            Section("New client") {
                HStack {
                    TextField("Label", text: $newLabel, prompt: Text("Onno's iPad"))
                    Button("Create Token") {
                        isCreating = true
                        Task {
                            issued = await model.createClient(label: newLabel)
                            if issued != nil { newLabel = "" }
                            isCreating = false
                        }
                    }
                    .disabled(newLabel.trimmingCharacters(in: .whitespaces).isEmpty || isCreating)
                }
            }
        }
        .formStyle(.grouped)
        .sheet(item: $issued) { created in
            IssuedTokenSheet(created: created) { issued = nil }
        }
    }
}

extension ClientCreatedEnvelope: Identifiable {
    var id: String { client.id }
}

/// The one time a token is visible. Copy it into the client now; it is not stored anywhere
/// the app can show it again.
struct IssuedTokenSheet: View {
    let created: ClientCreatedEnvelope
    let onDone: () -> Void
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Token for \(created.client.label)")
                .font(.title2)
            Text("Copy it now. The server keeps only a hash, so this is the only time it can be shown.")
                .foregroundStyle(.secondary)
            HStack {
                Text(created.token)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .cardSurface(cornerRadius: 6)
                Button(copied ? "Copied" : "Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(created.token, forType: .string)
                    copied = true
                }
            }
            HStack {
                Spacer()
                Button("Done", action: onDone)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 520)
    }
}

/// The server's ISO 8601 instants, with or without fractional seconds.
enum Instant {
    static func parse(_ text: String) -> Date? {
        (try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
            ?? (try? Date(text, strategy: .iso8601))
    }
}

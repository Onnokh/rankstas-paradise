import SwiftUI

/// The Account tab: the server this phone reads, and the way out. The Mac's Settings window
/// edits sites and vendor keys; the phone only reads, so it has nothing else to set.
struct AccountScreen: View {
    let account: Account
    @Environment(OverviewModel.self) private var model
    @Environment(\.isRoomy) private var isRoomy

    @State private var isConfirmingSignOut = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    LabeledContent("Address", value: account.target?.apiUrl ?? "—")
                    LabeledContent("Key", value: masked(account.target?.token))
                    LabeledContent("Sites", value: model.sites.isEmpty ? "—" : "\(model.sites.count)")
                }

                Section {
                    Button("Sign out", role: .destructive) { isConfirmingSignOut = true }
                } footer: {
                    Text("Site settings and vendor keys are edited in the Mac app.")
                }
            }
            // The Form keeps its own inset; with room, it also keeps the other pages' column.
            .contentMargins(.horizontal, isRoomy ? Phone.roomyInset : nil, for: .scrollContent)
            .navigationTitle("Account")
            .confirmationDialog("Sign out of this server?", isPresented: $isConfirmingSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { account.signOut() }
            } message: {
                Text("The key and the stored figures are removed from this phone.")
            }
        }
    }

    /// The key's first and last characters only: enough to tell two keys apart, never enough
    /// to use one.
    private func masked(_ token: String?) -> String {
        guard let token, token.count > 10 else { return token == nil ? "—" : "Set" }
        return "\(token.prefix(5))…\(token.suffix(4))"
    }
}

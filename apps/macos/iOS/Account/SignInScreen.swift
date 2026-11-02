import SwiftUI

/// The first screen on a phone that is not signed in: the server's address and a key.
struct SignInScreen: View {
    let account: Account

    @State private var address = ""
    @State private var key = ""
    @State private var isSigningIn = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("rp.example.com", text: $address)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("API key", text: $key)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Server")
                } footer: {
                    Text("Make a key for this phone with POST /api/clients. The key stays in this phone's Keychain.")
                }

                Section {
                    Button(action: signIn) {
                        HStack {
                            Text("Sign in")
                            Spacer()
                            if isSigningIn { ProgressView() }
                        }
                    }
                    .disabled(isSigningIn || address.isEmpty || key.isEmpty)
                } footer: {
                    if let error {
                        Text(error).foregroundStyle(Palette.coral)
                    }
                }
            }
            .navigationTitle("Ranksta's Paradise")
        }
    }

    private func signIn() {
        isSigningIn = true
        error = nil
        Task {
            defer { isSigningIn = false }
            do {
                try await account.signIn(address: address, key: key)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

import SwiftUI

@main
struct PhoneApp: App {
    @State private var account = Account()

    var body: some Scene {
        WindowGroup {
            if account.target == nil {
                SignInScreen(account: account)
            } else {
                PhoneShell(account: account)
                    .id(account.session)
            }
        }
    }
}

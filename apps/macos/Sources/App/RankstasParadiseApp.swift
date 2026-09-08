import SwiftUI

@main
struct RankstasParadiseApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
        // The tab bar takes the title bar's place, like a browser or terminal.
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1100, height: 680)
        .commands {
            ViewCommands()
        }

        // ⌘, — the server, each site's settings and keys, and the clients.
        Settings {
            SettingsView()
        }
    }
}

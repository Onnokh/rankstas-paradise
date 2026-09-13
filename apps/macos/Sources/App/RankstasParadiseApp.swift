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

        // ⌘, — the server and its keys, then each site's settings and keys, one page each.
        Settings {
            SettingsView()
        }
        .defaultSize(width: 1040, height: 680)
        .windowResizability(.contentMinSize)
    }
}

import AppKit
import SwiftUI

/// Takes the title bar off the Settings window.
///
/// `Settings` is the one scene that does not honour `.windowStyle(.hiddenTitleBar)`, so the
/// window is asked directly: a transparent title bar with no title, and content that runs
/// up under it. The traffic lights stay where they are, and the strip they sit on is still
/// the window's to drag.
struct SettingsWindowChrome: NSViewRepresentable {
    func makeNSView(context: Context) -> ChromeView {
        ChromeView(frame: .zero)
    }

    func updateNSView(_ nsView: ChromeView, context: Context) {}

    final class ChromeView: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard let window else { return }
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.titlebarSeparatorStyle = .none
            window.styleMask.insert(.fullSizeContentView)
            window.isMovableByWindowBackground = true
        }
    }
}

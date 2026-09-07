import AppKit
import SwiftUI

/// Gives the window a tall title bar and reports where it draws its traffic lights, so the
/// tab row can share their line.
///
/// An empty unified toolbar is what makes macOS centre the traffic lights in a taller bar,
/// like a browser or terminal. The title bar is transparent (`.hiddenTitleBar`) and the
/// content extends under it, so the toolbar itself is never seen.
struct WindowChromeReader: NSViewRepresentable {
    let onChange: @MainActor (WindowChrome) -> Void

    func makeNSView(context: Context) -> ReaderView {
        let view = ReaderView(frame: .zero)
        view.onChange = onChange
        return view
    }

    func updateNSView(_ nsView: ReaderView, context: Context) {
        nsView.onChange = onChange
    }

    final class ReaderView: NSView {
        var onChange: (@MainActor (WindowChrome) -> Void)?
        private var reported: WindowChrome?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            installTallTitleBar()
            report()
        }

        private func installTallTitleBar() {
            guard let window, window.toolbar == nil else { return }
            let toolbar = NSToolbar(identifier: "rankstas.chrome")
            toolbar.showsBaselineSeparator = false
            window.toolbar = toolbar
            window.toolbarStyle = .unified
            window.titlebarSeparatorStyle = .none
            // The buttons move once the toolbar is laid out; measure again then.
            Task { @MainActor [weak self] in
                self?.report()
            }
        }

        override func layout() {
            super.layout()
            report()
        }

        private func report() {
            guard
                let window,
                let close = window.standardWindowButton(.closeButton),
                let zoom = window.standardWindowButton(.zoomButton),
                let closeSuperview = close.superview
            else { return }

            // Button frames are in the title bar's coordinates; convert to window points,
            // then flip so y runs from the top like SwiftUI's.
            let closeRect = closeSuperview.convert(close.frame, to: nil)
            let zoomRect = closeSuperview.convert(zoom.frame, to: nil)
            let windowHeight = window.frame.height
            let chrome = WindowChrome(
                tabsLeadingX: zoomRect.maxX + 14,
                buttonsCenterY: windowHeight - closeRect.midY
            )
            guard chrome != reported else { return }
            reported = chrome
            onChange?(chrome)
        }
    }
}

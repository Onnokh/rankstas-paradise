import AppKit
import SwiftUI

/// Reports whether the Command key is held, so the tabs can show their shortcuts.
struct CommandKeyMonitor: NSViewRepresentable {
    let onChange: @MainActor (Bool) -> Void

    func makeNSView(context: Context) -> MonitorView {
        let view = MonitorView(frame: .zero)
        view.onChange = onChange
        return view
    }

    func updateNSView(_ nsView: MonitorView, context: Context) {
        nsView.onChange = onChange
    }

    static func dismantleNSView(_ nsView: MonitorView, coordinator: ()) {
        nsView.stop()
    }

    final class MonitorView: NSView {
        var onChange: (@MainActor (Bool) -> Void)?

        private var monitor: Any?
        private var resignObserver: NSObjectProtocol?
        private var isHeld = false

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard window != nil else {
                stop()
                return
            }
            start()
        }

        private func start() {
            guard monitor == nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
                self?.update(event.modifierFlags.contains(.command))
                return event
            }
            // Releasing the key while another app is active never reaches us; reset instead.
            resignObserver = NotificationCenter.default.addObserver(
                forName: NSApplication.didResignActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.update(false)
                }
            }
        }

        func stop() {
            if let monitor {
                NSEvent.removeMonitor(monitor)
            }
            monitor = nil
            if let resignObserver {
                NotificationCenter.default.removeObserver(resignObserver)
            }
            resignObserver = nil
        }

        private func update(_ held: Bool) {
            guard held != isHeld else { return }
            isHeld = held
            onChange?(held)
        }
    }
}

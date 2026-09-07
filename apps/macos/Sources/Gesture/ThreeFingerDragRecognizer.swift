import AppKit
import SwiftUI

/// Streams a three-finger vertical drag on the trackpad.
///
/// AppKit attaches trackpad touches to gesture events only, and generates those only while a
/// view in the window accepts indirect touches. The tracking view opts the window's content
/// view in, then reads the touches from every gesture event the app dispatches.
struct ThreeFingerDragRecognizer: NSViewRepresentable {
    struct Handlers {
        var began: @MainActor () -> Void
        /// Normalised travel since the drag began. Positive is downwards; 1 is the full pad height.
        var changed: @MainActor (_ travel: Double) -> Void
        /// Normalised travel per second at the moment the fingers lifted.
        var ended: @MainActor (_ velocity: Double) -> Void
    }

    let handlers: Handlers

    func makeNSView(context: Context) -> TrackingView {
        let view = TrackingView(frame: .zero)
        view.handlers = handlers
        return view
    }

    func updateNSView(_ nsView: TrackingView, context: Context) {
        nsView.handlers = handlers
    }

    static func dismantleNSView(_ nsView: TrackingView, coordinator: ()) {
        nsView.stop()
    }

    final class TrackingView: NSView {
        var handlers: Handlers?

        private var monitor: Any?
        private var origin: CGPoint?
        private var lastY: CGFloat = 0
        private var lastTime: TimeInterval = 0
        private var velocity: Double = 0
        private var watchdog: Task<Void, Never>?

        /// The lift of the last finger does not always arrive as a gesture event. If no sample
        /// comes in for this long while a drag is live, the drag is treated as ended.
        private let sampleTimeout: Duration = .milliseconds(120)

        override init(frame frameRect: NSRect) {
            super.init(frame: frameRect)
            allowedTouchTypes = [.indirect]
            wantsRestingTouches = false
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) is not supported")
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard let window else {
                stop()
                return
            }
            window.contentView?.allowedTouchTypes.insert(.indirect)
            start()
        }

        private func start() {
            guard monitor == nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(
                matching: [.gesture, .beginGesture, .endGesture]
            ) { [weak self] event in
                self?.track(event)
                return event
            }
        }

        func stop() {
            if let monitor {
                NSEvent.removeMonitor(monitor)
            }
            monitor = nil
            watchdog?.cancel()
            watchdog = nil
        }

        private func track(_ event: NSEvent) {
            if event.type == .endGesture {
                finish()
                return
            }

            let touches = event.touches(matching: .touching, in: nil)
            guard touches.count == 3 else {
                finish()
                return
            }
            restartWatchdog()

            let centroid = touches.reduce(CGPoint.zero) { partial, touch in
                CGPoint(
                    x: partial.x + touch.normalizedPosition.x / 3,
                    y: partial.y + touch.normalizedPosition.y / 3
                )
            }
            let now = event.timestamp

            guard let origin else {
                self.origin = centroid
                lastY = centroid.y
                lastTime = now
                velocity = 0
                handlers?.began()
                return
            }

            // Normalised y grows towards the top edge, so downward travel lowers it.
            let elapsed = now - lastTime
            if elapsed > 0 {
                let instant = Double(lastY - centroid.y) / elapsed
                velocity = velocity * 0.5 + instant * 0.5
            }
            lastY = centroid.y
            lastTime = now
            handlers?.changed(Double(origin.y - centroid.y))
        }

        private func finish() {
            watchdog?.cancel()
            watchdog = nil
            guard origin != nil else { return }
            origin = nil
            handlers?.ended(velocity)
        }

        private func restartWatchdog() {
            watchdog?.cancel()
            watchdog = Task { [weak self, sampleTimeout] in
                try? await Task.sleep(for: sampleTimeout)
                guard !Task.isCancelled else { return }
                self?.finish()
            }
        }
    }
}

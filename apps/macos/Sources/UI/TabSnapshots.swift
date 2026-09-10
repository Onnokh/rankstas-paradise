import AppKit
import Observation
import SwiftUI

/// One rendered still per tab, which is what the peek's cards show.
///
/// A card changes size on every frame of the peek, so a live screen inside it is laid out
/// again on every frame: five of them held 13-16 ms of main thread per frame and the display
/// fell to 55 Hz, against 8 ms and no dropped frames with stills. A still is a texture, and
/// a card resizing one is a GPU transform.
///
/// The travelling pane was tried this way too and put back: parking the live pane behind a
/// still did make frames cheaper, but it moved the cost onto the click that closes the peek
/// — 48 ms against 26 — and the click is what the reader feels.
///
/// Stills are drawn a beat after the reader leaves a tab, and never while the peek is on
/// screen: one render costs 16 ms and more, which during the peek is a dropped frame.
///
/// Two things about `ImageRenderer` decide how the content must be built, both learned from
/// looking at stills that were wrong:
///
/// - It renders in light appearance, and `Palette` resolves its surfaces through
///   `NSAppearance` rather than SwiftUI's `colorScheme`, so a still is drawn inside the
///   app's own appearance. Without that every card came out white.
/// - It renders no `ScrollView` content, so a screen offers a non-scrolling column for
///   this — see `ReadingColumn`. Without it a still was the header and then blank.
@MainActor
@Observable
final class TabSnapshots {
    /// A tab's card still, always of its dashboard: a card is for picking a site.
    private(set) var cards: [TabID: NSImage] = [:]

    @ObservationIgnored private var pendingCards: [TabID: Task<Void, Never>] = [:]

    /// Asked before every render, and again each beat until it answers yes. Nothing is drawn
    /// while the peek is open: with renders landing mid-peek, the freeze on clicking a card
    /// went from 81 ms to 105 at the 90th percentile.
    @ObservationIgnored var canRender: @MainActor () -> Bool = { true }

    /// How long after leaving a tab its stills are drawn. Past the peek's own settle
    /// animation (0.4 s), so a render never lands in a frame that is moving.
    static let delay: Duration = .milliseconds(1800)

    /// The size a card still is drawn at. A card's preview area has this aspect
    /// (`PeekLayout.previewAspect`), so the still fills it without being squashed.
    static let cardSize = CGSize(width: 980, height: 560)

    func card(for tab: TabID) -> NSImage? {
        cards[tab]
    }

    /// Draws a tab's card still after a beat, replacing one already waiting for that tab.
    func scheduleCard(_ tab: TabID, after extra: Duration = .zero, content: @escaping @MainActor () -> AnyView) {
        pendingCards[tab]?.cancel()
        pendingCards[tab] = task(after: extra) { [weak self] in
            guard let self, let image = self.draw(content()) else { return }
            self.cards[tab] = image
        }
    }

    /// Gives every tab a still, one render per beat, so a peek early in the session is not a
    /// row of empty cards. A tab nobody has opened is drawn too: a still comes from the tab's state and the
    /// shared stores, and needs no view on screen.
    func scheduleAll(_ tabs: [TabID], content: @escaping @MainActor (TabID) -> AnyView) {
        for (index, tab) in tabs.enumerated() where cards[tab] == nil {
            scheduleCard(tab, after: .milliseconds(150 * index)) { content(tab) }
        }
    }

    private func task(after extra: Duration, work: @escaping @MainActor () -> Void) -> Task<Void, Never> {
        Task { [weak self] in
            try? await Task.sleep(for: Self.delay + extra)
            while let self, !self.canRender() {
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
            }
            guard !Task.isCancelled else { return }
            work()
        }
    }

    /// Draws content in the app's appearance. Returns the image so a test can look at it
    /// rather than trust it.
    @discardableResult
    func draw(_ content: AnyView, scale: CGFloat = 2) -> NSImage? {
        let appearance = NSApp?.effectiveAppearance ?? NSAppearance(named: .darkAqua)!
        let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        let renderer = ImageRenderer(content: content.environment(\.colorScheme, isDark ? .dark : .light))
        renderer.scale = scale

        // `Palette` asks NSAppearance for every surface, and ImageRenderer draws in light
        // appearance unless it is told otherwise. This is what tells it.
        var image: NSImage?
        appearance.performAsCurrentDrawingAppearance {
            image = renderer.nsImage
        }
        return image
    }
}

/// A still, as a layer's contents: resizing a layer is a GPU transform, so a card growing
/// from pill to grid never resamples the bitmap on the main thread.
struct TabSnapshotView: NSViewRepresentable {
    let image: NSImage?

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.wantsLayer = true
        view.layer?.contentsGravity = .resizeAspectFill
        view.layer?.minificationFilter = .trilinear
        view.layer?.magnificationFilter = .trilinear
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        nsView.layer?.contents = image
    }
}

import SwiftUI

/// Hosts the tab bar, the mounted tab screens, and the peek.
///
/// Tab switches are instant pane swaps; the peek offset is the only thing that moves the
/// content. The peek is driven by one number, `Workspace.peekProgress`. The trackpad writes it without
/// animation while the fingers are down; lifting them animates it to the nearest stage. Every
/// frame comes from `PeekLayout`, so the same layout code serves the live gesture, the settle
/// animation, and the reverse animation after a tab is chosen.
struct RootView: View {
    @State private var model: OverviewModel
    @State private var workspace: Workspace
    @State private var favicons = FaviconStore()
    @State private var drag: DragSession?

    /// One live three-finger gesture.
    private struct DragSession {
        let start: Double
        var target: Double?
        var committed = false
    }
    @State private var chrome = WindowChrome.fallback
    @State private var isCommandHeld = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(model: OverviewModel = OverviewModel(), workspace: Workspace = Workspace()) {
        _model = State(initialValue: model)
        _workspace = State(initialValue: workspace)
    }

    /// Lands a committed stage with a visible spring. Overshoot past the strip stretches it
    /// (see `PeekLayout.morphDeadzone`) rather than starting the grid.
    private var landing: Animation? {
        reduceMotion ? nil : .spring(duration: 0.55, bounce: 0.3)
    }

    /// Follows the finger during the tease with a little lag, so it feels attached by a spring.
    private var follow: Animation? {
        reduceMotion ? nil : .interactiveSpring(response: 0.28, dampingFraction: 0.8)
    }

    /// Returns to the start stage when the fingers lift before the commit.
    private var snapBack: Animation? {
        reduceMotion ? nil : .spring(duration: 0.4, bounce: 0.15)
    }

    /// Programmatic moves: selecting a tab, keyboard, clicking away.
    private var settle: Animation? {
        reduceMotion ? nil : .spring(duration: 0.4, bounce: 0)
    }

    private var actions: TabActions {
        TabActions(activate: select)
    }

    var body: some View {
        GeometryReader { proxy in
            let layout = PeekLayout(
                size: proxy.size,
                tabCount: workspace.tabs.count,
                progress: workspace.peekProgress,
                chrome: chrome
            )
            let pane = layout.contentFrame

            ZStack(alignment: .topLeading) {
                Color(nsColor: .underPageBackgroundColor)

                TabContentStack(workspace: workspace, model: model, actions: actions, height: pane.height)
                    .frame(width: pane.width, height: pane.height)
                    .allowsHitTesting(!workspace.isPeeking)
                    .overlay {
                        if workspace.isPeeking {
                            // The pushed-down content is inert; clicking it closes the peek.
                            Color.clear
                                .contentShape(.rect)
                                .onTapGesture(perform: closePeek)
                                .accessibilityHidden(true)
                        }
                    }
                    .offset(x: pane.minX, y: pane.minY + layout.contentOffset)

                TabBar(layout: layout, onPeek: advancePeek)

                // The tabs themselves. Always present: a closed peek is just pills.
                PeekOverlay(
                    layout: layout,
                    workspace: workspace,
                    model: model,
                    favicons: favicons,
                    showsShortcuts: isCommandHeld,
                    onSelect: select
                )

                ThreeFingerDragRecognizer(handlers: gestureHandlers)
                    .frame(width: 0, height: 0)

                WindowChromeReader { chrome = $0 }
                    .frame(width: 0, height: 0)

                CommandKeyMonitor { isCommandHeld = $0 }
                    .frame(width: 0, height: 0)

                keyboardShortcuts
            }
            .clipped()
        }
        // Extend under the title bar so the tab bar can take its place.
        .ignoresSafeArea(.container, edges: .top)
        .task {
            await model.start()
        }
        .onChange(of: model.sites.map(\.id), initial: true) { _, siteIDs in
            workspace.reconcile(siteIDs: siteIDs)
        }
        .task(id: model.sites.map(\.id)) {
            await favicons.load(model.sites)
        }
    }

    // MARK: Gesture

    private var gestureHandlers: ThreeFingerDragRecognizer.Handlers {
        ThreeFingerDragRecognizer.Handlers(
            began: {
                guard !model.sites.isEmpty else { return }
                drag = DragSession(start: workspace.peekProgress.rounded())
            },
            changed: { travel in
                guard var session = drag, !session.committed else { return }
                let target = PeekProgress.target(from: session.start, direction: travel)
                session.target = target
                drag = session

                // Nowhere to go in this direction: stay put.
                guard target != session.start else {
                    withAnimation(follow) { workspace.peekProgress = session.start }
                    return
                }

                if PeekProgress.commits(travel: travel, velocity: 0) {
                    commit(&session, to: target)
                } else {
                    let direction: Double = target > session.start ? 1 : -1
                    withAnimation(follow) {
                        workspace.peekProgress = session.start + direction * PeekProgress.tease(travel: travel)
                    }
                }
            },
            ended: { velocity in
                guard var session = drag else { return }
                drag = nil
                guard !session.committed else { return }

                // A quick flick commits even without the full travel.
                if let target = session.target, target != session.start,
                   PeekProgress.commits(travel: target > session.start ? 1e-9 : -1e-9, velocity: velocity) {
                    commit(&session, to: target)
                } else {
                    withAnimation(snapBack) { workspace.peekProgress = session.start }
                }
            }
        )
    }

    private func commit(_ session: inout DragSession, to target: Double) {
        session.committed = true
        drag = session
        withAnimation(landing) { workspace.peekProgress = target }
    }

    // MARK: Actions

    /// Swaps the pane instantly, then closes the peek. From a pill or the strip the new pane
    /// is simply there as the strip retracts. From the grid the pane was pushed out of view,
    /// so closing the peek carries the new pane back up: the push, reversed.
    private func select(_ tab: TabID) {
        workspace.activate(tab)
        withAnimation(settle) {
            workspace.peekProgress = PeekProgress.closed
        }
    }

    private func closePeek() {
        withAnimation(settle) {
            workspace.peekProgress = PeekProgress.closed
        }
    }

    /// Keyboard equivalent of the swipe: closed → strip → grid → closed.
    private func advancePeek() {
        guard !model.sites.isEmpty else { return }
        let next: Double = switch workspace.peekProgress {
        case ..<PeekProgress.strip: PeekProgress.strip
        case ..<PeekProgress.grid: PeekProgress.grid
        default: PeekProgress.closed
        }
        withAnimation(settle) {
            workspace.peekProgress = next
        }
    }

    /// Shortcuts fire regardless of focus. The buttons stay in the hierarchy but are not drawn.
    private var keyboardShortcuts: some View {
        Group {
            Button("Peek projects", action: advancePeek)
                .keyboardShortcut("p", modifiers: [.command, .shift])
            Button("Close peek", action: closePeek)
                .keyboardShortcut(.cancelAction)
            ForEach(0..<9, id: \.self) { index in
                Button("Tab \(index + 1)") {
                    if workspace.tabs.indices.contains(index) {
                        select(workspace.tabs[index])
                    }
                }
                .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
            }
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }
}

#Preview("Root") {
    RootView(model: .preview)
        .frame(width: 1100, height: 680)
}

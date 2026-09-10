import Combine
import SwiftUI

/// Slides a subtree vertically as one transform, instead of as a position change SwiftUI
/// pushes down to the leaves.
///
/// This is what makes the pane's travel affordable. An animated `.offset` on the pane made
/// every row, mark and label in it resolve a new frame on every frame of the travel — Apple's
/// own `geometryGroup()` docs say position changes are pushed down "so that only leaf views
/// apply the current animation to their frame rectangles". A `GeometryEffect` marked
/// `ignoredByLayout()` takes no part in layout, so animating it cannot cause a layout pass:
/// the pane is composited at an offset and costs one transform per frame.
///
/// It follows that the pane's hit region stays where layout put it while the travel is on.
/// Nothing can be clicked there in that moment: the peek's own catcher covers the pane area
/// while the peek is open, and the travel is over by the time it is not.
struct SlideY: GeometryEffect {
    var y: CGFloat

    var animatableData: CGFloat {
        get { y }
        set { y = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: 0, y: y))
    }
}

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
    @State private var history = HistoryStore()
    @State private var rankings = RankingStore()
    /// The reader's own planning thresholds, per site. Owned here beside the stores so one
    /// instance serves every tab and the peek previews.
    @State private var preferences = PlanningPreferences()
    @State private var live = LiveStore()
    @State private var log = LogStore()
    /// One rendered still per tab, which is what the peek's cards show. See `TabSnapshots`.
    @State private var snapshots = TabSnapshots()
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
        TabActions(activate: select, refresh: refresh)
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
            // The rail stands beside every tab's pane and takes its strip off the pane's width.
            let railWidth = ScreenRail.width
            let paneSize = CGSize(width: pane.width - railWidth, height: pane.height)

            ZStack(alignment: .topLeading) {
                Palette.void

                ScreenRail(workspace: workspace) { select(.overview) }
                    .frame(width: railWidth, height: pane.height, alignment: .top)
                    .offset(x: pane.minX, y: pane.minY)
                    .modifier(SlideY(y: paneTravel(layout)).ignoredByLayout())
                    .allowsHitTesting(!workspace.isPeeking)

                TabContentStack(
                    workspace: workspace,
                    model: model,
                    history: history,
                    rankings: rankings,
                    preferences: preferences,
                    live: live,
                    log: log,
                    favicons: favicons,
                    actions: actions,
                    width: paneSize.width,
                    height: paneSize.height
                )
                    .equatable()
                    .offset(x: pane.minX + railWidth, y: pane.minY)
                    .modifier(SlideY(y: paneTravel(layout)).ignoredByLayout())

                // The pushed-down content is inert; clicking where it sits closes the peek.
                // A sibling over the pane rather than an overlay inside it, and always
                // present: an overlay that came and went, and a hit-testing gate on the
                // stack, both rebuilt the hit-test and accessibility trees of all nine
                // mounted screens on the one frame that has to be cheap — the frame a tab is
                // chosen, where `isPeeking` turns false. It keeps its place while the pane
                // travels, because the travel is a transform layout takes no part in, so it
                // also keeps clicks off the pane, which is what that gate was for.
                Color.clear
                    .frame(width: paneSize.width, height: paneSize.height)
                    .contentShape(.rect)
                    .onTapGesture(perform: closePeek)
                    .allowsHitTesting(workspace.isPeeking)
                    .accessibilityHidden(true)
                    .offset(x: pane.minX + railWidth, y: pane.minY)

                TabBar(layout: layout, onPeek: advancePeek)

                // The tabs themselves. Always present: a closed peek is just pills.
                PeekOverlay(
                    layout: layout,
                    workspace: workspace,
                    model: model,
                    favicons: favicons,
                    snapshots: snapshots,
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
        // View > Refresh (⌘R) acts on this window's active tab. See `ViewCommands`.
        .focusedSceneValue(\.refresh) { refresh(workspace.activeTabID) }
        .task {
            await model.start()
        }
        // Stills wait for the peek to be closed before they are drawn. See `TabSnapshots`.
        .onAppear {
            snapshots.canRender = { [workspace] in workspace.isPeekAtRest() }
        }
        // A site added, changed, or removed in Settings shows up here without a manual refresh.
        .onReceive(NotificationCenter.default.publisher(for: .settingsDidChangeSites)) { _ in
            Task { await model.refresh() }
        }
        .onChange(of: model.sites.map(\.id), initial: true) { _, siteIDs in
            workspace.reconcile(siteIDs: siteIDs)
            snapshots.scheduleAll(workspace.tabs) { cardContent(for: $0) }
        }
        // Mount every tab in the idle moments after launch, one per beat, so the first visit
        // to a project is a swap and not a build. See `Workspace.mount`. Each build lands
        // with the pane at rest — never in a frame of the peek — and after the stills, which
        // the peek needs first. A mounted tab warms its own screens (see `SiteTabScreen`),
        // so the beat leaves room for those before the next tab.
        .task(id: workspace.tabs) {
            try? await Task.sleep(for: Self.premountDelay)
            for tab in workspace.tabs where !workspace.mountedTabIDs.contains(tab) {
                while !Task.isCancelled, !workspace.isPeekAtRest() {
                    try? await Task.sleep(for: .milliseconds(250))
                }
                guard !Task.isCancelled else { return }
                workspace.mount(tab)
                try? await Task.sleep(for: Self.premountBeat)
            }
        }
        // A tab is rasterised a beat after the reader leaves it, so its card shows what was
        // last on screen there. See `TabSnapshots` for why a card cannot hold a live screen.
        .onChange(of: workspace.activeTabID) { left, _ in
            snapshots.scheduleCard(left) { cardContent(for: left) }
        }
        .task(id: model.sites.map(\.id)) {
            await favicons.load(model.sites)
        }
    }

    /// When mounting the tabs begins after launch: past the stills, which `TabSnapshots`
    /// draws from 1.8 s. And the gap between one tab and the next: room for the tab's build
    /// and the three screens it warms 120 ms apart.
    private static let premountDelay: Duration = .seconds(3)
    private static let premountBeat: Duration = .milliseconds(700)

    /// How far the pane stands below its place: the peek's own push. Closing the peek
    /// carries the pane and the rail back up the whole way, which is the push reversed.
    private func paneTravel(_ layout: PeekLayout) -> CGFloat {
        layout.contentOffset
    }


    /// What a tab's card still is drawn from: the screen that tab shows, as a preview, at the
    /// still's size. Built here rather than read off the screen, so a tab nobody has opened
    /// yet gets a still too.
    private func cardContent(for tab: TabID) -> AnyView {
        AnyView(
            TabScreen(
                tab: tab,
                workspace: workspace,
                model: model,
                history: history,
                rankings: rankings,
                preferences: preferences,
                live: live,
                log: log,
                favicons: favicons,
                actions: .none
            )
            .environment(\.isTabPreview, true)
            .frame(
                width: TabSnapshots.cardSize.width,
                height: TabSnapshots.cardSize.height,
                alignment: .top
            )
            .background(Palette.panel)
        )
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

    /// Turns of the runloop between the tab swapping and the peek starting to close.
    ///
    /// Bringing a tab to the front costs 60-100 ms of work whatever else is happening —
    /// measured with the peek closed, where nobody can tell, because a late frame is only a
    /// freeze when something is moving. Started in the same breath as the close, that work
    /// landed inside the animation and was the freeze. Given the runloop two turns first, it
    /// lands while the grid is still standing still. Two turns is enough; five measured no
    /// better.
    private static let holdTurns = 2

    /// Swaps the pane instantly, then closes the peek. The grid pushed the pane out of the
    /// window, so closing it carries the pane back up the whole way with the chosen tab
    /// already in it: the push, reversed, and the swap happens where nobody can see it.
    ///
    /// The travel is a transform, not a position — see `SlideY`. An animated `.offset` on
    /// the pane made every row, mark and label resolve a new frame on every frame of the
    /// close, and cost 180-350 ms of over-budget frames per click; none of `geometryGroup`,
    /// `compositingGroup`, `drawingGroup` or `visualEffect` moved that number. A short
    /// 72-point rise instead of the full travel was the same bargain more cheaply (126-406
    /// ms per click, worst frame 88-228) and read as two motions at once, because the pane
    /// landed while the cards were still flying. As one transform the whole travel costs
    /// 0-135 ms per click with a worst frame of 0-47, so the pane and the cards move
    /// together on the same spring and most clicks drop no frame at all.
    private func select(_ tab: TabID) {
        // A switch with the peek closed — ⌘1…⌘9, the rail, ⌘← and ⌘→ — has nothing to close.
        let fromPeek = workspace.isPeeking
        workspace.activate(tab)
        guard fromPeek else { return }

        // Nothing about the peek changes until the swap's own work is done, so the pane
        // stays where the peek put it and the grid holds still through that frame.
        let close = settle
        hop(Self.holdTurns) {
            withAnimation(close) { workspace.peekProgress = PeekProgress.closed }
        }
    }

    /// Runs `work` after `count` turns of the runloop, so the frames in between are
    /// committed first.
    private func hop(_ count: Int, then work: @escaping @MainActor () -> Void) {
        guard count > 0 else { return work() }
        DispatchQueue.main.async {
            MainActor.assumeIsolated { hop(count - 1, then: work) }
        }
    }

    private func closePeek() {
        withAnimation(settle) {
            workspace.peekProgress = PeekProgress.closed
        }
    }

    /// Fetches everything a tab shows again. The overview feeds every tab, so it is always
    /// part of it; the overview tab adds every site's live count and feed, and a site tab its
    /// own series, live count and ranked lists for the period it is on. Each store keeps what
    /// it shows until its answer lands, so nothing blanks. Reached from the screens' refresh
    /// buttons and from View > Refresh (⌘R).
    private func refresh(_ tab: TabID) {
        Task { await model.refresh() }
        if case .overview = tab {
            let siteIDs = model.sites.map(\.id)
            Task { await live.refreshAll(siteIDs) }
            Task { await live.refreshFeeds(siteIDs) }
        }
        guard case .site(let siteID) = tab else { return }
        let period = workspace.state(for: siteID).period
        Task { await history.refresh(siteID) }
        Task { await live.refresh(siteID) }
        // Only when the tab is on the Log: elsewhere nothing shows the record, and a
        // refresh should not fetch what is not on screen. A tab arriving at the Log loads
        // it itself; see `LogScreen`.
        if workspace.state(for: siteID).screen == .log {
            Task { await log.refresh(siteID) }
        }
        // Today has no Search Console window to rank by; its lists come with the live poll.
        if period != .today {
            Task { await rankings.refresh(siteID, period: period) }
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
            // ⌘⌥1…⌘⌥4 choose the active site's screen, the rail's order.
            ForEach(Array(SiteScreen.allCases.enumerated()), id: \.element) { index, screen in
                Button(screen.title) {
                    if case .site(let siteID) = workspace.activeTabID {
                        workspace.state(for: siteID).screen = screen
                    }
                }
                .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: [.command, .option])
            }
            // ⌘← and ⌘→ step along the tab bar, wrapping at the ends.
            Button("Previous tab") {
                if let tab = workspace.neighbourTab(-1) { select(tab) }
            }
            .keyboardShortcut(.leftArrow, modifiers: .command)
            Button("Next tab") {
                if let tab = workspace.neighbourTab(1) { select(tab) }
            }
            .keyboardShortcut(.rightArrow, modifiers: .command)
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

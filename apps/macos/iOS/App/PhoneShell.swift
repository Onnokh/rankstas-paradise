import SwiftUI

/// The iPhone's frame: four tabs along the bottom.
///
/// The Mac reaches the Overview and the Realtime from the rail and keeps one tab per site; a
/// phone has room for neither a rail nor a row of sites, so the two rail screens become tabs,
/// the sites become a list in a tab of their own, and a site's four screens become a switch at
/// the top of its page. The stores are the Mac's, one of each, owned here the way `RootView`
/// owns them and handed down through the environment.
struct PhoneShell: View {
    let account: Account

    @State private var model = OverviewModel()
    @State private var history = HistoryStore()
    @State private var rankings = RankingStore()
    @State private var live = LiveStore()
    @State private var log = LogStore()
    @State private var favicons = FaviconStore()
    @State private var tab: PhoneTab = .overview
    @State private var width: CGFloat = 0

    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView(selection: $tab) {
            OverviewPage()
                .tabItem { Label("Overview", systemImage: PhoneTab.overview.symbol) }
                .tag(PhoneTab.overview)
            RealtimePage()
                .tabItem { Label("Realtime", systemImage: PhoneTab.realtime.symbol) }
                .tag(PhoneTab.realtime)
            SitesPage()
                .tabItem { Label("Sites", systemImage: PhoneTab.sites.symbol) }
                .tag(PhoneTab.sites)
            AccountScreen(account: account)
                .tabItem { Label("Account", systemImage: PhoneTab.account.symbol) }
                .tag(PhoneTab.account)
        }
        .tint(Palette.text)
        // The Duo's inner display has a small tablet's width; the pages read this to lay out
        // the Mac's way there, and the phone's way on the outer display.
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .environment(\.isRoomy, width >= Phone.roomyWidth)
        .environment(model)
        .environment(history)
        .environment(rankings)
        .environment(live)
        .environment(log)
        .environment(favicons)
        .task { await model.start() }
        .task(id: model.sites.map(\.id)) { await favicons.load(model.sites) }
        // A phone comes back to the app after hours, not seconds. The figures it shows are
        // kept until the new ones land, so the refresh changes numbers and never the layout.
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await model.refresh() }
        }
    }
}

enum PhoneTab: Hashable {
    case overview, realtime, sites, account

    /// The rail's symbols for the screens the Mac has too, so one screen wears one mark.
    var symbol: String {
        switch self {
        case .overview: "house"
        case .realtime: "dot.radiowaves.left.and.right"
        case .sites: "square.stack"
        case .account: "person.crop.circle"
        }
    }
}

/// Where a list hands a site to the stack. A wrapper rather than the bare id, so a pushed
/// String can never be read as a site by accident.
struct SiteRoute: Hashable {
    let siteID: Site.ID
}

/// The pages hide the navigation bar to draw the Mac's header row, and UIKit turns the swipe
/// back off with the bar. This turns it on again, wherever there is a page to go back to.
extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1
    }
}

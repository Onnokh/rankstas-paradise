import SwiftUI

/// The rail standing on the canvas beside the pane: the app icon at the top, the Overview
/// under it, the active site's screens one icon each in the middle, and the account at the
/// bottom.
///
/// The rail is window chrome, like the tab bar: it sits on the void, not in the pane, so the
/// pane stays one surface and its rounded corner is kept. It stands beside every tab. The
/// Overview is always in the same place, right under the icon, so it is the one screen that
/// can be reached from anywhere; a site tab adds its four screens below it. Choosing a screen
/// is an instant pane swap, the same as choosing a tab — and the Overview is a tab, so
/// choosing it there is choosing that tab.
///
/// Every measure comes from the pane's own inset, so the rail reads as part of the same
/// grid: an icon starts where the pane would have, `PeekLayout.contentInset` from the window
/// edge, and stands the same inset off the pane. The icon is centred on the pane's header
/// row, the account icon stands the same distance off the pane's bottom edge, and a site's
/// screens are centred between the Overview and the account.
struct ScreenRail: View {
    let workspace: Workspace
    /// Brings the Overview tab to the front, the way the tab bar does.
    let activateOverview: () -> Void

    static let iconSize: CGFloat = 40
    static let spacing: CGFloat = 8
    /// The strip taken off the pane: an icon and the inset between it and the pane. The inset
    /// on the window side is the pane's own, already in the pane's frame.
    static let width: CGFloat = iconSize + PeekLayout.contentInset
    /// The app icon is drawn larger than a symbol: it is a sign, not a control.
    static let markSize: CGFloat = 30
    /// The Overview wears its header's own symbol.
    static let overviewSymbol = "square.grid.2x2"

    /// The room above the app icon and below the account icon: what centres a slot on the header row.
    private static let endInset = (SiteTabScreen.headerHeight - iconSize) / 2

    var body: some View {
        VStack(spacing: Self.spacing) {
            // The app icon as it is in the Dock: the coral tile, the character on it.
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: Self.markSize, height: Self.markSize)
                .frame(width: Self.iconSize, height: Self.iconSize)
                .accessibilityLabel("Ranksta's Paradise")
                .accessibilityAddTraits(.isHeader)

            ScreenRailButton(symbol: Self.overviewSymbol, title: "Overview", isActive: isOverview, action: activateOverview)

            Spacer(minLength: 0)

            if case .site(let siteID) = workspace.activeTabID {
                let state = workspace.state(for: siteID)
                VStack(spacing: Self.spacing) {
                    ForEach(SiteScreen.allCases) { screen in
                        ScreenRailButton(symbol: screen.symbol, title: screen.title, isActive: state.screen == screen) {
                            state.screen = screen
                        }
                    }
                }

                Spacer(minLength: 0)
            }

            // A stand-in for the account: the rail keeps its place until there is one.
            Image(systemName: "person.crop.circle")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: Self.iconSize, height: Self.iconSize)
                .help("Account")
                .accessibilityLabel("Account")
        }
        .padding(.vertical, Self.endInset)
        .frame(width: Self.width, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Screens")
    }

    private var isOverview: Bool {
        if case .overview = workspace.activeTabID { return true }
        return false
    }
}

private struct ScreenRailButton: View {
    let symbol: String
    let title: String
    let isActive: Bool
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(isActive ? .primary : .secondary)
                .frame(width: ScreenRail.iconSize, height: ScreenRail.iconSize)
                // The active screen is a raised surface with a hairline, like a peek card;
                // a hovered one only hints.
                .background(
                    RoundedRectangle(cornerRadius: PeekLayout.cardCornerRadius)
                        .fill(isActive ? Palette.raised : .primary.opacity(isHovering ? 0.06 : 0))
                )
                .overlay {
                    if isActive {
                        RoundedRectangle(cornerRadius: PeekLayout.cardCornerRadius)
                            .strokeBorder(Palette.line)
                    }
                }
                // The headband stands in the gap between the window edge and the icon,
                // centred in it, the way it marks the active row in the guide's nav.
                .overlay(alignment: .leading) {
                    Headband()
                        .fill(Palette.acid)
                        .frame(width: Headband.markerSize.height, height: Headband.markerSize.width)
                        .offset(x: -(PeekLayout.contentInset + Headband.markerSize.height) / 2)
                        .opacity(isActive ? 1 : 0)
                }
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .help(title)
        .accessibilityLabel(title)
        .accessibilityAddTraits(isActive ? .isSelected : [])
        .animation(.snappy(duration: 0.2), value: isActive)
    }
}

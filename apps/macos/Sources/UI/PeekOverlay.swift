import SwiftUI

/// The tabs and the peek, as one set of views. A card is the tab pill grown into a container:
/// its header is the pill, the preview sits inset below. At progress 0 a card is exactly a
/// pill. Cards are positioned by absolute frames from `PeekLayout`, so one card view serves
/// the closed bar, the strip, the grid, and every point in between without being rebuilt.
struct PeekOverlay: View {
    let layout: PeekLayout
    let workspace: Workspace
    let model: OverviewModel
    let history: HistoryStore
    let rankings: RankingStore
    let live: LiveStore
    let favicons: FaviconStore
    /// While Command is held, each card shows its ⌘-number shortcut.
    let showsShortcuts: Bool
    let onSelect: (TabID) -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            let heading = layout.gridHeadingFrame
            Text("Projects")
                .font(.title3.weight(.semibold))
                .frame(width: heading.width, height: heading.height, alignment: .leading)
                .position(x: heading.midX, y: heading.midY)
                .opacity(layout.gridOpacity)
                .allowsHitTesting(false)
                .accessibilityHidden(layout.gridOpacity < 0.5)

            ForEach(Array(workspace.tabs.enumerated()), id: \.element) { index, tab in
                let frame = layout.cardFrame(index)
                let isActive = tab == workspace.activeTabID
                let shortcut: Int? = index < 9 ? index + 1 : nil
                let icon: Image? = if case .site(let siteID) = tab { favicons.image(for: siteID) } else { nil }

                Group {
                    if tab == .overview {
                        // The overview is a summary, laid out natively for the card's size.
                        PeekCard(
                            title: tab.title(in: model),
                            icon: icon,
                            shortcut: shortcut,
                            showsShortcut: showsShortcuts,
                            isActive: isActive,
                            layout: layout,
                            size: frame.size,
                            scalesContent: false,
                            action: { onSelect(tab) }
                        ) {
                            OverviewSummaryCard(model: model)
                        }
                    } else {
                        PeekCard(
                            title: tab.title(in: model),
                            icon: icon,
                            shortcut: shortcut,
                            showsShortcut: showsShortcuts,
                            isActive: isActive,
                            layout: layout,
                            size: frame.size,
                            scalesContent: true,
                            action: { onSelect(tab) }
                        ) {
                            TabScreen(tab: tab, workspace: workspace, model: model, history: history, rankings: rankings, live: live, favicons: favicons, actions: .none)
                        }
                    }
                }
                .frame(width: frame.width, height: frame.height)
                .position(x: frame.midX, y: frame.midY)
            }
        }
        .frame(width: layout.size.width, height: layout.size.height, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Tabs")
    }
}

private struct PeekCard<Screen: View>: View {
    let title: String
    let icon: Image?
    let shortcut: Int?
    let showsShortcut: Bool
    let isActive: Bool
    let layout: PeekLayout
    let size: CGSize
    /// Scaled screens render at a fixed logical size and shrink; native content lays itself
    /// out for the area the card offers.
    let scalesContent: Bool
    let action: () -> Void
    @ViewBuilder let screen: () -> Screen

    @State private var isHovering = false

    private var reveal: CGFloat { layout.reveal }
    private var previewWidth: CGFloat { size.width - layout.cardInset * 2 }
    private var previewHeight: CGFloat {
        max(size.height - layout.cardHeaderHeight - layout.cardInset, 0)
    }

    var body: some View {
        Button(action: action) {
            VStack(spacing: 0) {
                // Identical to the tab pill, so the card starts out looking like the tab.
                TabPillLabel(
                    title: title,
                    icon: icon,
                    shortcut: shortcut,
                    showsShortcut: showsShortcut,
                    isActive: isActive,
                    height: layout.cardHeaderHeight,
                    inset: layout.cardInset
                )
                .frame(width: size.width)

                // Always mounted, hidden by the card's clip while closed. Mounting it on the
                // first drag sample made every preview fill in over a few frames, which read
                // as a flash across the whole bar.
                Group {
                    if scalesContent {
                        ScreenPreview(width: previewWidth, height: previewHeight, screen: screen)
                    } else {
                        screen()
                            .frame(width: previewWidth, height: previewHeight)
                    }
                }
                .clipShape(.rect(cornerRadius: 6))
                .padding(.horizontal, layout.cardInset)
                .padding(.bottom, layout.cardInset)
            }
            .frame(width: size.width, height: size.height, alignment: .top)
            // Children follow the animating card frame instead of animating on their own,
            // so the title and preview never trail the card.
            .geometryGroup()
            .background {
                // The shadow sits on the shape, not the card's contents: a content shadow is
                // re-rasterised on every frame the card changes size.
                ZStack {
                    RoundedRectangle(cornerRadius: PeekLayout.cardCornerRadius)
                        .fill(Palette.raised)
                        .shadow(color: .black.opacity(0.28 * Double(min(reveal, 1))), radius: 10, y: 5)
                    RoundedRectangle(cornerRadius: PeekLayout.cardCornerRadius)
                        .fill(.primary.opacity(fillOpacity))
                }
            }
            .clipShape(.rect(cornerRadius: PeekLayout.cardCornerRadius))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .accessibilityLabel(title)
        .accessibilityHint("Open this project")
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    /// The active pill keeps its fill; inactive pills show a hover fill and gain a faint card
    /// fill as they grow.
    private var fillOpacity: Double {
        if isActive { return 0.12 }
        let hover = isHovering ? 0.05 : 0
        return max(hover, Double(min(reveal, 1)) * (isHovering ? 0.08 : 0.05))
    }
}

/// A non-interactive, scaled-down live render of a tab's screen.
private struct ScreenPreview<Screen: View>: View {
    /// Logical size a screen is rendered at before it is scaled into a card.
    static var renderSize: CGSize { CGSize(width: 980, height: 560) }

    let width: CGFloat
    let height: CGFloat
    @ViewBuilder let screen: () -> Screen

    var body: some View {
        let render = Self.renderSize
        let scale = width / render.width

        screen()
            .environment(\.isTabPreview, true)
            .frame(width: render.width, height: render.height, alignment: .top)
            .background(Palette.panel)
            .scaleEffect(scale, anchor: .topLeading)
            .frame(width: width, height: max(height, 0), alignment: .topLeading)
            .clipped()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

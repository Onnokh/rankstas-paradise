import SwiftUI

/// The tabs and the peek, as one set of views. A card is the tab pill grown into a container:
/// its header is the pill, the preview sits inset below. At progress 0 a card is exactly a
/// pill. Cards are positioned by absolute frames from `PeekLayout`, so one card view serves
/// the closed bar, the strip, the grid, and every point in between without being rebuilt.
struct PeekOverlay: View {
    let layout: PeekLayout
    let workspace: Workspace
    let model: OverviewModel
    let favicons: FaviconStore
    /// A tab's card shows its still. See `TabSnapshots`.
    let snapshots: TabSnapshots
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
                            action: { onSelect(tab) }
                        ) {
                            TabSnapshotView(image: snapshots.card(for: tab))
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
    let action: () -> Void
    @ViewBuilder let screen: () -> Screen

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
                screen()
                    .frame(width: previewWidth, height: previewHeight)
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
        .accessibilityLabel(title)
        .accessibilityHint("Open this project")
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    /// The active pill keeps its fill; the others gain a faint card fill as they grow.
    ///
    /// No hover fill, and no `.onHover`: a card asking for hover made SwiftUI re-resolve the
    /// window's responder node on every frame of the peek — `enqueueHoverUpdateIfNeeded` ->
    /// `responderNode` -> `AG::Graph::update_attribute` was the second largest cost in a
    /// profile of clicking a card, because the cards sweep under a cursor that is not moving.
    private var fillOpacity: Double {
        if isActive { return 0.12 }
        return Double(min(reveal, 1)) * 0.05
    }
}


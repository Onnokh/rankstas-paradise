import CoreGraphics

/// Every frame of the tab bar and the peek, computed from the window size and the peek progress.
///
/// Progress 0...1 reveals the strip: each tab pill grows downwards into a card that holds the
/// preview, and the content is pushed down by the strip height. Progress 1...2 morphs the strip into the grid: each card
/// frame is a straight interpolation between its strip frame and its grid frame, the tab bar
/// fades out and the content leaves the window. Because every frame is a function of one
/// number, a live gesture and a settling animation drive the same layout.
struct PeekLayout {
    static let minimumTabBarHeight: CGFloat = 38
    static let tabMaxWidth: CGFloat = 200
    static let tabSpacing: CGFloat = 10
    static let tabTrailingInset: CGFloat = 12
    static let previewAspect: CGFloat = 560.0 / 980.0
    static let stripPadding: CGFloat = 12
    /// Gap between the card edge and the preview inside it.
    static let previewInset: CGFloat = 8
    /// Extra room under the preview, so the card reads as a frame around it.
    static let cardBottomPadding: CGFloat = 12
    /// Gap between the window edge and the content pane.
    static let contentInset: CGFloat = 12
    static let contentCornerRadius: CGFloat = 12
    static let cardCornerRadius: CGFloat = 10
    static let gridGap: CGFloat = 20
    static let gridHeadingHeight: CGFloat = 44
    static let gridColumns = 2

    /// Progress above the strip that does not yet start the grid morph. A springy landing on
    /// the strip overshoots into this zone and reads as the strip stretching, not the grid
    /// beginning.
    static let morphDeadzone: Double = 0.15

    /// How much of the dead-zone overshoot shows as extra strip growth.
    static let stretchFactor: CGFloat = 0.4

    let size: CGSize
    let tabCount: Int
    let progress: Double
    var chrome = WindowChrome.fallback

    /// The title bar is as tall as the traffic lights are centred, so the lights sit mid-bar.
    var tabBarHeight: CGFloat {
        max(Self.minimumTabBarHeight, chrome.buttonsCenterY * 2)
    }

    /// Pills fill the bar with an even margin above and below.
    var tabPillHeight: CGFloat {
        max(26, tabBarHeight - 16)
    }

    /// The card header is the tab pill itself, so it keeps the pill's height in every stage.
    var cardHeaderHeight: CGFloat {
        tabPillHeight
    }

    func cardHeight(forWidth width: CGFloat) -> CGFloat {
        cardHeaderHeight + Self.previewInset + (width - Self.previewInset * 2) * Self.previewAspect + Self.cardBottomPadding
    }

    func cardWidth(forHeight height: CGFloat) -> CGFloat {
        (height - cardHeaderHeight - Self.previewInset - Self.cardBottomPadding) / Self.previewAspect + Self.previewInset * 2
    }

    /// The content pane: inset from the window on the sides and bottom, below the tab bar.
    var contentFrame: CGRect {
        CGRect(
            x: Self.contentInset,
            y: tabBarHeight,
            width: size.width - Self.contentInset * 2,
            height: size.height - tabBarHeight - Self.contentInset
        )
    }

    /// How far the strip has opened. Runs 0...1, plus a small stretch inside the dead zone.
    var reveal: CGFloat {
        let base = min(max(progress, 0), 1)
        let overshoot = min(max(progress - 1, 0), Self.morphDeadzone)
        // The stretch fades as the morph takes over, so the grid state is exact.
        return CGFloat(base) + CGFloat(overshoot) * Self.stretchFactor * (1 - morph)
    }

    /// 0...1: how far the strip has morphed into the grid. Starts after the dead zone.
    var morph: CGFloat {
        let raw = (progress - 1 - Self.morphDeadzone) / (1 - Self.morphDeadzone)
        return CGFloat(min(max(raw, 0), 1))
    }

    // MARK: Tabs

    var tabWidth: CGFloat {
        let count = CGFloat(max(tabCount, 1))
        let available = size.width - chrome.tabsLeadingX - Self.tabTrailingInset - Self.tabSpacing * (count - 1)
        return max(60, min(Self.tabMaxWidth, available / count))
    }

    /// Pills share the traffic lights' row, so the tab bar reads as the title bar.
    func tabFrame(_ index: Int) -> CGRect {
        CGRect(
            x: chrome.tabsLeadingX + CGFloat(index) * (tabWidth + Self.tabSpacing),
            y: chrome.buttonsCenterY - tabPillHeight / 2,
            width: tabWidth,
            height: tabPillHeight
        )
    }

    // MARK: Strip

    /// A fully revealed strip card: the pill plus the inset preview below it.
    var stripCardHeight: CGFloat {
        cardHeight(forWidth: tabWidth)
    }

    /// How far the fully revealed cards reach below the tab bar, plus breathing room.
    var stripHeight: CGFloat {
        tabFrame(0).minY + stripCardHeight - tabBarHeight + Self.stripPadding
    }

    /// Starts as the pill's own frame and grows downwards with the reveal.
    func stripFrame(_ index: Int) -> CGRect {
        let pill = tabFrame(index)
        return CGRect(
            x: pill.minX,
            y: pill.minY,
            width: pill.width,
            height: pill.height + reveal * (stripCardHeight - pill.height)
        )
    }

    // MARK: Grid

    var gridRows: Int {
        max(1, Int((Double(tabCount) / Double(Self.gridColumns)).rounded(.up)))
    }

    var gridCardSize: CGSize {
        let columns = CGFloat(Self.gridColumns)
        let rows = CGFloat(gridRows)
        let blockWidth = size.width * 0.62
        let blockHeight = size.height * 0.7 - Self.gridHeadingHeight
        let byWidth = (blockWidth - Self.gridGap * (columns - 1)) / columns
        let rowHeight = (blockHeight - Self.gridGap * (rows - 1)) / rows
        let byHeight = cardWidth(forHeight: rowHeight)
        let width = max(120, min(byWidth, byHeight))
        return CGSize(width: width, height: cardHeight(forWidth: width))
    }

    var gridBlockSize: CGSize {
        let card = gridCardSize
        let columns = CGFloat(Self.gridColumns)
        let rows = CGFloat(gridRows)
        return CGSize(
            width: card.width * columns + Self.gridGap * (columns - 1),
            height: Self.gridHeadingHeight + card.height * rows + Self.gridGap * (rows - 1)
        )
    }

    var gridOrigin: CGPoint {
        let block = gridBlockSize
        return CGPoint(x: (size.width - block.width) / 2, y: (size.height - block.height) / 2)
    }

    var gridHeadingFrame: CGRect {
        CGRect(origin: gridOrigin, size: CGSize(width: gridBlockSize.width, height: Self.gridHeadingHeight))
    }

    func gridFrame(_ index: Int) -> CGRect {
        let card = gridCardSize
        let column = CGFloat(index % Self.gridColumns)
        let row = CGFloat(index / Self.gridColumns)
        return CGRect(
            x: gridOrigin.x + column * (card.width + Self.gridGap),
            y: gridOrigin.y + Self.gridHeadingHeight + row * (card.height + Self.gridGap),
            width: card.width,
            height: card.height
        )
    }

    // MARK: Blend

    func cardFrame(_ index: Int) -> CGRect {
        interpolate(stripFrame(index), gridFrame(index), by: morph)
    }

    /// How far the content below the tab bar is pushed down.
    var contentOffset: CGFloat {
        let contentHeight = size.height - tabBarHeight
        return reveal * stripHeight + morph * (contentHeight - stripHeight)
    }

    var tabBarOpacity: Double { Double(1 - morph) }
    var gridOpacity: Double { Double(morph) }
}

/// Where the window's traffic lights are, measured from the live window.
struct WindowChrome: Equatable {
    /// First x the tabs may use, just right of the zoom button.
    var tabsLeadingX: CGFloat
    /// Vertical centre of the traffic lights, from the top of the content.
    var buttonsCenterY: CGFloat

    static let fallback = WindowChrome(tabsLeadingX: 84, buttonsCenterY: 19)
}

private func interpolate(_ a: CGRect, _ b: CGRect, by t: CGFloat) -> CGRect {
    CGRect(
        x: a.minX + (b.minX - a.minX) * t,
        y: a.minY + (b.minY - a.minY) * t,
        width: a.width + (b.width - a.width) * t,
        height: a.height + (b.height - a.height) * t
    )
}

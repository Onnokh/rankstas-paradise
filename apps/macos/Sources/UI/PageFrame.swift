import SwiftUI

/// The measurements every page in a pane is built on.
///
/// They live here rather than on one screen because all of them are shared: the Overview,
/// the Realtime and a project's screens are three pages of one app, and a reader moving
/// between them with the rail should see the page change, not the furniture move. The rail
/// itself reads `headerHeight` to centre its first icon on the header row.
enum Page {
    /// The reading column. Text, numbers and controls stay in one measured column, centred in
    /// the pane; only a chart runs the full width, so the numbers read like a page and the
    /// chart reads like the pane's own floor.
    static let columnWidth: CGFloat = 880
    static let columnInset: CGFloat = 24
    /// The header row's height, over the hairline that closes it.
    static let headerHeight: CGFloat = 56
    /// The room between the header's hairline and the first line of a screen.
    static let screenInset: CGFloat = 32
    /// The room between the strip and the chart under it, on every page that has both.
    static let chartInset: CGFloat = 36
    /// What a full-width chart may take. A page's chart is the same height on every page, so
    /// the cards under it start on the same line.
    static let chartHeight: ClosedRange<CGFloat> = 200...300

    /// A page's mark: a site's favicon, or the rail's symbol for a page that has none.
    static let markSize: CGFloat = 20
    /// The room between the mark and the name, and between the name and whatever follows it.
    static let titleSpacing: CGFloat = 10
    /// The room between the controls at the trailing end of a header row.
    static let controlSpacing: CGFloat = 20
}

/// One page: a header row of one height over a hairline, and the screen under it.
///
/// Every page in a pane wears this, so the header never changes height between them and the
/// first line of one page lands where the first line of the last one was. The header does not
/// scroll: a page's name, its live figure and its period are what the reader steers by, and
/// they were written to be pinned.
struct PageFrame<Header: View, Content: View>: View {
    @ViewBuilder let header: Header
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) {
            header
                .column()
                .frame(height: Page.headerHeight)
            Rectangle()
                .fill(Palette.line)
                .frame(height: 1)
            content
        }
    }
}

/// The leading half of a header row: the page's mark and its name, on the row's centre line.
///
/// A project wears its favicon and falls back to a globe; the Overview and the Realtime wear
/// the same symbol the rail shows them by, so the rail and the page name each other.
struct PageTitle: View {
    /// A site's favicon. Nil wears the symbol instead.
    var icon: Image? = nil
    /// The SF Symbol for a page with no favicon — the rail's own symbol for it.
    var symbol: String = "globe"
    let title: String

    var body: some View {
        HStack(spacing: Page.titleSpacing) {
            Group {
                if let icon {
                    icon.resizable().interpolation(.high).scaledToFit().clipShape(.rect(cornerRadius: 4))
                } else {
                    Image(systemName: symbol)
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: Page.markSize, height: Page.markSize)

            Text(title)
                .font(.title3.weight(.semibold))
                .lineLimit(1)
        }
    }
}

/// The trailing end of a header row: whether anything the page shows is still on its way, and
/// the way to ask for it again. ⌘R lands on the same action through the View menu.
struct RefreshControl: View {
    let busy: Bool
    let action: () -> Void

    var body: some View {
        HStack(spacing: Page.titleSpacing) {
            if busy {
                ProgressView()
                    .controlSize(.small)
            }
            Button("Refresh", systemImage: "arrow.clockwise", action: action)
                .labelStyle(.iconOnly)
                .disabled(busy)
                .help("Refresh (⌘R)")
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
    }
}

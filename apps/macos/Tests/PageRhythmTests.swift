import AppKit
import SwiftUI
import XCTest
@testable import RankstasParadise

/// The Overview, the Realtime and a project's tab are three pages of one app, and the rail
/// moves between them without a window animation. So nothing about the frame may move: the
/// header row is one height on every page, its hairline lands on one line, and the first line
/// of content starts under it in the same place.
///
/// Measured from the pixels rather than from the constants, because the constants agreeing is
/// not the thing that matters — a page can read `Page.headerHeight` and still push its header
/// down with a padding of its own. The pages are drawn at one size and the rows are compared.
@MainActor
final class PageRhythmTests: XCTestCase {
    private static let size = CGSize(width: 1_100, height: 700)

    func testEveryPageCarriesItsHeaderHairlineOnTheSameLine() throws {
        let pages = try Self.pages()
        let lines = try pages.mapValues { try Self.hairlineRow($0) }
        for (name, row) in lines {
            print("PAGE \(name): header hairline at row \(row)")
        }
        let overview = try XCTUnwrap(lines["overview"])
        for (name, row) in lines where name != "overview" {
            XCTAssertEqual(
                row, overview, accuracy: 1,
                "\(name)'s header hairline is \(abs(row - overview)) rows off the Overview's: the header changes height between pages."
            )
        }
        // And it is where the rail expects it: the rail centres its first icon on this row.
        XCTAssertEqual(overview, Page.headerHeight * Self.scale, accuracy: 1)
    }

    func testEveryPageStartsItsContentOnTheSameLine() throws {
        let pages = try Self.pages()
        let firsts = try pages.mapValues { rep -> CGFloat in
            let hairline = try Self.hairlineRow(rep)
            return try Self.firstContentRow(rep, below: hairline)
        }
        for (name, row) in firsts {
            print("PAGE \(name): first line of content at row \(row)")
        }
        let overview = try XCTUnwrap(firsts["overview"])
        for (name, row) in firsts where name != "overview" {
            XCTAssertEqual(
                row, overview, accuracy: 2,
                "\(name)'s first line of content is \(abs(row - overview)) rows off the Overview's: the page's first line moves when the rail switches page."
            )
        }
    }

    // MARK: Drawing

    private static let scale: CGFloat = 2

    /// The three pages, each drawn through the same entry point the window mounts, so a page
    /// cannot be measured in a frame it does not really wear.
    private static func pages() throws -> [String: NSBitmapImageRep] {
        let model = OverviewModel.preview
        let workspace = Workspace()
        workspace.reconcile(siteIDs: model.sites.map(\.id))
        let siteID = try XCTUnwrap(model.sites.first?.id)

        var out: [String: NSBitmapImageRep] = [:]
        for (name, tab) in [("overview", TabID.overview), ("realtime", .realtime), ("project", .site(siteID))] {
            let screen = TabScreen(
                tab: tab,
                workspace: workspace,
                model: model,
                history: HistoryStore(),
                rankings: RankingStore(),
                preferences: PlanningPreferences(),
                live: LiveStore(),
                log: LogStore(),
                favicons: FaviconStore(),
                actions: .none
            )
            let rep = try XCTUnwrap(draw(AnyView(screen)), "\(name) drew nothing")
            // Written out so the three pages can be laid side by side by eye as well.
            let url = URL(fileURLWithPath: "/tmp/page-\(name).png")
            try rep.representation(using: .png, properties: [:])?.write(to: url)
            print("PAGE \(name) → \(url.path)")
            out[name] = rep
        }
        return out
    }

    private static func draw(_ body: AnyView) -> NSBitmapImageRep? {
        let content = body
            .environment(\.isTabPreview, true)
            .foregroundStyle(Palette.text)
            .frame(width: size.width, height: size.height, alignment: .top)
            .background(Palette.panel)
            .environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: content)
        renderer.scale = scale
        var image: NSImage?
        NSAppearance(named: .darkAqua)!.performAsCurrentDrawingAppearance {
            image = renderer.nsImage
        }
        guard let data = image?.tiffRepresentation else { return nil }
        return NSBitmapImageRep(data: data)
    }

    // MARK: Reading the pixels

    /// The header's hairline: the first row near the pane's leading edge that is lighter than
    /// the panel. Read outside the reading column, where only a full-width rule reaches.
    private static func hairlineRow(_ rep: NSBitmapImageRep) throws -> CGFloat {
        let x = 4
        for y in 0..<rep.pixelsHigh {
            if luminance(rep, x, y) > panelLuminance + 0.03 {
                return CGFloat(y)
            }
        }
        throw Failure.notFound("no header hairline")
    }

    /// The first row under the hairline that carries anything: the top of the first line of
    /// the page's content.
    private static func firstContentRow(_ rep: NSBitmapImageRep, below hairline: CGFloat) throws -> CGFloat {
        // Past the hairline itself and any bloom around it.
        let start = Int(hairline) + 4
        for y in start..<rep.pixelsHigh {
            for x in stride(from: 0, to: rep.pixelsWide, by: 3) where luminance(rep, x, y) > panelLuminance + 0.12 {
                return CGFloat(y)
            }
        }
        throw Failure.notFound("no content under the header")
    }

    private static let panelLuminance = 0.05

    private static func luminance(_ rep: NSBitmapImageRep, _ x: Int, _ y: Int) -> Double {
        guard let color = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { return 0 }
        return 0.2126 * color.redComponent + 0.7152 * color.greenComponent + 0.0722 * color.blueComponent
    }

    private enum Failure: Error { case notFound(String) }
}

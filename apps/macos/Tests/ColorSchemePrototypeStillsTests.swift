import AppKit
import SwiftUI
import XCTest
@testable import RankstasParadise

/// PROTOTYPE — throwaway. One still of the whole window per colour scheme, on the overview
/// tab and on a site tab, written to /tmp/scheme-<key>-<tab>.png so the schemes can be
/// looked at side by side without a hand on the keyboard.
@MainActor
final class ColorSchemePrototypeStillsTests: XCTestCase {
    func testOneStillPerScheme() throws {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        let size = CGSize(width: 1280, height: 760)

        for variant in SchemePrototype.Variant.allCases {
            UserDefaults.standard.set(variant.rawValue, forKey: SchemePrototype.defaultsKey)
            SchemePrototype.current = variant.scheme

            for (tabName, tab) in [("overview", TabID.overview), ("site", nil)] {
                let model = OverviewModel.preview
                let workspace = Workspace()
                workspace.reconcile(siteIDs: model.sites.map(\.id))
                workspace.activate(tab ?? .site(model.sites[0].id))

                let content = AnyView(
                    RootView(model: model, workspace: workspace)
                        // ImageRenderer draws no ScrollView content; the preview column is
                        // the screens' non-scrolling body. See `TabSnapshots`.
                        .environment(\.isTabPreview, true)
                        .frame(width: size.width, height: size.height)
                )
                let image = try XCTUnwrap(TabSnapshots().draw(content, scale: 1))
                let rep = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(image.tiffRepresentation)))
                let url = URL(fileURLWithPath: "/tmp/scheme-\(variant.rawValue)-\(tabName).png")
                try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
                print("STILL \(variant.key) \(tabName) → \(url.path)")
            }
        }
        UserDefaults.standard.removeObject(forKey: SchemePrototype.defaultsKey)
    }
}

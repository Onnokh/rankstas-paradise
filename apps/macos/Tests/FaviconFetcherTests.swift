import XCTest
@testable import RankstasParadise

final class FaviconFetcherTests: XCTestCase {
    private let base = URL(string: "https://example.com/some/page")!

    func testPrefersTouchIconThenLargestThenDocumentOrder() {
        let html = """
        <html><head>
        <link rel="icon" href="/small.png" sizes="16x16">
        <link rel="shortcut icon" href="favicon.ico">
        <link rel="icon" type="image/png" sizes="192x192" href="/big.png">
        <link rel="apple-touch-icon" href="/touch.png">
        <link rel="stylesheet" href="/style.css">
        </head><body><link rel="icon" href="/in-body.png"></body></html>
        """
        let urls = FaviconFetcher.iconLinks(in: html, base: base).map(\.absoluteString)
        XCTAssertEqual(urls, [
            "https://example.com/touch.png",
            "https://example.com/big.png",
            "https://example.com/small.png",
            "https://example.com/some/favicon.ico",
        ])
    }

    func testHandlesSingleQuotesAndBareAttributes() {
        let html = "<head><LINK REL='icon' HREF=/bare.svg></head>"
        XCTAssertEqual(FaviconFetcher.iconLinks(in: html, base: base).first?.absoluteString, "https://example.com/bare.svg")
    }

    func testNoIconsGivesEmptyList() {
        XCTAssertTrue(FaviconFetcher.iconLinks(in: "<head><title>x</title></head>", base: base).isEmpty)
    }

    func testTextOnlySVGYieldsItsGlyph() {
        let svg = """
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
          <text x="16" y="17" font-size="26" text-anchor="middle">🎈</text>
        </svg>
        """
        XCTAssertEqual(FaviconDecoder.textGlyph(inSVG: Data(svg.utf8)), "🎈")
    }

    func testDrawnSVGAndBitmapsAreNotTreatedAsText() {
        XCTAssertNil(FaviconDecoder.textGlyph(inSVG: Data("<svg><circle r=\"5\"/></svg>".utf8)))
        XCTAssertNil(FaviconDecoder.textGlyph(inSVG: Data([0x89, 0x50, 0x4E, 0x47])))
    }
}

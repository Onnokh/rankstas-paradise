import AppKit
import Foundation
import Observation
import SwiftUI

/// Finds, caches and hands out each site's favicon for the tab bar.
///
/// Icons are looked up once per site: the disk cache first, then the site's HTML head for
/// `<link rel="icon">`-style tags, then the well-known paths. Bytes are cached on disk next to
/// the overview snapshot, so a warm launch shows icons without any network.
@MainActor
@Observable
final class FaviconStore {
    private(set) var icons: [Site.ID: NSImage] = [:]

    @ObservationIgnored private let fetcher: FaviconFetcher
    @ObservationIgnored private var inFlight: Set<Site.ID> = []

    init(fetcher: FaviconFetcher = FaviconFetcher()) {
        self.fetcher = fetcher
    }

    func image(for siteID: Site.ID) -> Image? {
        icons[siteID].map { Image(nsImage: $0) }
    }

    /// Loads icons for sites that do not have one yet. Safe to call on every site list change.
    func load(_ sites: [Site]) async {
        let pending = sites.filter { icons[$0.id] == nil && !inFlight.contains($0.id) }
        guard !pending.isEmpty else { return }
        for site in pending { inFlight.insert(site.id) }
        defer { for site in pending { inFlight.remove(site.id) } }

        await withTaskGroup(of: (Site.ID, Data?).self) { group in
            for site in pending {
                group.addTask { [fetcher] in
                    (site.id, await fetcher.favicon(for: site))
                }
            }
            for await (siteID, data) in group {
                if let data, let image = FaviconDecoder.image(from: data) {
                    icons[siteID] = image.trimmingTransparentMargins()
                }
            }
        }
    }
}

/// Fetches favicon bytes for a site, with a disk cache. Runs off the main actor.
struct FaviconFetcher: Sendable {
    let cacheDirectory: URL
    let session: URLSession

    init(
        cacheDirectory: URL = OverviewCache.defaultURL.deletingLastPathComponent().appending(path: "favicons", directoryHint: .isDirectory),
        session: URLSession = .shared
    ) {
        self.cacheDirectory = cacheDirectory
        self.session = session
    }

    func favicon(for site: Site) async -> Data? {
        let cacheURL = cacheDirectory.appending(path: "\(site.id).icon", directoryHint: .notDirectory)
        if let cached = try? Data(contentsOf: cacheURL), !cached.isEmpty {
            return cached
        }
        guard let base = URL(string: site.origin) else { return nil }

        var candidates: [URL] = []
        if let html = try? await string(from: base) {
            candidates += Self.iconLinks(in: html, base: base)
        }
        candidates.append(base.appending(path: "apple-touch-icon.png"))
        candidates.append(base.appending(path: "favicon.ico"))

        for url in candidates {
            guard let data = try? await imageData(from: url) else { continue }
            try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
            try? data.write(to: cacheURL, options: .atomic)
            return data
        }
        return nil
    }

    /// Icon URLs declared in the page head, best first: touch icons, then the largest declared
    /// size, then any icon in document order.
    static func iconLinks(in html: String, base: URL) -> [URL] {
        let head = html.range(of: "</head>", options: .caseInsensitive).map { String(html[..<$0.lowerBound]) } ?? html
        let tagPattern = try! NSRegularExpression(pattern: "<link\\b[^>]*>", options: .caseInsensitive)
        let tags = tagPattern.matches(in: head, range: NSRange(head.startIndex..., in: head))
            .compactMap { Range($0.range, in: head).map { String(head[$0]) } }

        struct Candidate { let url: URL; let isTouch: Bool; let size: Int; let order: Int }
        var candidates: [Candidate] = []
        for (order, tag) in tags.enumerated() {
            guard let rel = attribute("rel", in: tag)?.lowercased(), rel.contains("icon"),
                  let href = attribute("href", in: tag),
                  let url = URL(string: href, relativeTo: base)?.absoluteURL
            else { continue }
            let sizes = attribute("sizes", in: tag) ?? ""
            let size = sizes.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }.max() ?? 0
            candidates.append(Candidate(url: url, isTouch: rel.contains("apple-touch-icon"), size: size, order: order))
        }
        return candidates
            .sorted { a, b in
                if a.isTouch != b.isTouch { return a.isTouch }
                if a.size != b.size { return a.size > b.size }
                return a.order < b.order
            }
            .map(\.url)
    }

    private static func attribute(_ name: String, in tag: String) -> String? {
        let pattern = try! NSRegularExpression(pattern: "\\b\(name)\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", options: .caseInsensitive)
        guard let match = pattern.firstMatch(in: tag, range: NSRange(tag.startIndex..., in: tag)) else { return nil }
        for group in 2...4 {
            if let range = Range(match.range(at: group), in: tag) { return String(tag[range]) }
        }
        return nil
    }

    private func string(from url: URL) async throws -> String {
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        let (data, _) = try await session.data(for: request)
        return String(decoding: data.prefix(200_000), as: UTF8.self)
    }

    private func imageData(from url: URL) async throws -> Data? {
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), !data.isEmpty else { return nil }
        // Some servers answer 200 with an HTML page for missing icons; make sure it decodes.
        guard NSBitmapImageRep(data: data) != nil || NSImage(data: data)?.isValid == true else { return nil }
        return data
    }
}

extension NSImage {
    /// Crops away fully transparent margins, so icons that pad themselves inside the file
    /// fill the tab's icon slot like icons that do not.
    func trimmingTransparentMargins() -> NSImage {
        guard
            let cgImage = cgImage(forProposedRect: nil, context: nil, hints: nil),
            let box = cgImage.opaqueBoundingBox(),
            box != CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height),
            let cropped = cgImage.cropping(to: box)
        else { return self }
        return NSImage(cgImage: cropped, size: NSSize(width: box.width, height: box.height))
    }
}

private extension CGImage {
    /// The pixel bounds of everything with a visible alpha, or nil when the image is empty.
    func opaqueBoundingBox() -> CGRect? {
        let width = self.width, height = self.height
        guard width > 0, height > 0 else { return nil }
        var pixels = [UInt8](repeating: 0, count: width * height)
        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.alphaOnly.rawValue
        ) else { return nil }
        context.draw(self, in: CGRect(x: 0, y: 0, width: width, height: height))

        var minX = width, minY = height, maxX = -1, maxY = -1
        for y in 0..<height {
            for x in 0..<width where pixels[y * width + x] > 16 {
                minX = min(minX, x); maxX = max(maxX, x)
                minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        guard maxX >= minX, maxY >= minY else { return nil }
        // Leave a one-pixel margin so anti-aliased edges are not clipped.
        let rect = CGRect(x: minX - 1, y: minY - 1, width: maxX - minX + 3, height: maxY - minY + 3)
        return rect.intersection(CGRect(x: 0, y: 0, width: width, height: height))
    }
}

/// Turns favicon bytes into an image, covering the case AppKit's SVG support does not.
enum FaviconDecoder {
    @MainActor
    static func image(from data: Data) -> NSImage? {
        if let glyph = textGlyph(inSVG: data) {
            return rasterize(glyph)
        }
        return NSImage(data: data)
    }

    /// Some favicons are an SVG with a single `<text>` element, typically an emoji drawn by the
    /// system font. AppKit renders those as a blob, so the text is drawn with the system font
    /// instead. Returns nil for anything that is not such an SVG.
    static func textGlyph(inSVG data: Data) -> String? {
        guard let svg = String(data: data.prefix(20_000), encoding: .utf8),
              svg.range(of: "<svg", options: .caseInsensitive) != nil
        else { return nil }
        let pattern = try! NSRegularExpression(pattern: "<text\\b[^>]*>([^<]*)</text>", options: [.caseInsensitive, .dotMatchesLineSeparators])
        guard let match = pattern.firstMatch(in: svg, range: NSRange(svg.startIndex..., in: svg)),
              let range = Range(match.range(at: 1), in: svg)
        else { return nil }
        let text = svg[range].trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    @MainActor
    private static func rasterize(_ glyph: String) -> NSImage {
        let side: CGFloat = 64
        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: side * 0.78)]
            let string = NSAttributedString(string: glyph, attributes: attributes)
            let size = string.size()
            string.draw(at: NSPoint(x: (rect.width - size.width) / 2, y: (rect.height - size.height) / 2))
            return true
        }
        return image
    }
}

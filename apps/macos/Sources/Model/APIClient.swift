import Foundation

struct APIClient: Sendable {
    private let target: RemoteTarget
    private let session: URLSession

    init(target: RemoteTarget, session: URLSession = .shared) {
        self.target = target
        self.session = session
    }

    func sites() async throws -> [Site] {
        let envelope: SitesEnvelope = try await get(path: "/api/sites")
        return envelope.sites
    }

    func dashboard(siteID: String) async throws -> DashboardEnvelope {
        try await get(path: "/api/dashboard", query: [URLQueryItem(name: "site", value: siteID)])
    }

    func history(siteID: String, limit: Int) async throws -> HistoryReport {
        try await get(
            path: "/api/history",
            query: [URLQueryItem(name: "site", value: siteID), URLQueryItem(name: "limit", value: String(limit))]
        )
    }

    /// The people on the site right now. Polled while a site screen is shown; see `LiveStore`.
    func live(siteID: String) async throws -> LiveReport {
        try await get(path: "/api/live", query: [URLQueryItem(name: "site", value: siteID)])
    }

    /// The strongest search terms over `windowDays`, brand terms included: the card ranks
    /// what brings clicks, and for a small site that is often the brand.
    func queries(siteID: String, windowDays: Int, limit: Int) async throws -> QueriesReport {
        try await get(
            path: "/api/queries",
            query: [
                URLQueryItem(name: "site", value: siteID),
                URLQueryItem(name: "window", value: String(windowDays)),
                URLQueryItem(name: "include-brand", value: "true"),
                URLQueryItem(name: "limit", value: String(limit)),
            ]
        )
    }

    /// Today so far, from the provider. Polled with the live count; see `LiveStore`.
    func today(siteID: String) async throws -> TodayReport {
        try await get(path: "/api/today", query: [URLQueryItem(name: "site", value: siteID)])
    }

    /// The site's custom events over `windowDays` against the window before.
    func events(siteID: String, windowDays: Int) async throws -> EventsReport {
        try await get(
            path: "/api/events",
            query: [URLQueryItem(name: "site", value: siteID), URLQueryItem(name: "window", value: String(windowDays))]
        )
    }

    /// The site's sales over `windowDays` whole days against the window before, from the ledger.
    func revenue(siteID: String, windowDays: Int) async throws -> RevenueReport {
        try await get(
            path: "/api/revenue",
            query: [URLQueryItem(name: "site", value: siteID), URLQueryItem(name: "window", value: String(windowDays))]
        )
    }

    func registry(siteID: String) async throws -> RegistryListReport {
        try await get(path: "/api/registry", query: [URLQueryItem(name: "site", value: siteID)])
    }

    private func get<Response: Decodable & Sendable>(
        path: String,
        query: [URLQueryItem] = []
    ) async throws -> Response {
        guard let baseURL = target.baseURL,
              var components = URLComponents(
                url: baseURL.appending(path: path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))),
                resolvingAgainstBaseURL: false
              ) else {
            throw APIError.invalidBaseURL(target.apiUrl)
        }

        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else {
            throw APIError.invalidBaseURL(target.apiUrl)
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(target.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 20

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8)
            throw APIError.http(status: http.statusCode, body: body)
        }

        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw APIError.decoding(error.localizedDescription)
        }
    }
}

enum APIError: LocalizedError {
    case invalidBaseURL(String)
    case invalidResponse
    case http(status: Int, body: String?)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .invalidBaseURL(let value):
            "Invalid RP_API_URL: \(value)"
        case .invalidResponse:
            "The server returned an invalid response."
        case .http(let status, let body):
            "The server returned HTTP \(status).\(body.map { " \($0)" } ?? "")"
        case .decoding(let message):
            "The dashboard response did not match the expected shape: \(message)"
        }
    }
}


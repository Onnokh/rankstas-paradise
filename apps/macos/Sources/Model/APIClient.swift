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

    /// What visitors did in the last half hour, newest first, or only what is newer than
    /// `since` when given. Polled every few seconds while the overview is shown; see `LiveStore`.
    func liveEvents(siteID: String, since: String?) async throws -> LiveEventsReport {
        var query = [URLQueryItem(name: "site", value: siteID)]
        if let since {
            query.append(URLQueryItem(name: "since", value: since))
        }
        return try await get(path: "/api/live/events", query: query)
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

    func registryHealth(siteID: String) async throws -> RegistryHealthReport {
        try await get(
            path: "/api/registry/health",
            query: [URLQueryItem(name: "site", value: siteID)]
        )
    }

    func keywordProposals(siteID: String) async throws -> KeywordProposalsReport {
        try await get(
            path: "/api/keywords/proposed",
            query: [URLQueryItem(name: "site", value: siteID)]
        )
    }

    /// Sets proposals aside; answers how many rows changed. There is no `discover` here on
    /// purpose: a discovery run costs money on every call, so it is asked for over MCP
    /// where the caller can read the drop counts before spending again.
    @discardableResult
    func keywordsDismiss(_ keywords: [String], siteID: String) async throws -> Int {
        struct Body: Encodable { let keywords: [String] }
        struct Result: Decodable, Sendable { let dismissed: Int }
        let result: Result = try await send(
            method: "POST",
            path: "/api/keywords/dismiss",
            query: [URLQueryItem(name: "site", value: siteID)],
            body: Body(keywords: keywords)
        )
        return result.dismissed
    }

    func get<Response: Decodable & Sendable>(
        path: String,
        query: [URLQueryItem] = []
    ) async throws -> Response {
        try await send(method: "GET", path: path, query: query, body: Optional<Int>.none)
    }

    /// One round trip with an optional JSON body. Every write the settings pages make goes
    /// through here; the response envelope is decoded as `Response`.
    func send<Body: Encodable & Sendable, Response: Decodable & Sendable>(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        body: Body?
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
        request.httpMethod = method
        request.setValue("Bearer \(target.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        request.timeoutInterval = 20

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(status: http.statusCode, body: APIError.serverMessage(in: data))
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

    /// The server's `{ "error": "…" }` message when the body is one, else the raw body.
    static func serverMessage(in data: Data) -> String? {
        if let envelope = try? JSONDecoder().decode([String: String].self, from: data),
           let message = envelope["error"] {
            return message
        }
        return String(data: data, encoding: .utf8)
    }

    var errorDescription: String? {
        switch self {
        case .invalidBaseURL(let value):
            "Invalid RP_API_URL: \(value)"
        case .invalidResponse:
            "The server returned an invalid response."
        case .http(let status, let body):
            body.map { "\($0) (HTTP \(status))" } ?? "The server returned HTTP \(status)."
        case .decoding(let message):
            "The dashboard response did not match the expected shape: \(message)"
        }
    }
}


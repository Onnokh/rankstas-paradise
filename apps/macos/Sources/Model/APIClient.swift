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


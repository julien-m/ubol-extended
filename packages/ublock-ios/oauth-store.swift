import Foundation
import Security

struct StoredAuthorization: Codable {
    let accessToken: String
    let refreshToken: String?
    let expiresAt: Date
}

enum DriveAuthorizationError: LocalizedError {
    case configureClient, openApp, keychain, invalidResponse, cancelled
    var errorDescription: String? {
        switch self {
        case .configureClient: return "Configurer le client OAuth Google iOS, puis reconstruire l’app."
        case .openApp: return "Ouvrir l’app uBOL Extended et connecter Google Drive."
        case .keychain: return "Le trousseau partagé n’est pas accessible. Vérifier la signature et les entitlements."
        case .invalidResponse: return "Google n’a pas fourni une autorisation Drive valide."
        case .cancelled: return "Connexion annulée."
        }
    }
}

enum DriveConfiguration {
    static var clientID: String { Bundle.main.object(forInfoDictionaryKey: "UbolGoogleClientID") as? String ?? "" }
    static var accessGroup: String { Bundle.main.object(forInfoDictionaryKey: "UbolKeychainAccessGroup") as? String ?? "" }
    static var callbackScheme: String {
        let suffix = ".apps.googleusercontent.com"
        guard clientID.hasSuffix(suffix) else { return "" }
        return "com.googleusercontent.apps." + clientID.dropLast(suffix.count)
    }
}

actor DriveAuthorizationStore {
    static let shared = DriveAuthorizationStore()
    private let service = "local.ublock-lite.google-drive"
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: "google-drive",
         kSecAttrAccessGroup as String: DriveConfiguration.accessGroup]
    }
    private func read() throws -> StoredAuthorization? {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw DriveAuthorizationError.keychain }
        return try JSONDecoder().decode(StoredAuthorization.self, from: data)
    }
    func save(_ value: StoredAuthorization) throws {
        let data = try JSONEncoder().encode(value)
        let update = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw DriveAuthorizationError.keychain }
        } else if status != errSecSuccess { throw DriveAuthorizationError.keychain }
    }
    func disconnect() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw DriveAuthorizationError.keychain }
    }
    func token() async throws -> String {
        guard !DriveConfiguration.clientID.isEmpty else { throw DriveAuthorizationError.configureClient }
        guard let current = try read() else { throw DriveAuthorizationError.openApp }
        if current.expiresAt.timeIntervalSinceNow > 60 { return current.accessToken }
        guard let refreshToken = current.refreshToken, !refreshToken.isEmpty else { throw DriveAuthorizationError.openApp }
        let renewed = try await Self.exchange([
            "client_id": DriveConfiguration.clientID,
            "grant_type": "refresh_token", "refresh_token": refreshToken,
        ], previousRefreshToken: refreshToken)
        try save(renewed)
        return renewed.accessToken
    }
    static func exchange(_ fields: [String: String], previousRefreshToken: String? = nil) async throws -> StoredAuthorization {
        var components = URLComponents()
        components.queryItems = fields.map { URLQueryItem(name: $0.key, value: $0.value) }
        var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B").data(using: .utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["access_token"] as? String, !token.isEmpty,
              (json["token_type"] as? String)?.lowercased() == "bearer",
              let expiry = json["expires_in"] as? Double, expiry > 0 else { throw DriveAuthorizationError.invalidResponse }
        return StoredAuthorization(accessToken: token, refreshToken: json["refresh_token"] as? String ?? previousRefreshToken,
                                   expiresAt: Date().addingTimeInterval(expiry))
    }
}

import Foundation
import CryptoKit
import Security

enum OAuthFlow {
    enum InvalidFlow: Error { case randomness, authorizationURL, callback }
    static func nonce() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw InvalidFlow.randomness }
        return base64URL(Data(bytes))
    }
    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func authorizationURL(clientID: String, redirect: String, verifier: String, state: String) throws -> URL {
        let challenge = base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        var auth = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        auth.queryItems = [
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: redirect),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: "https://www.googleapis.com/auth/drive.appdata"),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "access_type", value: "offline"),
            URLQueryItem(name: "prompt", value: "consent"),
        ]
        guard let url = auth.url else { throw InvalidFlow.authorizationURL }
        return url
    }
    static func authorizationCode(callback: URL, redirect: URL, state: String) throws -> String {
        guard callback.scheme == redirect.scheme, callback.host == redirect.host,
              callback.port == redirect.port, callback.path == redirect.path,
              callback.fragment == nil,
              let fields = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems,
              fields.filter({ $0.name == "state" }).count == 1,
              fields.filter({ $0.name == "code" }).count == 1,
              !fields.contains(where: { $0.name == "error" }),
              fields.first(where: { $0.name == "state" })?.value == state,
              let code = fields.first(where: { $0.name == "code" })?.value, !code.isEmpty else { throw InvalidFlow.callback }
        return code
    }
}

import SwiftUI
import Combine
import AuthenticationServices

@main
struct UBlockLocalApp: App {
    var body: some Scene { WindowGroup { DriveConnectionView() } }
}

struct DriveConnectionView: View {
    @StateObject private var connection = DriveConnection()
    var body: some View {
        NavigationStack {
            Form {
                Section("Extension Safari") {
                    Text("Dans Réglages → Apps → Safari → Extensions, activez uBOL Extended et autorisez l’accès aux sites à nettoyer.")
                    Text("Les filtres et la synchronisation se règlent ensuite dans le tableau de bord de l’extension Safari.")
                }
                Section("Google Drive") {
                    Text("Connectez le même compte que sur le Mac. Seules les données de cette application sont accessibles ; les tokens restent dans le trousseau de cet iPhone.")
                    Button("Connecter Google Drive") { Task { await connection.connect() } }
                        .disabled(connection.busy || DriveConfiguration.clientID.isEmpty)
                    Button("Déconnecter cet iPhone", role: .destructive) { Task { await connection.disconnect() } }
                        .disabled(connection.busy)
                    Text(connection.status).font(.footnote).accessibilityIdentifier("drive-status")
                    if DriveConfiguration.clientID.isEmpty {
                        Text("Le client OAuth iOS n’est pas encore configuré pour ce build.").font(.footnote)
                    }
                }
            }.navigationTitle("uBOL Extended")
        }
    }
}

@MainActor
final class DriveConnection: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    @Published var busy = false
    @Published var status = "Aucune connexion vérifiée."
    private var session: ASWebAuthenticationSession?

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
        return scene?.windows.first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
    func connect() async {
        guard !busy else { return }
        busy = true
        defer { busy = false; session = nil }
        do {
            guard !DriveConfiguration.clientID.isEmpty, !DriveConfiguration.callbackScheme.isEmpty else { throw DriveAuthorizationError.configureClient }
            let verifier = try OAuthFlow.nonce()
            let state = try OAuthFlow.nonce()
            let redirect = "\(DriveConfiguration.callbackScheme):/oauthredirect"
            let authURL = try OAuthFlow.authorizationURL(clientID: DriveConfiguration.clientID, redirect: redirect, verifier: verifier, state: state)
            let callback: URL = try await withCheckedThrowingContinuation { continuation in
                let flow = ASWebAuthenticationSession(url: authURL, callbackURLScheme: DriveConfiguration.callbackScheme) { callback, error in
                    if let callback { continuation.resume(returning: callback) }
                    else { continuation.resume(throwing: error ?? DriveAuthorizationError.cancelled) }
                }
                flow.presentationContextProvider = self
                self.session = flow
                if !flow.start() { continuation.resume(throwing: DriveAuthorizationError.cancelled) }
            }
            let code = try OAuthFlow.authorizationCode(callback: callback, redirect: URL(string: redirect)!, state: state)
            let authorization = try await DriveAuthorizationStore.exchange([
                "client_id": DriveConfiguration.clientID, "redirect_uri": redirect,
                "code": code, "code_verifier": verifier, "grant_type": "authorization_code",
            ])
            try await DriveAuthorizationStore.shared.save(authorization)
            // Verify access to this application's Drive space before claiming connection.
            var request = URLRequest(url: URL(string: "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&pageSize=1&fields=files(id)")!)
            request.setValue("Bearer \(authorization.accessToken)", forHTTPHeaderField: "Authorization")
            request.timeoutInterval = 20
            let (_, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw DriveAuthorizationError.invalidResponse }
            status = "Google Drive connecté et accès vérifié. Retournez dans Safari pour synchroniser."
        } catch {
            status = (error as? DriveAuthorizationError)?.localizedDescription ?? "Connexion Google Drive non aboutie. Réessayez depuis l’app."
        }
    }
    func disconnect() async {
        do { try await DriveAuthorizationStore.shared.disconnect(); status = "Autorisation locale supprimée de cet iPhone." }
        catch { status = DriveAuthorizationError.keychain.localizedDescription }
    }
}


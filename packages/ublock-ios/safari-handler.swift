import Foundation
import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        guard let input = context.inputItems.first as? NSExtensionItem,
              let message = input.userInfo?[SFExtensionMessageKey] as? [String: Any],
              message["type"] as? String == "driveToken" else {
            reply(context, ["error": "unsupported_native_message"])
            return
        }
        Task {
            do {
                let token = try await DriveAuthorizationStore.shared.token()
                reply(context, ["token": token])
            } catch {
                reply(context, ["error": "open_app_required", "message": (error as? DriveAuthorizationError)?.localizedDescription ?? "Ouvrir l’app pour reconnecter Google Drive."])
            }
        }
    }
    private func reply(_ context: NSExtensionContext, _ message: [String: String]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: message]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}

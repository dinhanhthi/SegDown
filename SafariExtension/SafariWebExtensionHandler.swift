// Safari's native messaging endpoint: each `browser.runtime.sendNativeMessage` lands here as one
// NSExtensionItem. The message is validated like `segdown-host` validates a frame, then relayed to
// the app's Unix socket at the real-home path from `IPC.socketURL()` (reachable through the sbpl
// exception in SegDownSafari.entitlements). When the app is not running it is launched hidden once
// and the socket polled. Logs carry outcome codes only, never payloads.
import AppKit
import Foundation
import os
import SafariServices
import SegDownCore

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    /// Polling cadence and window for the socket after launching the app (as in segdown-host).
    private static let retryInterval: TimeInterval = 0.25
    private static let retryWindow: TimeInterval = 5
    private static let launchTimeout: TimeInterval = 10

    private let logger = Logger(subsystem: "com.math2it.segdown.safari", category: "handler")

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let response = handle(item?.userInfo?[SFExtensionMessageKey])
        let reply = NSExtensionItem()
        reply.userInfo = [SFExtensionMessageKey: dictionary(response)]
        context.completeRequest(returningItems: [reply], completionHandler: nil)
    }

    /// Validates the message like `segdown-host` does, then relays it.
    private func handle(_ message: Any?) -> IPCResponse {
        guard let message, JSONSerialization.isValidJSONObject(message),
              let payload = try? JSONSerialization.data(withJSONObject: message),
              payload.count <= NativeMessaging.maxFrameBytes
        else {
            logger.error("request rejected: not a JSON object")
            return .error(code: IPCResponse.ErrorCode.invalid, message: "Message is not a JSON object")
        }
        let request: IPCRequest
        do {
            request = try NativeMessaging.decodeRequest(payload)
        } catch {
            logger.error("request rejected: invalid")
            return .error(code: IPCResponse.ErrorCode.invalid, message: error.localizedDescription)
        }
        return relay(request)
    }

    /// Relays `request`; when the app is not running, launches it once and polls the socket.
    private func relay(_ request: IPCRequest) -> IPCResponse {
        let notRunning = IPCResponse.error(code: IPCResponse.ErrorCode.unavailable, message: "SegDown app is not running")
        do {
            return try IPC.send(request, to: IPC.socketURL(), timeout: IPC.defaultTimeout)
        } catch IPCError.appNotRunning {
            guard let app = containingApp() else {
                logger.error("relay failed: not inside an app bundle")
                return notRunning
            }
            launch(app)
            let deadline = Date().addingTimeInterval(Self.retryWindow)
            while true {
                do {
                    return try IPC.send(request, to: IPC.socketURL(), timeout: IPC.defaultTimeout)
                } catch IPCError.appNotRunning {
                    if Date() >= deadline {
                        logger.error("relay failed: app not running after launch")
                        return notRunning
                    }
                    Thread.sleep(forTimeInterval: Self.retryInterval)
                } catch {
                    return unavailable(error)
                }
            }
        } catch {
            return unavailable(error)
        }
    }

    private func unavailable(_ error: any Error) -> IPCResponse {
        logger.error("relay failed: \(error.localizedDescription, privacy: .public)")
        return .error(code: IPCResponse.ErrorCode.unavailable, message: error.localizedDescription)
    }

    /// `SegDown.app` from this appex's bundle (`<app>/Contents/PlugIns/SegDownSafari.appex`), or nil.
    private func containingApp() -> URL? {
        let app = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        return app.pathExtension == "app" ? app : nil
    }

    /// Opens `app` hidden, without activating it, and waits for the launch to finish (bounded).
    private func launch(_ app: URL) {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.hides = true
        let done = DispatchSemaphore(value: 0)
        let logger = logger
        NSWorkspace.shared.openApplication(at: app, configuration: configuration) { _, error in
            if let error { logger.error("launch failed: \(error.localizedDescription, privacy: .public)") }
            done.signal()
        }
        if done.wait(timeout: .now() + Self.launchTimeout) == .timedOut { logger.error("launch did not finish in time") }
    }

    /// `response` as the JSON dictionary Safari hands back to the extension.
    private func dictionary(_ response: IPCResponse) -> [String: Any] {
        guard let data = try? JSONEncoder().encode(response),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return ["type": "error", "code": IPCResponse.ErrorCode.internal, "message": "Cannot encode the reply"]
        }
        return object
    }
}

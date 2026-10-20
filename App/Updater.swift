import AppKit
import Observation
import os
import Sparkle

/// Sparkle updater, started only when `SUPublicEDKey` is a base64 Ed25519 public key (32 bytes); an empty or
/// malformed key would show a misconfiguration alert.
/// Background checks (at launch, then every `SUScheduledCheckInterval`) never pop Sparkle's dialog: a found update
/// sets `updateAvailable`, which turns the status menu's item into "Update Available…" (read each time the menu
/// opens).
@MainActor
@Observable
final class Updater: NSObject {
    private(set) var canCheck = false
    private(set) var updateAvailable = false

    @ObservationIgnored private let logger = Logger(subsystem: "com.math2it.segdown", category: "updater")
    @ObservationIgnored private var controller: SPUStandardUpdaterController!

    override init() {
        super.init()
        controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: self)
    }

    func start() {
        let key = (Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard Data(base64Encoded: key)?.count == 32 else {
            logger.notice("Updater off: SUPublicEDKey is not a base64 32-byte EdDSA public key")
            return
        }
        controller.startUpdater()
        canCheck = true
        if controller.updater.automaticallyChecksForUpdates { controller.updater.checkForUpdatesInBackground() }
    }

    func checkForUpdates() {
        NSApp.activate(ignoringOtherApps: true)
        controller.checkForUpdates(nil)
    }
}

extension Updater: SPUUpdaterDelegate {
    /// Also called when automatic updates download in the background without any dialog.
    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        updateAvailable = true
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        updateAvailable = false
    }

    func updater(_ updater: SPUUpdater, userDidMake choice: SPUUserUpdateChoice, forUpdate updateItem: SUAppcastItem,
                 state: SPUUserUpdateState) {
        if choice == .skip { updateAvailable = false }
    }
}

extension Updater: @preconcurrency SPUStandardUserDriverDelegate {
    var supportsGentleScheduledUpdateReminders: Bool { true }

    /// The status menu item stands in for Sparkle's dialog on background checks.
    func standardUserDriverShouldHandleShowingScheduledUpdate(_ update: SUAppcastItem,
                                                              andInImmediateFocus immediateFocus: Bool) -> Bool {
        false
    }

    /// Required by Sparkle when the delegate shows scheduled updates; `didFindValidUpdate` already set the flag.
    func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem,
                                                   state: SPUUserUpdateState) {}
}

import AppKit
import Observation
import os
import Sparkle

/// Sparkle updater, started only when `SUPublicEDKey` is a base64 Ed25519 public key (32 bytes); an empty or
/// malformed key would show a misconfiguration alert.
/// Background checks (at launch, then every `SUScheduledCheckInterval`) never pop Sparkle's dialog while the status
/// item listens: a found update sets `availableUpdateVersion`, which badges the status item's logo and turns the menus'
/// item into "Update to SegDown <version>…" (read each time a menu opens). They also download the update silently
/// (`SUAutomaticallyUpdate`); once downloaded, `installReady` shows the main window's install button, which installs
/// and relaunches.
@MainActor
@Observable
final class Updater: NSObject {
    /// Version of the update a check found (`displayVersionString`), until it is skipped or its update session ends.
    private(set) var availableUpdateVersion: String? {
        didSet { if availableUpdateVersion != oldValue { onAvailableUpdateChange?() } }
    }
    private(set) var downloading = false
    private(set) var installReady = false
    private var started = false

    /// Off while the updater is off and while an update downloads: Sparkle ignores a check then.
    var canCheck: Bool { started && !downloading }

    /// The title of the menus' update item.
    var menuTitle: String {
        if installReady { return "Install Update and Relaunch" }
        if downloading { return "Downloading Update…" }
        if let availableUpdateVersion { return "Update to SegDown \(availableUpdateVersion)…" }
        return "Check for Updates…"
    }

    /// Called when `availableUpdateVersion` changes; set by the status item.
    @ObservationIgnored var onAvailableUpdateChange: (() -> Void)?

    @ObservationIgnored private let logger = Logger(subsystem: "com.math2it.segdown", category: "updater")
    @ObservationIgnored private var controller: SPUStandardUpdaterController!
    @ObservationIgnored private var installNow: (() -> Void)?

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
        started = true
        if controller.updater.automaticallyChecksForUpdates { controller.updater.checkForUpdatesInBackground() }
    }

    /// Installs a downloaded update instead: Sparkle holds its session for `installNow` and would ignore the check.
    func checkForUpdates() {
        if installReady { return installAndRelaunch() }
        NSApp.activate(ignoringOtherApps: true)
        controller.checkForUpdates(nil)
    }

    /// Installs the downloaded update and relaunches, without any Sparkle UI.
    func installAndRelaunch() { installNow?() }
}

extension Updater: SPUUpdaterDelegate {
    /// Also called when automatic updates download in the background without any dialog.
    /// Also called when Sparkle resumes an update it downloaded but could not install silently (it needs
    /// authorization), so the menus offer it again.
    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        availableUpdateVersion = item.displayVersionString
        downloading = false
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        availableUpdateVersion = nil
        installReady = false
        installNow = nil
    }

    func updater(_ updater: SPUUpdater, willDownloadUpdate item: SUAppcastItem, with request: NSMutableURLRequest) {
        downloading = true
    }

    /// Returning true makes us own the install: the handler installs and relaunches (it may be invoked again if
    /// termination is cancelled, and Sparkle still installs on quit).
    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
                 immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        installNow = immediateInstallHandler
        installReady = true
        downloading = false
        return true
    }

    /// Ends a download that failed or was cancelled, or an install that failed after `installNow` was handed over
    /// (its handler is dead then). Not called while Sparkle holds the session for a live `installNow`.
    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: (any Error)?) {
        downloading = false
        installReady = false
        installNow = nil
    }

    func updater(_ updater: SPUUpdater, userDidMake choice: SPUUserUpdateChoice, forUpdate updateItem: SUAppcastItem,
                 state: SPUUserUpdateState) {
        if choice == .skip {
            availableUpdateVersion = nil
            installReady = false
            installNow = nil
        }
    }
}

extension Updater: @preconcurrency SPUStandardUserDriverDelegate {
    var supportsGentleScheduledUpdateReminders: Bool { true }

    /// The status item's badge stands in for Sparkle's dialog on background checks; without a status item listening,
    /// Sparkle's dialog shows.
    func standardUserDriverShouldHandleShowingScheduledUpdate(_ update: SUAppcastItem,
                                                              andInImmediateFocus immediateFocus: Bool) -> Bool {
        onAvailableUpdateChange == nil
    }

    /// Required by Sparkle when the delegate shows scheduled updates; `didFindValidUpdate` has usually set the version
    /// already.
    func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem,
                                                   state: SPUUserUpdateState) {
        guard !handleShowingUpdate else { return }
        availableUpdateVersion = update.displayVersionString
    }

    /// The badge goes after an install, a skip, "Remind Me Later" or an error. Silent automatic updates have no session
    /// here, so their version stays through the download and `installReady`.
    func standardUserDriverWillFinishUpdateSession() {
        availableUpdateVersion = nil
    }
}

// The app's settings, kept in `settings.json` next to the IPC socket. Every key is optional when
// read, so a hand-edited file or one from an older build still decodes; a new field must follow
// the same `decodeIfPresent` + default rule. The file holds no secrets and is never logged.
import Foundation
import Observation
import os
import SegDownCore

struct AppSettings: Codable, Equatable, Sendable {
    /// Absolute path of the folder that receives one folder per job title (the files themselves
    /// with `flattenOutput`).
    var outputFolder = AppSettings.home + "/Downloads/SegDown"
    var mode: OutputMode = .merged
    /// Applies to every job; the extension no longer chooses it.
    var precision: Precision = .precise
    /// Fall back to the captured media when yt-dlp fails on a supported site.
    var autoFallback = true
    /// Max size of a job in bytes; `nil` = no limit.
    var maxBytes: Int64?
    /// Max total duration of a job's segments in seconds; `nil` = no limit.
    var maxDuration: Double?
    /// Incognito when the extension does not say: no history entry for the job.
    var incognitoDefault = false
    /// Re-encode each finished job's files to make them smaller.
    var compress = false
    /// Save every job's files straight into the output folder, without a folder per title.
    var flattenOutput = false
    /// Name the files and folders in snake_case.
    var snakeCaseNames = false
    /// The extension shows a Full clip button in the overlay.
    var fullClipButton = true
    /// The extension shows a SegDown button on a video player under the pointer.
    var playerButton = true
    /// The extension takes the tallest quality up to this height when the user picks none (one of
    /// `preferredHeights`); `nil` = the best quality.
    var preferredHeight: Int?

    /// The heights Settings offers for `preferredHeight`.
    static let preferredHeights = [360, 480, 720, 1080, 1440, 2160]

    /// The user's real home from the password database, like `IPC.socketURL()`.
    static let home = getpwuid(getuid()).flatMap { $0.pointee.pw_dir.map { String(cString: $0) } }
        ?? NSHomeDirectory()

    var limits: JobLimits {
        JobLimits(maxDuration: maxDuration, maxBytes: maxBytes)
    }

    /// What the extension gets in `pong`.
    var clientSettings: ClientSettings {
        ClientSettings(mode: mode, incognitoDefault: incognitoDefault, maxDuration: maxDuration,
                       fullClipButton: fullClipButton, playerButton: playerButton, preferredHeight: preferredHeight)
    }

    var jobOptions: JobOptions {
        // A blank or relative folder (hand-edited settings) falls back to the default folder.
        let folder = outputFolder.hasPrefix("/") ? outputFolder : AppSettings().outputFolder
        return JobOptions(
            baseDirectory: URL(filePath: folder, directoryHint: .isDirectory).standardizedFileURL,
            maxBytes: maxBytes,
            autoFallback: autoFallback,
            compress: compress,
            flatten: flattenOutput,
            snakeCaseNames: snakeCaseNames
        )
    }

    private enum CodingKeys: String, CodingKey {
        case outputFolder, mode, precision, autoFallback, maxBytes, maxDuration, incognitoDefault, compress
        case flattenOutput, snakeCaseNames, fullClipButton, playerButton, preferredHeight
    }
}

extension AppSettings {
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = AppSettings()
        outputFolder = try c.decodeIfPresent(String.self, forKey: .outputFolder) ?? defaults.outputFolder
        mode = try c.decodeIfPresent(OutputMode.self, forKey: .mode) ?? defaults.mode
        precision = try c.decodeIfPresent(Precision.self, forKey: .precision) ?? defaults.precision
        autoFallback = try c.decodeIfPresent(Bool.self, forKey: .autoFallback) ?? defaults.autoFallback
        maxBytes = try c.decodeIfPresent(Int64.self, forKey: .maxBytes) ?? defaults.maxBytes
        maxDuration = try c.decodeIfPresent(Double.self, forKey: .maxDuration) ?? defaults.maxDuration
        incognitoDefault = try c.decodeIfPresent(Bool.self, forKey: .incognitoDefault) ?? defaults.incognitoDefault
        compress = try c.decodeIfPresent(Bool.self, forKey: .compress) ?? defaults.compress
        flattenOutput = try c.decodeIfPresent(Bool.self, forKey: .flattenOutput) ?? defaults.flattenOutput
        snakeCaseNames = try c.decodeIfPresent(Bool.self, forKey: .snakeCaseNames) ?? defaults.snakeCaseNames
        fullClipButton = try c.decodeIfPresent(Bool.self, forKey: .fullClipButton) ?? defaults.fullClipButton
        playerButton = try c.decodeIfPresent(Bool.self, forKey: .playerButton) ?? defaults.playerButton
        preferredHeight = try c.decodeIfPresent(Int.self, forKey: .preferredHeight) ?? defaults.preferredHeight
    }
}

/// Loads `settings.json` once and saves it on each change. A missing or invalid file gives the
/// defaults; an invalid file is left as is until the next change replaces it.
@MainActor @Observable
final class SettingsStore {
    /// `~/Library/Application Support/SegDown/settings.json`, in the socket's folder.
    static let defaultFileURL = IPC.socketURL().deletingLastPathComponent()
        .appending(path: "settings.json", directoryHint: .notDirectory)

    private(set) var settings = AppSettings()

    let fileURL: URL
    private let logger = Logger(subsystem: "com.math2it.segdown", category: "settings")

    init(fileURL: URL = SettingsStore.defaultFileURL) {
        self.fileURL = fileURL
        if FileManager.default.fileExists(atPath: fileURL.path(percentEncoded: false)) {
            load()
        } else {
            migratePrecision()
        }
    }

    /// Applies `change` and saves when the settings differ.
    func update(_ change: (inout AppSettings) -> Void) {
        var copy = settings
        change(&copy)
        guard copy != settings else { return }
        settings = copy
        save()
    }

    private func load() {
        do {
            settings = try JSONDecoder().decode(AppSettings.self, from: Data(contentsOf: fileURL))
        } catch {
            let code = (error as NSError).code
            logger.error("settings.json unreadable (code \(code, privacy: .public)); using defaults")
        }
    }

    /// One time: the precision the menu bar kept in UserDefaults before `settings.json` existed.
    /// The key is removed only once the file is written, so a failed save retries next launch.
    private func migratePrecision() {
        let key = JobStore.defaultPrecisionKey
        guard let raw = UserDefaults.standard.string(forKey: key) else { return }
        if let precision = Precision(rawValue: raw) {
            settings.precision = precision
        }
        if save() {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    /// Writes atomically into the socket's folder, created 0700 when missing.
    @discardableResult
    private func save() -> Bool {
        do {
            let folder = fileURL.deletingLastPathComponent().path(percentEncoded: false)
            if mkdir(folder, 0o700) != 0, errno != EEXIST {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(settings).write(to: fileURL, options: .atomic)
            return true
        } catch {
            let code = (error as NSError).code
            logger.error("settings.json not saved (code \(code, privacy: .public))")
            return false
        }
    }
}

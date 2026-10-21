// The copy of the Chromium extension that the user loads unpacked once. The app carries the extension in
// its bundle and refreshes this copy when the versions differ, so an app update also updates the
// extension (which reloads itself when the app's version differs from its own).
import Foundation

public enum ExtensionFolder {
    /// `~/Library/Application Support/SegDown/Chrome Extension`, next to the socket.
    public static func chromeURL() -> URL {
        IPC.socketURL().deletingLastPathComponent()
            .appending(path: "Chrome Extension", directoryHint: .isDirectory)
    }

    /// Copies `source` to `target` when `target` has no manifest or another `version`. The copy goes to a
    /// hidden sibling first and then replaces `target`, so a browser never reads half a folder. The parent
    /// folder is created 0700 when missing. -> true when it copied.
    @discardableResult
    public static func sync(from source: URL, to target: URL) throws -> Bool {
        guard let version = version(at: source) else { throw CocoaError(.fileReadCorruptFile) }
        if version == self.version(at: target) { return false }
        let fm = FileManager.default
        let parent = target.deletingLastPathComponent()
        if mkdir(parent.path(percentEncoded: false), 0o700) != 0, errno != EEXIST {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let temp = parent.appending(path: ".\(target.lastPathComponent)-\(UUID().uuidString)", directoryHint: .isDirectory)
        do {
            try fm.copyItem(at: source, to: temp)
            if fm.fileExists(atPath: target.path(percentEncoded: false)) {
                _ = try fm.replaceItemAt(target, withItemAt: temp)
            } else {
                try fm.moveItem(at: temp, to: target)
            }
        } catch {
            try? fm.removeItem(at: temp)
            throw error
        }
        return true
    }

    /// The `version` in the folder's `manifest.json`, or nil.
    static func version(at folder: URL) -> String? {
        guard let data = try? Data(contentsOf: folder.appending(path: "manifest.json")),
              let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return manifest["version"] as? String
    }
}

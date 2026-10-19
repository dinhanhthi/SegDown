// Locates the Homebrew tools SegDown runs by absolute path. The app may be launched by the GUI
// or by Chrome's native-messaging host, so the inherited PATH cannot be trusted to contain Homebrew.
import Foundation

/// An external tool SegDown runs. The raw value is the executable name.
public enum Tool: String, CaseIterable, Codable, Sendable, Hashable {
    case ytDlp = "yt-dlp"
    case ffmpeg
    case ffprobe
    case deno
}

public struct Binaries: Sendable {
    public static let defaultSearchDirectories = ["/opt/homebrew/bin", "/usr/local/bin"]
    public static let childPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

    /// Directories searched in order; the first executable match wins.
    public let searchDirectories: [String]

    public init(searchDirectories: [String] = Binaries.defaultSearchDirectories) {
        self.searchDirectories = searchDirectories
    }

    /// The absolute URL of `tool`, or nil when it is not installed in any search directory.
    public func url(for tool: Tool) -> URL? {
        let fileManager = FileManager.default
        for directory in searchDirectories {
            let path = (directory as NSString).appendingPathComponent(tool.rawValue)
            var isDirectory: ObjCBool = false
            if fileManager.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue,
               fileManager.isExecutableFile(atPath: path) {
                return URL(fileURLWithPath: path)
            }
        }
        return nil
    }

    /// The tools not found in any search directory, in `Tool.allCases` order.
    public func missing() -> [Tool] {
        Tool.allCases.filter { url(for: $0) == nil }
    }

    /// The current process environment with PATH replaced, so yt-dlp finds ffmpeg and deno.
    public static func childEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = childPath
        return environment
    }
}

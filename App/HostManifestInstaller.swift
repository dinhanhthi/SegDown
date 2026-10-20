// Writes the Chromium native messaging host manifest (`com.math2it.segdown.json`) into every
// installed Chromium browser, and reports per browser whether it is installed and still points at
// the running bundle. A browser counts as installed when its folder under
// `~/Library/Application Support/` exists; only its `NativeMessagingHosts` subfolder is created.
import Foundation
import SegDownCore

enum HostManifestInstaller {
    static let hostName = "com.math2it.segdown"

    /// The manifest Chrome reads to find and authorize `segdown-host`.
    struct Manifest: Codable, Equatable {
        var name: String
        var description: String
        var path: String
        var type: String
        var allowedOrigins: [String]

        enum CodingKeys: String, CodingKey {
            case name, description, path, type
            case allowedOrigins = "allowed_origins"
        }
    }

    /// One supported browser and the state of its manifest.
    struct Status: Identifiable {
        let browser: String
        /// The browser's bundle id, the key of `JobStore.lastConnected`.
        let bundleID: String
        let manifestPath: String
        /// A manifest file exists in the browser's `NativeMessagingHosts` folder.
        let installed: Bool
        /// The existing manifest is unreadable, or its `path` or `allowed_origins` differ from the
        /// running bundle's (e.g. the app moved since it was installed).
        let stale: Bool

        var id: String { browser }
    }

    /// Browser name, bundle id and its `NativeMessagingHosts` folder, relative to `~/Library/Application Support`.
    private static let browsers: [(name: String, bundleID: String, hostsDir: String)] = [
        ("Chrome", "com.google.Chrome", "Google/Chrome/NativeMessagingHosts"),
        ("Chromium", "org.chromium.Chromium", "Chromium/NativeMessagingHosts"),
        ("Brave", "com.brave.Browser", "BraveSoftware/Brave-Browser/NativeMessagingHosts"),
        ("Edge", "com.microsoft.edgemac", "Microsoft Edge/NativeMessagingHosts"),
        ("Arc", "company.thebrowser.Browser", "Arc/User Data/NativeMessagingHosts"),
    ]

    /// Absolute path of the host executable inside the running bundle.
    static var hostPath: String {
        Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/segdown-host").path
    }

    static var currentManifest: Manifest {
        Manifest(
            name: hostName,
            description: "SegDown native host",
            path: hostPath,
            type: "stdio",
            allowedOrigins: [ExtensionID.chromeOrigin]
        )
    }

    /// Writes the manifest atomically for every browser whose folder exists. Returns those browsers' names.
    @discardableResult
    static func install() throws -> [String] {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(currentManifest)
        var written: [String] = []
        for browser in browsers {
            let hostsDir = supportDirectory.appendingPathComponent(browser.hostsDir, isDirectory: true)
            guard isDirectory(hostsDir.deletingLastPathComponent()) else { continue }
            try FileManager.default.createDirectory(at: hostsDir, withIntermediateDirectories: true)
            let file = manifestURL(in: hostsDir)
            try data.write(to: file, options: .atomic)
            written.append(browser.name)
        }
        return written
    }

    /// The state of the manifest for every supported browser.
    static func status() -> [Status] {
        let expected = currentManifest
        return browsers.map { browser in
            let file = manifestURL(
                in: supportDirectory.appendingPathComponent(browser.hostsDir, isDirectory: true)
            )
            guard let data = FileManager.default.contents(atPath: file.path) else {
                return Status(browser: browser.name, bundleID: browser.bundleID, manifestPath: file.path,
                              installed: false, stale: false)
            }
            let manifest = try? JSONDecoder().decode(Manifest.self, from: data)
            let stale = manifest.map {
                $0.path != expected.path || $0.allowedOrigins != expected.allowedOrigins
            } ?? true
            return Status(browser: browser.name, bundleID: browser.bundleID, manifestPath: file.path,
                          installed: true, stale: stale)
        }
    }

    private static var supportDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)
    }

    private static func manifestURL(in hostsDir: URL) -> URL {
        hostsDir.appendingPathComponent("\(hostName).json")
    }

    private static func isDirectory(_ url: URL) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue
    }
}

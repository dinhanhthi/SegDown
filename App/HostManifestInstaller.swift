// Writes the native messaging host manifest (`com.math2it.segdown.json`) into every installed Chromium
// browser and Firefox, and reports per browser whether it is installed and still points at the running
// bundle. A browser counts as installed when its folder under `~/Library/Application Support/` exists;
// only its `NativeMessagingHosts` folder is created (for Firefox, `Mozilla/NativeMessagingHosts`).
import Foundation
import SegDownCore

enum HostManifestInstaller {
    static let hostName = "com.math2it.segdown"
    static let firefoxBundleID = "org.mozilla.firefox"

    /// The manifest the browser reads to find and authorize `segdown-host`: Chromium lists
    /// `allowed_origins`, Firefox `allowed_extensions`.
    struct Manifest: Codable, Equatable {
        var name: String
        var description: String
        var path: String
        var type: String
        var allowedOrigins: [String]?
        var allowedExtensions: [String]?

        enum CodingKeys: String, CodingKey {
            case name, description, path, type
            case allowedOrigins = "allowed_origins"
            case allowedExtensions = "allowed_extensions"
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
        /// The existing manifest is unreadable, or its `path` or allowed callers differ from the
        /// running bundle's (e.g. the app moved since it was installed).
        let stale: Bool
        /// The app whose host the manifest points to, when it is not the running bundle (the app moved, or another
        /// copy such as a Debug build is running).
        let otherApp: String?

        var id: String { browser }
    }

    /// Browser name, bundle id, its `NativeMessagingHosts` folder and the folder that exists once the browser
    /// has run, relative to `~/Library/Application Support`.
    private static let browsers: [(name: String, bundleID: String, hostsDir: String, presenceDir: String)] = [
        ("Chrome", "com.google.Chrome", "Google/Chrome/NativeMessagingHosts", "Google/Chrome"),
        ("Chromium", "org.chromium.Chromium", "Chromium/NativeMessagingHosts", "Chromium"),
        ("Brave", "com.brave.Browser", "BraveSoftware/Brave-Browser/NativeMessagingHosts", "BraveSoftware/Brave-Browser"),
        ("Edge", "com.microsoft.edgemac", "Microsoft Edge/NativeMessagingHosts", "Microsoft Edge"),
        ("Arc", "company.thebrowser.Browser", "Arc/User Data/NativeMessagingHosts", "Arc/User Data"),
        ("Firefox", firefoxBundleID, "Mozilla/NativeMessagingHosts", "Firefox"),
    ]

    /// Absolute path of the host executable inside the running bundle.
    static var hostPath: String {
        Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/segdown-host").path
    }

    /// The manifest the browser with `bundleID` should have.
    static func currentManifest(for bundleID: String) -> Manifest {
        let firefox = bundleID == firefoxBundleID
        return Manifest(
            name: hostName,
            description: "SegDown native host",
            path: hostPath,
            type: "stdio",
            allowedOrigins: firefox ? nil : [ExtensionID.chromeOrigin],
            allowedExtensions: firefox ? [ExtensionID.firefox] : nil
        )
    }

    /// Writes the manifest atomically for every browser whose folder exists, and for `forcing` (a bundle id) even
    /// when it has not run yet. Returns those browsers' names.
    @discardableResult
    static func install(forcing: String? = nil) throws -> [String] {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        var written: [String] = []
        for browser in browsers {
            guard browser.bundleID == forcing
                || isDirectory(supportDirectory.appendingPathComponent(browser.presenceDir, isDirectory: true))
            else { continue }
            let hostsDir = supportDirectory.appendingPathComponent(browser.hostsDir, isDirectory: true)
            try FileManager.default.createDirectory(at: hostsDir, withIntermediateDirectories: true)
            let data = try encoder.encode(currentManifest(for: browser.bundleID))
            try data.write(to: manifestURL(in: hostsDir), options: .atomic)
            written.append(browser.name)
        }
        return written
    }

    /// The state of the manifest for every supported browser.
    static func status() -> [Status] {
        browsers.map { browser in
            let file = manifestURL(
                in: supportDirectory.appendingPathComponent(browser.hostsDir, isDirectory: true)
            )
            guard let data = FileManager.default.contents(atPath: file.path) else {
                return Status(browser: browser.name, bundleID: browser.bundleID, manifestPath: file.path,
                              installed: false, stale: false, otherApp: nil)
            }
            let expected = currentManifest(for: browser.bundleID)
            let manifest = try? JSONDecoder().decode(Manifest.self, from: data)
            let stale = manifest.map {
                $0.path != expected.path || $0.allowedOrigins != expected.allowedOrigins
                    || $0.allowedExtensions != expected.allowedExtensions
            } ?? true
            let otherApp = manifest.flatMap { $0.path == expected.path ? nil : appPath(ofHost: $0.path) }
            return Status(browser: browser.name, bundleID: browser.bundleID, manifestPath: file.path,
                          installed: true, stale: stale, otherApp: otherApp)
        }
    }

    /// "/Applications/SegDown.app/Contents/MacOS/segdown-host" -> "/Applications/SegDown.app"; any other path as is.
    private static func appPath(ofHost path: String) -> String {
        let suffix = "/Contents/MacOS/segdown-host"
        return path.hasSuffix(suffix) ? String(path.dropLast(suffix.count)) : path
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

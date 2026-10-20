// Names the browser behind an IPC connection, for the "Last connected" display only. Any process
// of the same user can make itself look like a browser here, so the result never gates anything.
// The procedure was verified in spike 1.1: Safari connects through this app's own Safari extension,
// Chromium browsers through this app's own `segdown-host`, started by the browser.
import AppKit
import Darwin

enum BrowserIdentity {
    /// Parent hops tried above `segdown-host` before giving up.
    static let maxHops = 8

    private static let safariExtensionPath = resolved(
        Bundle.main.bundleURL.appending(path: "Contents/PlugIns/SegDownSafari.appex/Contents/MacOS/SegDownSafari")
    )
    private static let hostPath = resolved(Bundle.main.bundleURL.appending(path: "Contents/MacOS/segdown-host"))

    /// The bundle id of the browser behind the peer of the connected socket `fd`, or nil.
    static func bundleID(forPeerOf fd: Int32) -> String? {
        var pid: pid_t = 0
        var length = socklen_t(MemoryLayout<pid_t>.size)
        guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0, pid > 0,
              let path = executablePath(of: pid) else { return nil }
        switch resolved(URL(filePath: path)) {
        case safariExtensionPath:
            return "com.apple.Safari"
        case hostPath:
            return ancestorBundleID(above: pid)
        default:
            return nil
        }
    }

    /// The first ancestor of `pid` that is an app with a bundle id. Never compares paths: Chrome
    /// runs from a `code_sign_clone` copy.
    private static func ancestorBundleID(above pid: pid_t) -> String? {
        var current = parent(of: pid)
        for _ in 0..<maxHops {
            guard let candidate = current, candidate > 1 else { return nil }
            if let id = NSRunningApplication(processIdentifier: candidate)?.bundleIdentifier {
                return id
            }
            current = parent(of: candidate)
        }
        return nil
    }

    private static func parent(of pid: pid_t) -> pid_t? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return pid_t(info.pbi_ppid)
    }

    private static func executablePath(of pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        return String(cString: buffer)
    }

    private static func resolved(_ url: URL) -> String {
        url.resolvingSymlinksInPath().standardizedFileURL.path(percentEncoded: false)
    }
}

// Turns what the user types or pastes into the ignored sites list into a bare lowercase hostname.
// The browser extension's hub matches it against the top page's hostname (exact or subdomain).
import Foundation

public enum IgnoredDomain {
    public static let maxLength = 253

    /// Returns the hostname of `input` (a domain or a pasted URL), lowercased, without port, path or
    /// leading/trailing dots; `nil` when that is not an ASCII hostname. `www.` is kept.
    public static func normalize(_ input: String) -> String? {
        var host = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if host.contains("://") {
            guard let urlHost = URLComponents(string: host)?.host else { return nil }
            host = urlHost
        } else {
            if let end = host.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) {
                host = String(host[..<end])
            }
            if let colon = host.firstIndex(of: ":"),
               host[host.index(after: colon)...].allSatisfy({ ("0"..."9").contains($0) }) {
                host = String(host[..<colon])
            }
        }
        while host.hasPrefix(".") { host.removeFirst() }
        while host.hasSuffix(".") { host.removeLast() }
        guard (1...maxLength).contains(host.count),
              host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy(isLabel)
        else { return nil }
        return host
    }

    private static func isLabel(_ label: Substring) -> Bool {
        (1...63).contains(label.count)
            && label.first != "-" && label.last != "-"
            && label.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
    }
}

// Spots tab titles that are only the site name ("Facebook") and cleans the title yt-dlp reports
// for the page. Both inputs are untrusted page data; the result still goes through PathSanitizer.
import Foundation

public enum PageTitle {
    /// Separators left at the ends of a cleaned title, or doubled where a URL was removed.
    static let separators: Set<String> = ["|", "·", "-", "–", "—"]

    /// True when `title`, after trimming and dropping a leading notification counter like `(3) `,
    /// is empty or only the site name: its lowercase alphanumerics equal the host without `www.`
    /// (`facebookcom`) or the host's second-level label (`facebook`).
    public static func isGeneric(_ title: String, pageURL: URL) -> Bool {
        var rest = Substring(title.trimmingCharacters(in: .whitespacesAndNewlines))
        if let counter = rest.prefixMatch(of: #/\(\d+\+?\)\s*/#) {
            rest = rest[counter.range.upperBound...]
        }
        let name = alphanumerics(rest)
        guard !name.isEmpty else { return true }
        guard var host = pageURL.host?.lowercased(), !host.isEmpty else { return false }
        if host.hasPrefix("www.") { host.removeFirst(4) }
        let labels = host.split(separator: ".")
        let secondLevel = labels.count >= 2 ? alphanumerics(labels[labels.count - 2]) : ""
        return name == alphanumerics(host) || (!secondLevel.isEmpty && name == secondLevel)
    }

    /// yt-dlp's `title` without a leading Facebook `120K views · 1.9K reactions |` block and URL
    /// tokens, whitespace collapsed, end separators trimmed, capped at `Validation.maxTitleLength`
    /// characters. Nil when nothing is left.
    public static func clean(_ title: String) -> String? {
        var text = Substring(title.trimmingCharacters(in: .whitespacesAndNewlines))
        if let block = text.prefixMatch(
            of: #/[\d.,]+\s*[KMB]?\s+views?\s*·\s*[\d.,]+\s*[KMB]?\s+reactions?\s*\|\s*/#.ignoresCase()
        ) {
            text = text[block.range.upperBound...]
        }
        var tokens: [Substring] = []
        for token in text.split(whereSeparator: \.isWhitespace) {
            let lower = token.lowercased()
            guard !lower.contains("://"), !lower.hasPrefix("www.") else { continue }
            if let last = tokens.last, separators.contains(String(last)), separators.contains(String(token)) {
                continue
            }
            tokens.append(token)
        }
        let trimSet = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: separators.joined()))
        let joined = tokens.joined(separator: " ").trimmingCharacters(in: trimSet)
        let capped = String(joined.prefix(Validation.maxTitleLength)).trimmingCharacters(in: .whitespacesAndNewlines)
        return capped.isEmpty ? nil : capped
    }

    /// Lowercase letters and digits of `text`, everything else dropped.
    private static func alphanumerics(_ text: some StringProtocol) -> String {
        String(String.UnicodeScalarView(text.lowercased().unicodeScalars.filter(CharacterSet.alphanumerics.contains)))
    }
}

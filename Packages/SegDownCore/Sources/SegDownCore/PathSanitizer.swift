// Turns the untrusted page title into exactly one safe path component and builds the output
// paths under ~/Downloads/SegDown/<title>/. Nothing here ever lets a title escape the base dir.
import Foundation

public enum PathSanitizer {
    public static let maxTitleLength = 120
    /// APFS limits a name to 255 UTF-8 bytes; this leaves room for the segment/merged suffix and " (n)".
    public static let maxTitleBytes = 200

    /// `~/Downloads/SegDown`.
    public static var defaultBaseDirectory: URL {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads", isDirectory: true)
        return downloads.appendingPathComponent("SegDown", isDirectory: true)
    }

    /// Returns `title` as a single path component, or `segdown-<yyyy-MM-dd-HHmmss>` when nothing is left.
    /// With `snakeCase`, both go through `snakeCase(_:)`.
    public static func sanitize(_ title: String, now: Date = Date(), snakeCase: Bool = false) -> String {
        var name = String(String.UnicodeScalarView(title.unicodeScalars.filter { scalar in
            scalar != "/" && scalar != ":" && scalar != "\\" && !CharacterSet.controlCharacters.contains(scalar)
        }))
        while name.contains("..") {
            name = name.replacingOccurrences(of: "..", with: ".")
        }
        name = trimmed(name)
        if snakeCase {
            name = Self.snakeCase(name)
        }
        if name.count > maxTitleLength {
            name = String(name.prefix(maxTitleLength))
        }
        while name.utf8.count > maxTitleBytes {
            name.removeLast()
        }
        // Again with `snakeCase`, so the cut cannot leave a trailing `_`.
        name = snakeCase ? Self.snakeCase(name) : trimmed(name)
        guard name.isEmpty else { return name }
        return snakeCase ? Self.snakeCase(fallbackName(now: now)) : fallbackName(now: now)
    }

    /// `text` in snake_case: folded to ASCII (`Học Đà` → `Hoc Da`), lowercased, each run of other
    /// characters (spaces, punctuation, CJK, emoji…) turned into one `_`, no `_` at either end.
    /// Empty when no ASCII letter or digit is left.
    public static func snakeCase(_ text: String) -> String {
        let ascii = text.applyingTransform(StringTransform("Latin-ASCII"), reverse: false) ?? text
        var words: [String] = []
        var word = ""
        for scalar in ascii.lowercased().unicodeScalars {
            if scalar.isASCII, CharacterSet.alphanumerics.contains(scalar) {
                word.unicodeScalars.append(scalar)
            } else if !word.isEmpty {
                words.append(word)
                word = ""
            }
        }
        if !word.isEmpty { words.append(word) }
        return words.joined(separator: "_")
    }

    /// `segdown-<yyyy-MM-dd-HHmmss>` in the local time zone, independent of the user's locale.
    public static func fallbackName(now: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone.current
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        return "segdown-" + formatter.string(from: now)
    }

    /// `<base>/<sanitized title>/`. Throws if the result is not a direct child of `base`.
    public static func outputDirectory(
        title: String,
        base: URL = PathSanitizer.defaultBaseDirectory,
        now: Date = Date(),
        snakeCase: Bool = false
    ) throws -> URL {
        let standardBase = base.standardizedFileURL
        let directory = standardBase
            .appendingPathComponent(sanitize(title, now: now, snakeCase: snakeCase), isDirectory: true)
            .standardizedFileURL
        guard directory.deletingLastPathComponent().standardizedFileURL.path == standardBase.path else {
            throw JobError.invalid("Output directory escapes \(standardBase.path)")
        }
        return directory
    }

    /// `<title> - 01 [0h01m05s-0h01m30s].mp4`, or `<title>_01_0h01m05s_0h01m30s.mp4` with `snakeCase`.
    /// `index` is 1-based; `title` must already be sanitized.
    public static func segmentFileName(title: String, index: Int, segment: Segment, snakeCase: Bool = false) -> String {
        let number = index < 10 ? "0\(index)" : "\(index)"
        let start = timestamp(segment.start), end = timestamp(segment.end)
        return snakeCase ? "\(title)_\(number)_\(start)_\(end).mp4" : "\(title) - \(number) [\(start)-\(end)].mp4"
    }

    /// `<title> - merged.mp4`, or `<title>_merged.mp4` with `snakeCase`. `title` must already be sanitized.
    public static func mergedFileName(title: String, snakeCase: Bool = false) -> String {
        snakeCase ? "\(title)_merged.mp4" : "\(title) - merged.mp4"
    }

    /// `directory/fileName`, or `directory/<name> (2).<ext>`, ` (3)`… (`_2`, `_3`… with `snakeCase`)
    /// when that file already exists.
    public static func uniqueFileURL(in directory: URL, fileName: String, snakeCase: Bool = false) -> URL {
        let fileManager = FileManager.default
        var candidate = directory.appendingPathComponent(fileName, isDirectory: false)
        let stem = (fileName as NSString).deletingPathExtension
        let ext = (fileName as NSString).pathExtension
        var counter = 2
        while fileManager.fileExists(atPath: candidate.path) {
            let suffix = snakeCase ? "_\(counter)" : " (\(counter))"
            let numbered = ext.isEmpty ? stem + suffix : "\(stem)\(suffix).\(ext)"
            candidate = directory.appendingPathComponent(numbered, isDirectory: false)
            counter += 1
        }
        return candidate
    }

    /// Whole seconds (floored) as `<h>h<mm>m<ss>s`, e.g. `0h01m05s`. Huge values are capped so the
    /// `Int` conversion cannot trap.
    static func timestamp(_ seconds: Double) -> String {
        let total = seconds.isFinite && seconds > 0 ? Int(min(seconds, 9e15).rounded(.down)) : 0
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        return "\(hours)h\(twoDigits(minutes))m\(twoDigits(secs))s"
    }

    private static func twoDigits(_ value: Int) -> String {
        value < 10 ? "0\(value)" : "\(value)"
    }

    private static func trimmed(_ name: String) -> String {
        var result = Substring(name)
        while let first = result.first, first == "." || first.isWhitespace {
            result.removeFirst()
        }
        while let last = result.last, last.isWhitespace {
            result.removeLast()
        }
        return String(result)
    }
}

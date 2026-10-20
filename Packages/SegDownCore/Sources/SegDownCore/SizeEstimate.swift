// Size of a job: the bytes counted in its temp dir while it runs (shown and capped), and an
// estimate before it starts. Remote responses are untrusted: only a few headers are read, never
// the body, and messages never contain URLs.
import Foundation

enum SizeEstimate {
    // MARK: Counted bytes

    /// The names among `names` (one temp dir listing) that count toward a job's size. Skipped:
    /// the merge output (`merged.mp4`, `list.txt`), yt-dlp's merge temp `part-NNN.temp.*`, and
    /// yt-dlp's intermediates (`part-NNN.fNNN.*`, `.part`, `.ytdl`…) once the final
    /// `part-NNN.<ext>` of the same part exists. So each part counts once at every moment: its
    /// intermediates while yt-dlp downloads and merges them, then the final file. Other names count.
    static func countedFileNames(_ names: [String]) -> [String] {
        let finished = Set(names.compactMap { name in
            partName(name).flatMap { isFinal($0.rest) ? $0.stem : nil }
        })
        return names.filter { name in
            if name == JobRunner.mergeListName || name == JobRunner.mergeOutputName { return false }
            guard let (stem, rest) = partName(name) else { return true }
            if rest.hasPrefix("temp.") { return false }
            return isFinal(rest) || !finished.contains(stem)
        }
    }

    /// Sum of the logical sizes (`st_size`, never allocated blocks) of the counted regular files
    /// directly inside `directory`. Files that vanish while it is listed count as 0.
    static func countedBytes(in directory: URL) -> Int64 {
        let keys: [URLResourceKey] = [.fileSizeKey, .isRegularFileKey]
        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: keys
        ) else { return 0 }
        let counted = Set(countedFileNames(urls.map(\.lastPathComponent)))
        return urls.reduce(0) { sum, url in
            guard counted.contains(url.lastPathComponent),
                  let values = try? url.resourceValues(forKeys: Set(keys)),
                  values.isRegularFile == true, let size = values.fileSize else { return sum }
            return sum + Int64(size)
        }
    }

    /// `("part-001", "f137.mp4")` for `part-001.f137.mp4`; nil for names not shaped `part-<digits>.<rest>`.
    private static func partName(_ name: String) -> (stem: Substring, rest: Substring)? {
        guard name.hasPrefix("part-"), let dot = name.firstIndex(of: ".") else { return nil }
        let digits = name[name.index(name.startIndex, offsetBy: 5)..<dot]
        let rest = name[name.index(after: dot)...]
        guard !digits.isEmpty, digits.allSatisfy({ $0.isASCII && $0.isNumber }), !rest.isEmpty else { return nil }
        return (name[..<dot], rest)
    }

    /// True when `rest` is a lone extension (`mp4`), as in `collectPageParts`.
    private static func isFinal(_ rest: Substring) -> Bool {
        !rest.contains(".") && rest != "part" && rest != "ytdl" && rest != "temp"
    }

    // MARK: Estimate

    /// The expected size of a media `request`, or nil when it cannot be estimated (page source,
    /// failed request, no size header, no `mediaDuration` for mp4, playlist without `BANDWIDTH`).
    /// HLS: the chosen variant's `BANDWIDTH` / 8 × total segment duration. mp4: the file's total
    /// size × total segment duration / `mediaDuration`. Expects a validated request.
    static func estimate(_ request: JobRequest, session: URLSession = .shared) async -> Int64? {
        guard case let .media(url, kind, headers, variantURL, _) = request.source else { return nil }
        let duration = request.segments.reduce(0) { $0 + ($1.end - $1.start) }
        switch kind {
        case .hls:
            guard let playlist = try? await HLSPlaylist.fetch(url, headers: headers, session: session),
                  let selection = playlist.pickVariant(preferred: variantURL),
                  variantURL == nil || selection.variant.url.absoluteString == variantURL?.absoluteString,
                  selection.variant.bandwidth > 0 else { return nil }
            return bytes(Double(selection.variant.bandwidth) / 8 * duration)
        case .mp4:
            guard let mediaDuration = request.mediaDuration, mediaDuration > 0 else { return nil }
            let target = variantURL ?? url
            // The captured headers belong to the source's origin; another origin gets none.
            let scoped = RedirectGuard.sameOrigin(target, url) ? headers : [:]
            guard let total = await totalSize(target, headers: scoped, session: session) else { return nil }
            return bytes(Double(total) * min(duration, mediaDuration) / mediaDuration)
        }
    }

    /// The file size of `url`: a `GET` of `bytes=0-0` (total from `Content-Range`, or the
    /// `Content-Length` of a server that ignores the range), else a `HEAD` (presigned GET-only URLs
    /// often refuse `HEAD`). The body is never read. Redirects go through `RedirectGuard`.
    private static func totalSize(_ url: URL, headers: [String: String], session: URLSession) async -> Int64? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        var ranged = RedirectGuard.request(url, headers: headers)
        ranged.setValue("bytes=0-0", forHTTPHeaderField: "Range")
        if let (body, response) = try? await session.bytes(for: ranged, delegate: RedirectGuard(original: url)) {
            body.task.cancel()
            if let http = response as? HTTPURLResponse {
                if http.statusCode == 206, let total = contentRangeTotal(http.value(forHTTPHeaderField: "Content-Range")) {
                    return total
                }
                if http.statusCode == 200, http.expectedContentLength > 0 {
                    return http.expectedContentLength
                }
            }
        }
        var head = RedirectGuard.request(url, headers: headers)
        head.httpMethod = "HEAD"
        guard let (_, response) = try? await session.data(for: head, delegate: RedirectGuard(original: url)),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              http.expectedContentLength > 0 else { return nil }
        return http.expectedContentLength
    }

    /// `12345` from `bytes 0-0/12345`; nil for `*` or anything malformed.
    private static func contentRangeTotal(_ value: String?) -> Int64? {
        guard let value, let slash = value.lastIndex(of: "/"),
              let total = Int64(value[value.index(after: slash)...].trimmingCharacters(in: .whitespaces)),
              total > 0 else { return nil }
        return total
    }

    private static func bytes(_ value: Double) -> Int64? {
        guard value.isFinite, value > 0 else { return nil }
        return Int64(min(value, 9e18).rounded(.up))
    }

    // MARK: Format

    /// `950 bytes`, `1.2 MB`, `3 GB`: decimal units (1 KB = 1000 bytes, as Finder) with at most
    /// one decimal, integer math only, so the output never depends on the locale. `roundUp` rounds
    /// the last digit up (a measured size) or down (a limit), so the two never print the same.
    static func format(_ bytes: Int64, roundUp: Bool) -> String {
        let value = min(max(bytes, 0), Int64.max / 100)
        let units = ["KB", "MB", "GB", "TB"]
        guard value >= 1000 else { return "\(value) bytes" }
        var divisor: Int64 = 1000
        var unit = 0
        while unit < units.count - 1, value / divisor >= 1000 {
            divisor *= 1000
            unit += 1
        }
        let tenths = roundUp ? (value * 10 + divisor - 1) / divisor : value * 10 / divisor
        let number = tenths % 10 == 0 ? "\(tenths / 10)" : "\(tenths / 10).\(tenths % 10)"
        return "\(number) \(units[unit])"
    }
}

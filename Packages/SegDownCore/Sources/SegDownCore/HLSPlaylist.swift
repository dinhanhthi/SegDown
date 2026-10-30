// Fetches and parses HLS playlists so a master playlist is never handed to ffmpeg (which would
// probe every variant). Playlist text is untrusted data: it is only parsed, never interpreted, and
// any variant, audio or segment URI that does not resolve to http(s) is dropped.
import Foundation

/// A video resolution parsed from `RESOLUTION=<width>x<height>`.
public struct HLSResolution: Codable, Sendable, Hashable {
    public var width: Int
    public var height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }
}

/// One `EXT-X-STREAM-INF` entry of a master playlist. `url` is absolute and http(s).
public struct HLSVariant: Codable, Sendable, Hashable {
    public var url: URL
    public var bandwidth: Int
    public var resolution: HLSResolution?
    /// The `AUDIO` group ID, when the variant uses separate audio renditions.
    public var audioGroup: String?

    public init(url: URL, bandwidth: Int, resolution: HLSResolution? = nil, audioGroup: String? = nil) {
        self.url = url
        self.bandwidth = bandwidth
        self.resolution = resolution
        self.audioGroup = audioGroup
    }
}

/// One `EXT-X-MEDIA:TYPE=AUDIO` entry. `url` is nil when the audio is muxed into the variant.
public struct HLSAudioRendition: Codable, Sendable, Hashable {
    public var groupID: String
    public var name: String?
    public var isDefault: Bool
    public var url: URL?

    public init(groupID: String, name: String? = nil, isDefault: Bool = false, url: URL? = nil) {
        self.groupID = groupID
        self.name = name
        self.isDefault = isDefault
        self.url = url
    }
}

/// One media segment of a media playlist: its URI (absolute, http(s)) and `EXTINF` duration in seconds.
public struct HLSMediaSegment: Codable, Sendable, Hashable {
    public var url: URL
    public var duration: Double

    public init(url: URL, duration: Double) {
        self.url = url
        self.duration = duration
    }
}

/// The variant to download plus its separate audio rendition, if any.
public struct HLSSelection: Sendable, Hashable {
    public var variant: HLSVariant
    public var audioURL: URL?

    public init(variant: HLSVariant, audioURL: URL? = nil) {
        self.variant = variant
        self.audioURL = audioURL
    }
}

public struct HLSPlaylist: Sendable, Hashable {
    /// Playlists larger than this are rejected; real masters are a few KB.
    public static let maxPlaylistBytes = 4 * 1024 * 1024

    /// True when the playlist has at least one `EXT-X-STREAM-INF` tag.
    public var isMaster: Bool
    public var variants: [HLSVariant]
    public var audioRenditions: [HLSAudioRendition]
    /// The segments of a media playlist, in order. Empty for a master.
    public var segments: [HLSMediaSegment]
    /// False when the playlist has an `EXT-X-KEY` (METHOD other than NONE), `EXT-X-MAP` or
    /// `EXT-X-BYTERANGE` tag: its segments are then never treated as disguised (`DisguisedHLS`).
    public var isPlain: Bool

    public init(
        isMaster: Bool, variants: [HLSVariant] = [], audioRenditions: [HLSAudioRendition] = [],
        segments: [HLSMediaSegment] = [], isPlain: Bool = true
    ) {
        self.isMaster = isMaster
        self.variants = variants
        self.audioRenditions = audioRenditions
        self.segments = segments
        self.isPlain = isPlain
    }

    // MARK: Fetch

    /// Fetches `url` with the captured headers and parses it. The caller must have run
    /// `Validation.validate` on the source first (http(s) URL, allowlisted headers).
    public static func fetch(
        _ url: URL,
        headers: [String: String],
        session: URLSession = .shared
    ) async throws -> HLSPlaylist {
        let request = RedirectGuard.request(url, headers: headers)
        let (bytes, response) = try await session.bytes(for: request, delegate: RedirectGuard(original: url))
        guard let http = response as? HTTPURLResponse else {
            throw JobError.processFailed("Playlist response is not HTTP")
        }
        switch http.statusCode {
        case 200..<300: break
        case 403, 410: throw JobError.linkExpired
        default: throw JobError.processFailed("Playlist request failed with HTTP \(http.statusCode)")
        }
        guard http.expectedContentLength <= Int64(maxPlaylistBytes) else {
            throw JobError.invalid("Playlist is larger than \(maxPlaylistBytes) bytes")
        }

        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            if data.count > maxPlaylistBytes {
                throw JobError.invalid("Playlist is larger than \(maxPlaylistBytes) bytes")
            }
        }
        guard let text = String(data: data, encoding: .utf8) else {
            throw JobError.invalid("Playlist is not UTF-8 text")
        }
        // Relative URIs resolve against the final URL, as ffmpeg does after a redirect.
        return try parse(text, baseURL: http.url ?? url)
    }

    // MARK: Parse

    /// Thrown for a media playlist whose segment list the site encrypted (an `#ENC-` tag, no
    /// segments): only the site's own player can read it, and ffmpeg would fail with "End of file".
    public static let encryptedError = JobError.invalid("This site encrypts its playlist, SegDown can't download it")

    /// Parses playlist text. Relative URIs resolve against `baseURL`; non-http(s) URIs are dropped.
    /// Throws when the text does not start with `#EXTM3U`, or `encryptedError`.
    public static func parse(_ text: String, baseURL: URL) throws -> HLSPlaylist {
        // "\r\n" is a single Character, so split on isNewline rather than on "\n".
        var lines = text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
        if let first = lines.first, first.hasPrefix("\u{FEFF}") {
            lines[0] = first.dropFirst()
        }
        guard lines.first?.trimmingCharacters(in: .whitespaces) == "#EXTM3U" else {
            throw JobError.invalid("Not an HLS playlist")
        }

        var playlist = HLSPlaylist(isMaster: false)
        // Attributes of an EXT-X-STREAM-INF tag still waiting for its URI line.
        var pendingStream: [String: String]?
        // Duration of an EXTINF tag still waiting for its segment URI line.
        var pendingDuration: Double?
        var encrypted = false

        for rawLine in lines.dropFirst() {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }

            if line.hasPrefix(streamInfTag) {
                playlist.isMaster = true
                // A previous STREAM-INF without a URI line is dropped.
                pendingStream = attributes(line.dropFirst(streamInfTag.count))
            } else if line.hasPrefix(mediaTag) {
                if let rendition = audioRendition(attributes(line.dropFirst(mediaTag.count)), baseURL: baseURL) {
                    playlist.audioRenditions.append(rendition)
                }
            } else if line.hasPrefix(extInfTag) {
                pendingDuration = duration(line.dropFirst(extInfTag.count))
            } else if line.hasPrefix(keyTag) {
                if attributes(line.dropFirst(keyTag.count))["METHOD"]?.uppercased() != "NONE" {
                    playlist.isPlain = false
                }
            } else if line.hasPrefix("#EXT-X-MAP:") || line.hasPrefix("#EXT-X-BYTERANGE:") {
                playlist.isPlain = false
            } else if line.hasPrefix("#ENC-") {
                encrypted = true
            } else if line.hasPrefix("#") {
                continue
            } else if let stream = pendingStream {
                pendingStream = nil
                pendingDuration = nil
                if let variant = variant(stream, uri: line, baseURL: baseURL) {
                    playlist.variants.append(variant)
                }
            } else if let duration = pendingDuration {
                pendingDuration = nil
                if let url = resolve(line, baseURL: baseURL) {
                    playlist.segments.append(HLSMediaSegment(url: url, duration: duration))
                }
            }
        }
        if encrypted, !playlist.isMaster, playlist.segments.isEmpty { throw encryptedError }
        return playlist
    }

    // MARK: Pick

    /// The `preferred` variant when it is one of `variants`, else the highest `BANDWIDTH`
    /// (first wins on ties), plus the URI of its audio rendition: the `DEFAULT=YES` entry of its
    /// `AUDIO` group, else the group's first entry. Nil when there are no variants (media playlist).
    public func pickVariant(preferred: URL? = nil) -> HLSSelection? {
        let chosen: HLSVariant
        if let preferred, let match = variants.first(where: { $0.url.absoluteString == preferred.absoluteString }) {
            chosen = match
        } else if let best = variants.max(by: { $0.bandwidth < $1.bandwidth }) {
            // max(by:) returns the last of equal maxima; take the first instead.
            chosen = variants.first { $0.bandwidth == best.bandwidth } ?? best
        } else {
            return nil
        }

        var audioURL: URL?
        if let group = chosen.audioGroup {
            let renditions = audioRenditions.filter { $0.groupID == group }
            audioURL = (renditions.first { $0.isDefault } ?? renditions.first)?.url
        }
        return HLSSelection(variant: chosen, audioURL: audioURL)
    }

    // MARK: Helpers

    private static let streamInfTag = "#EXT-X-STREAM-INF:"
    private static let mediaTag = "#EXT-X-MEDIA:"
    private static let extInfTag = "#EXTINF:"
    private static let keyTag = "#EXT-X-KEY:"

    private static func variant(_ attributes: [String: String], uri: String, baseURL: URL) -> HLSVariant? {
        guard let url = resolve(uri, baseURL: baseURL) else { return nil }
        return HLSVariant(
            url: url,
            bandwidth: attributes["BANDWIDTH"].flatMap { Int($0) } ?? 0,
            resolution: attributes["RESOLUTION"].flatMap(resolution),
            audioGroup: attributes["AUDIO"]
        )
    }

    private static func audioRendition(_ attributes: [String: String], baseURL: URL) -> HLSAudioRendition? {
        guard attributes["TYPE"] == "AUDIO", let groupID = attributes["GROUP-ID"] else { return nil }
        var url: URL?
        if let uri = attributes["URI"] {
            // A URI that is not http(s) drops the whole rendition, not just its URI.
            guard let resolved = resolve(uri, baseURL: baseURL) else { return nil }
            url = resolved
        }
        return HLSAudioRendition(
            groupID: groupID,
            name: attributes["NAME"],
            isDefault: attributes["DEFAULT"] == "YES",
            url: url
        )
    }

    /// `uri` resolved against `baseURL`, or nil unless the result is http(s) with a host.
    private static func resolve(_ uri: String, baseURL: URL) -> URL? {
        guard let url = URL(string: uri, relativeTo: baseURL)?.absoluteURL,
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty else {
            return nil
        }
        return url
    }

    /// The seconds of an `EXTINF` value (`<duration>[,<title>]`), else nil. Untrusted: only finite,
    /// non-negative values pass.
    private static func duration(_ value: Substring) -> Double? {
        let number = value.prefix { $0 != "," }.trimmingCharacters(in: .whitespaces)
        guard let seconds = Double(number), seconds.isFinite, seconds >= 0 else { return nil }
        return seconds
    }

    /// `<width>x<height>` with positive integers, else nil.
    private static func resolution(_ value: String) -> HLSResolution? {
        let parts = value.lowercased().split(separator: "x", omittingEmptySubsequences: false)
        guard parts.count == 2, let width = Int(parts[0]), let height = Int(parts[1]), width > 0, height > 0 else {
            return nil
        }
        return HLSResolution(width: width, height: height)
    }

    /// Parses an attribute list (`KEY=value,KEY="quoted, value"`). Commas inside quotes do not
    /// split; quotes are stripped from quoted values. Keys are uppercased.
    static func attributes(_ list: Substring) -> [String: String] {
        var result: [String: String] = [:]
        var index = list.startIndex
        while index < list.endIndex {
            guard let equals = list[index...].firstIndex(of: "=") else { break }
            let key = list[index..<equals].trimmingCharacters(in: .whitespaces).uppercased()
            var valueStart = list.index(after: equals)
            let value: Substring
            if valueStart < list.endIndex, list[valueStart] == "\"" {
                valueStart = list.index(after: valueStart)
                let close = list[valueStart...].firstIndex(of: "\"") ?? list.endIndex
                value = list[valueStart..<close]
                index = close < list.endIndex ? list.index(after: close) : close
                // Skip anything up to and including the next comma.
                if let comma = list[index...].firstIndex(of: ",") {
                    index = list.index(after: comma)
                } else {
                    index = list.endIndex
                }
            } else {
                let comma = list[valueStart...].firstIndex(of: ",") ?? list.endIndex
                value = list[valueStart..<comma]
                index = comma < list.endIndex ? list.index(after: comma) : comma
            }
            if !key.isEmpty, result[key] == nil {
                result[key] = value.trimmingCharacters(in: .whitespaces)
            }
        }
        return result
    }
}

/// Drops the captured `Cookie` (and any `Authorization`) when a redirect of a playlist or size
/// request leaves the original URL's origin (scheme, host or port); URLSession would otherwise
/// forward them as is. `Referer` and `Origin` are kept:
/// hotlink-protected CDNs need them, and ffmpeg sends them to every host anyway.
/// Compares with the original URL, not the previous hop, so any off-origin chain fails closed.
final class RedirectGuard: NSObject, URLSessionTaskDelegate, Sendable {
    private let original: URL

    init(original: URL) {
        self.original = original
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        guard let target = request.url, !Self.sameOrigin(target, original) else { return request }
        var stripped = request
        stripped.setValue(nil, forHTTPHeaderField: "Cookie")
        stripped.setValue(nil, forHTTPHeaderField: "Authorization")
        return stripped
    }

    /// A GET of `url` with the captured `headers`. URLSession's own cookie handling is off, so it
    /// neither replaces the captured Cookie nor stores a `Set-Cookie` from the response.
    static func request(_ url: URL, headers: [String: String]) -> URLRequest {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpShouldHandleCookies = false
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        return request
    }

    /// Same scheme, host and port, a missing port being the scheme's default (https 443, http 80),
    /// so `https://a.com` and `https://a.com:443` match. Also decides which ffmpeg inputs get `-cookies`.
    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        a.scheme?.lowercased() == b.scheme?.lowercased()
            && a.host?.lowercased() == b.host?.lowercased()
            && effectivePort(a) == effectivePort(b)
    }

    private static func effectivePort(_ url: URL) -> Int {
        url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80)
    }
}

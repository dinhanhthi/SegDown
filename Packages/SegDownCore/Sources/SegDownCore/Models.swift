// Models shared by the app, the native host, the CLI and (as JSON) the browser extension.
import Foundation

/// A time range in seconds within the source video.
public struct Segment: Codable, Sendable, Hashable {
    public var start: Double
    public var end: Double

    public init(start: Double, end: Double) {
        self.start = start
        self.end = end
    }
}

public enum MediaKind: String, Codable, Sendable, Hashable {
    case mp4
    case hls
}

/// Where the media comes from.
///
/// JSON shape (discriminated by `type`):
///
///     {"type": "media", "url": "https://…/master.m3u8", "kind": "hls",
///      "headers": {"Referer": "https://…"},           // optional, defaults to {}
///      "variantURL": "https://…/720p.m3u8",           // optional
///      "audioURL": "https://…/audio.m3u8"}            // optional
///
///     {"type": "page", "url": "https://www.youtube.com/watch?v=…"}
///
/// URLs are plain strings. Unknown keys are ignored; an unknown `type` fails decoding.
public enum Source: Sendable, Hashable {
    case media(url: URL, kind: MediaKind, headers: [String: String], variantURL: URL?, audioURL: URL?)
    case page(url: URL)
}

extension Source: Codable {
    private enum CodingKeys: String, CodingKey {
        case type, url, kind, headers, variantURL, audioURL
    }

    private enum SourceType: String, Codable {
        case media, page
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let url = try Self.decodeURL(c, .url)
        switch try c.decode(SourceType.self, forKey: .type) {
        case .media:
            self = .media(
                url: url,
                kind: try c.decode(MediaKind.self, forKey: .kind),
                headers: try c.decodeIfPresent([String: String].self, forKey: .headers) ?? [:],
                variantURL: try Self.decodeURLIfPresent(c, .variantURL),
                audioURL: try Self.decodeURLIfPresent(c, .audioURL)
            )
        case .page:
            self = .page(url: url)
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .media(url, kind, headers, variantURL, audioURL):
            try c.encode(SourceType.media, forKey: .type)
            try c.encode(url.absoluteString, forKey: .url)
            try c.encode(kind, forKey: .kind)
            try c.encode(headers, forKey: .headers)
            try c.encodeIfPresent(variantURL?.absoluteString, forKey: .variantURL)
            try c.encodeIfPresent(audioURL?.absoluteString, forKey: .audioURL)
        case let .page(url):
            try c.encode(SourceType.page, forKey: .type)
            try c.encode(url.absoluteString, forKey: .url)
        }
    }

    private static func decodeURL(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) throws -> URL {
        guard let url = try decodeURLIfPresent(c, key) else {
            throw DecodingError.keyNotFound(key, .init(codingPath: c.codingPath, debugDescription: "Missing URL"))
        }
        return url
    }

    private static func decodeURLIfPresent(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) throws -> URL? {
        guard let string = try c.decodeIfPresent(String.self, forKey: key) else { return nil }
        guard let url = URL(string: string) else {
            throw DecodingError.dataCorruptedError(forKey: key, in: c, debugDescription: "Invalid URL")
        }
        return url
    }
}

public enum OutputMode: String, Codable, Sendable, Hashable {
    case separate
    case merged
}

public enum Precision: String, Codable, Sendable, Hashable {
    case precise
    case fast
}

/// JSON: `{"source": {…}, "title": "…", "segments": [{"start": 10, "end": 20}], "mode": "separate", "precision": "precise"}`
///
/// Optional keys (protocol 2; absent from older extensions, omitted when `nil`):
/// `"incognito": true`, `"fallback": {…Source…}` (media to try when the page source fails) and
/// `"mediaDuration": 3600` (seconds, the whole video's duration, for the size estimate).
/// `"pageURL": "https://…"` (the tab's page, which the window's card opens) is optional too; older apps ignore it.
/// `"maxHeight": 1080` (protocol 3, page source only: the tallest video yt-dlp may pick).
public struct JobRequest: Codable, Sendable, Hashable {
    public var source: Source
    public var title: String
    public var segments: [Segment]
    public var mode: OutputMode
    public var precision: Precision
    public var incognito: Bool?
    public var fallback: Source?
    public var mediaDuration: Double?
    public var pageURL: URL?
    public var maxHeight: Int?

    public init(
        source: Source,
        title: String,
        segments: [Segment],
        mode: OutputMode,
        precision: Precision,
        incognito: Bool? = nil,
        fallback: Source? = nil,
        mediaDuration: Double? = nil,
        pageURL: URL? = nil,
        maxHeight: Int? = nil
    ) {
        self.source = source
        self.title = title
        self.segments = segments
        self.mode = mode
        self.precision = precision
        self.incognito = incognito
        self.fallback = fallback
        self.mediaDuration = mediaDuration
        self.pageURL = pageURL
        self.maxHeight = maxHeight
    }

    private enum CodingKeys: String, CodingKey {
        case source, title, segments, mode, precision, incognito, fallback, mediaDuration, pageURL, maxHeight
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = try c.decode(Source.self, forKey: .source)
        title = try c.decode(String.self, forKey: .title)
        segments = try c.decode([Segment].self, forKey: .segments)
        mode = try c.decode(OutputMode.self, forKey: .mode)
        precision = try c.decode(Precision.self, forKey: .precision)
        incognito = try c.decodeIfPresent(Bool.self, forKey: .incognito)
        fallback = try c.decodeIfPresent(Source.self, forKey: .fallback)
        mediaDuration = try c.decodeIfPresent(Double.self, forKey: .mediaDuration)
        pageURL = try c.decodeIfPresent(URL.self, forKey: .pageURL)
        maxHeight = try c.decodeIfPresent(Int.self, forKey: .maxHeight)
    }
}

public enum JobState: String, Codable, Sendable, Hashable {
    case queued
    case running
    case done
    case failed
    case cancelled
}

/// JSON: `{"type": "linkExpired"}` or `{"type": "missingDependency", "detail": "ffmpeg"}`
/// (same for `processFailed` and `invalid`); `{"type": "unsupportedSite"}` when yt-dlp has no
/// extractor for the page (only with the generic extractor off); `{"type": "sizeExceeded",
/// "detail": 500000000}` when the downloaded bytes passed the job's size cap (`detail` = the cap).
public enum JobError: Error, Sendable, Hashable {
    case linkExpired
    case unsupportedSite
    case sizeExceeded(Int64)
    case missingDependency(String)
    case processFailed(String)
    case invalid(String)
}

extension JobError: Codable {
    private enum CodingKeys: String, CodingKey {
        case type, detail
    }

    private enum ErrorType: String, Codable {
        case linkExpired, unsupportedSite, sizeExceeded, missingDependency, processFailed, invalid
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(ErrorType.self, forKey: .type) {
        case .linkExpired: self = .linkExpired
        case .unsupportedSite: self = .unsupportedSite
        case .sizeExceeded: self = .sizeExceeded(try c.decode(Int64.self, forKey: .detail))
        case .missingDependency: self = .missingDependency(try c.decode(String.self, forKey: .detail))
        case .processFailed: self = .processFailed(try c.decode(String.self, forKey: .detail))
        case .invalid: self = .invalid(try c.decode(String.self, forKey: .detail))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .linkExpired:
            try c.encode(ErrorType.linkExpired, forKey: .type)
        case .unsupportedSite:
            try c.encode(ErrorType.unsupportedSite, forKey: .type)
        case let .sizeExceeded(limit):
            try c.encode(ErrorType.sizeExceeded, forKey: .type)
            try c.encode(limit, forKey: .detail)
        case let .missingDependency(detail):
            try c.encode(ErrorType.missingDependency, forKey: .type)
            try c.encode(detail, forKey: .detail)
        case let .processFailed(detail):
            try c.encode(ErrorType.processFailed, forKey: .type)
            try c.encode(detail, forKey: .detail)
        case let .invalid(detail):
            try c.encode(ErrorType.invalid, forKey: .type)
            try c.encode(detail, forKey: .detail)
        }
    }
}

/// Progress of one job. `segmentIndex` is 0-based; `fraction` is overall progress in 0...1.
/// `outputs` holds the absolute paths of the files written so far. `bytes` is the size downloaded
/// so far; `fallbackUsed` is `true` once the job switched to its captured media fallback; `title`,
/// in the final status only, is the job's new title (the video's real title read by yt-dlp in
/// place of a generic tab title) when it differs from the request's. All three
/// are optional on the wire and omitted when `nil`; `fallbackUsed` is never sent as `false`.
public struct JobStatus: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var state: JobState
    public var segmentIndex: Int
    public var segmentCount: Int
    public var fraction: Double
    public var message: String?
    public var outputs: [String]
    public var bytes: Int64?
    public var fallbackUsed: Bool?
    public var title: String?

    public init(
        id: String,
        state: JobState,
        segmentIndex: Int = 0,
        segmentCount: Int,
        fraction: Double = 0,
        message: String? = nil,
        outputs: [String] = [],
        bytes: Int64? = nil,
        fallbackUsed: Bool? = nil,
        title: String? = nil
    ) {
        self.id = id
        self.state = state
        self.segmentIndex = segmentIndex
        self.segmentCount = segmentCount
        self.fraction = fraction
        self.message = message
        self.outputs = outputs
        self.bytes = bytes
        self.fallbackUsed = fallbackUsed
        self.title = title
    }
}

// Security boundary: everything from the browser extension passes through here before
// it is fetched or handed to ffmpeg/yt-dlp. Error reasons never echo header values or URLs.
import Foundation

/// Per-job limits from the app's settings; `nil` means no limit. `maxBytes` is enforced by the
/// runner, not by `Validation.check`.
public struct JobLimits: Sendable, Hashable {
    public var maxDuration: Double?
    public var maxBytes: Int64?

    public init(maxDuration: Double? = nil, maxBytes: Int64? = nil) {
        self.maxDuration = maxDuration
        self.maxBytes = maxBytes
    }
}

public enum Validation {
    public static let allowedHeaders = ["Referer", "Origin", "User-Agent", "Cookie"]
    public static let maxHeaderValueBytes = 8 * 1024
    public static let maxSegments = 100
    public static let maxTitleLength = 300
    /// Latest allowed segment end, in seconds (7 days).
    public static let maxSegmentEnd: Double = 7 * 86_400

    /// Validates a job before it is enqueued. Returns the request with normalized header names.
    public static func validate(_ request: JobRequest) throws -> JobRequest {
        guard request.title.count <= maxTitleLength else {
            throw JobError.invalid("Title is longer than \(maxTitleLength) characters")
        }
        guard (1...maxSegments).contains(request.segments.count) else {
            throw JobError.invalid("Expected 1 to \(maxSegments) segments, got \(request.segments.count)")
        }
        for (index, segment) in request.segments.enumerated() {
            guard segment.start.isFinite, segment.end.isFinite else {
                throw JobError.invalid("Segment \(index + 1) has a non-finite time")
            }
            guard segment.start >= 0, segment.start < segment.end else {
                throw JobError.invalid("Segment \(index + 1) must satisfy 0 <= start < end")
            }
            guard segment.end <= maxSegmentEnd else {
                throw JobError.invalid("Segment \(index + 1) ends after the 7-day limit")
            }
        }
        if let mediaDuration = request.mediaDuration {
            guard mediaDuration.isFinite, mediaDuration > 0, mediaDuration <= maxSegmentEnd else {
                throw JobError.invalid("mediaDuration must be finite, > 0 and within the 7-day limit")
            }
        }
        if let pageURL = request.pageURL { try checkScheme(pageURL, field: "pageURL") }
        var validated = request
        validated.source = try validate(request.source)
        if let fallback = request.fallback {
            guard case .media = fallback else {
                throw JobError.invalid("fallback must be a media source")
            }
            guard case .page = request.source else {
                throw JobError.invalid("fallback is only allowed with a page source")
            }
            validated.fallback = try validate(fallback)
        }
        return validated
    }

    /// Checks a job against the app's limits. Expects a request that already passed `validate(_:)`.
    /// Not called by `validate(_:)`, so the CLI has no limits.
    public static func check(_ request: JobRequest, limits: JobLimits) throws {
        guard let maxDuration = limits.maxDuration else { return }
        let total = request.segments.reduce(0) { $0 + ($1.end - $1.start) }
        guard total <= maxDuration else {
            // Total rounded up, limit down: the two never print the same.
            throw JobError.invalid(
                "Total duration \(duration(total, roundUp: true)) exceeds the max duration (\(duration(maxDuration, roundUp: false)))"
            )
        }
    }

    /// Validates a source before it is probed or fetched. Returns it with normalized header names.
    public static func validate(_ source: Source) throws -> Source {
        switch source {
        case let .media(url, kind, headers, variantURL, audioURL):
            try checkScheme(url, field: "url")
            if let variantURL { try checkScheme(variantURL, field: "variantURL") }
            if let audioURL { try checkScheme(audioURL, field: "audioURL") }
            return .media(
                url: url,
                kind: kind,
                headers: try normalizedHeaders(headers),
                variantURL: variantURL,
                audioURL: audioURL
            )
        case let .page(url):
            try checkScheme(url, field: "url")
            return source
        }
    }

    /// `H:MM:SS` (or `M:SS` under an hour) with integer math, whatever the locale.
    private static func duration(_ seconds: Double, roundUp: Bool) -> String {
        let clamped = seconds.isFinite ? min(max(seconds, 0), 9e15) : 0
        let total = Int(roundUp ? clamped.rounded(.up) : clamped.rounded(.down))
        let (hours, minutes, secs) = (total / 3600, total / 60 % 60, total % 60)
        let ss = secs < 10 ? "0\(secs)" : "\(secs)"
        guard hours > 0 else { return "\(minutes):\(ss)" }
        return "\(hours):\(minutes < 10 ? "0\(minutes)" : "\(minutes)"):\(ss)"
    }

    private static func checkScheme(_ url: URL, field: String) throws {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            throw JobError.invalid("\(field) must use http or https")
        }
    }

    private static func normalizedHeaders(_ headers: [String: String]) throws -> [String: String] {
        var result: [String: String] = [:]
        for (name, value) in headers {
            guard let canonical = allowedHeaders.first(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) else {
                throw JobError.invalid("Header is not allowed (allowed: \(allowedHeaders.joined(separator: ", ")))")
            }
            guard result[canonical] == nil else {
                throw JobError.invalid("Duplicate \(canonical) header")
            }
            // Scalar-level check: "\r\n" is a single Character, so a Character search would miss it.
            guard !value.unicodeScalars.contains(where: { $0 == "\r" || $0 == "\n" || $0 == "\0" }) else {
                throw JobError.invalid("\(canonical) header value contains CR, LF or NUL")
            }
            guard value.utf8.count <= maxHeaderValueBytes else {
                throw JobError.invalid("\(canonical) header value exceeds 8 KB")
            }
            result[canonical] = value
        }
        return result
    }
}

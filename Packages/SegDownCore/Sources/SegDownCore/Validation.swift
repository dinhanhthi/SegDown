// Security boundary: everything from the browser extension passes through here before
// it is fetched or handed to ffmpeg/yt-dlp. Error reasons never echo header values or URLs.
import Foundation

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
        var validated = request
        validated.source = try validate(request.source)
        return validated
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

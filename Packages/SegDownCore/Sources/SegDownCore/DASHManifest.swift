// Reads DASH manifests (MPD) in the app, because Homebrew's ffmpeg has no `dash` demuxer. The
// MPD is untrusted XML: any DOCTYPE or ENTITY is rejected before parsing (XXE, billion laughs),
// external entities stay off, its size and segment count are capped, and every URL it expands to
// must be http(s) with a host.
import Foundation

/// The media of one DASH track: one whole file (read by ffmpeg over http), or an init section
/// plus media segments to stage and join.
public enum DASHTrackContent: Sendable, Hashable {
    case file(URL)
    case segments(initURL: URL?, segments: [HLSMediaSegment])
}

/// The chosen Representation of a video or audio AdaptationSet.
public struct DASHTrack: Sendable, Hashable {
    public var bandwidth: Int
    /// `"webm"` for a `video/webm` / `audio/webm` mimeType, else `"mp4"`.
    public var ext: String
    /// The Representation's `@codecs`, else the AdaptationSet's (`avc1.640028`, `vp8`…).
    public var codecs: String?
    public var content: DASHTrackContent

    public init(bandwidth: Int, ext: String, codecs: String? = nil, content: DASHTrackContent) {
        self.bandwidth = bandwidth
        self.ext = ext
        self.codecs = codecs
        self.content = content
    }
}

public struct DASHManifest: Sendable, Hashable {
    /// Manifests larger than this are rejected; real MPDs are a few KB to a few hundred KB.
    public static let maxManifestBytes = 4 * 1024 * 1024
    /// Segments allowed per track.
    public static let maxSegments = 100_000

    /// `Period@duration`, else `MPD@mediaPresentationDuration`, in seconds.
    public var duration: Double?
    /// The highest-bandwidth Representation of the video AdaptationSet.
    public var video: DASHTrack
    /// The highest-bandwidth Representation of the main audio AdaptationSet; nil for video only.
    public var audio: DASHTrack?

    public init(duration: Double?, video: DASHTrack, audio: DASHTrack? = nil) {
        self.duration = duration
        self.video = video
        self.audio = audio
    }

    // MARK: Fetch

    /// Fetches `url` with the captured headers and parses it. The caller must have run
    /// `Validation.validate` on the source first (http(s) URL, allowlisted headers). `session` nil:
    /// `DisguisedHLS.session`, cookie-less, so a CDN's `Set-Cookie` stays out of the shared jar.
    public static func fetch(
        _ url: URL,
        headers: [String: String],
        session: URLSession? = nil
    ) async throws -> DASHManifest {
        let request = RedirectGuard.request(url, headers: headers)
        let (bytes, response) = try await (session ?? DisguisedHLS.session).bytes(for: request, delegate: RedirectGuard(original: url))
        guard let http = response as? HTTPURLResponse else {
            throw JobError.processFailed("DASH manifest response is not HTTP")
        }
        switch http.statusCode {
        case 200..<300: break
        case 403, 410: throw JobError.linkExpired
        default: throw JobError.processFailed("DASH manifest request failed with HTTP \(http.statusCode)")
        }
        guard http.expectedContentLength <= Int64(maxManifestBytes) else {
            throw JobError.invalid("DASH manifest is larger than \(maxManifestBytes) bytes")
        }

        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            if data.count > maxManifestBytes {
                throw JobError.invalid("DASH manifest is larger than \(maxManifestBytes) bytes")
            }
        }
        guard let text = String(data: data, encoding: .utf8) else {
            throw JobError.invalid("DASH manifest is not UTF-8 text")
        }
        // Relative URLs resolve against the final URL, as a player does after a redirect.
        return try parse(text, baseURL: http.url ?? url)
    }

    // MARK: Errors

    static let doctypeError = JobError.invalid("The DASH manifest has a DOCTYPE or ENTITY, SegDown doesn't read it")
    static let notManifestError = JobError.invalid("Not a DASH manifest")
    static let liveError = JobError.invalid("Live DASH streams aren't supported")
    static let periodsError = JobError.invalid("DASH with several periods (often ads) isn't supported")
    static let drmError = JobError.invalid("This video is DRM-protected, SegDown can't download it")
    static let noVideoError = JobError.invalid("The DASH manifest has no video")
    static let unsupportedError = JobError.invalid("This DASH stream type isn't supported yet")
    static let schemeError = JobError.invalid("The DASH manifest links to files that are not http(s)")
    static let tooManyError = JobError.invalid("The DASH manifest has too many segments")
    static let noDurationError = JobError.invalid("The DASH manifest has no duration")
    static let durationError = JobError.invalid("The DASH manifest has an invalid segment duration")
    static let noSegmentsError = JobError.invalid("The DASH manifest has no segments")
    static let noFileError = JobError.invalid("The DASH manifest has no media URL")

    // MARK: Parse

    /// Parses MPD text. Relative URLs resolve against `baseURL`. Throws `JobError.invalid` for a
    /// DOCTYPE/ENTITY, malformed XML, or a manifest SegDown can't download (live, several periods,
    /// DRM, no video, an unsupported addressing, non-http(s) URLs, too many segments).
    public static func parse(_ text: String, baseURL: URL) throws -> DASHManifest {
        guard text.range(of: "<!DOCTYPE", options: .caseInsensitive) == nil,
              text.range(of: "<!ENTITY", options: .caseInsensitive) == nil else {
            throw doctypeError
        }
        let mpd = try tree(Data(text.utf8))
        guard mpd.attributes["type"] != "dynamic" else { throw liveError }
        let periods = mpd.children("Period")
        guard periods.count <= 1 else { throw periodsError }
        guard let period = periods.first else { throw notManifestError }

        let duration = try (period.attributes["duration"] ?? mpd.attributes["mediaPresentationDuration"])
            .map { value -> Double in
                guard let seconds = isoDuration(value), seconds > 0, seconds <= Validation.maxSegmentEnd else {
                    throw durationError
                }
                return seconds
            }

        let sets = period.children("AdaptationSet")
        guard let videoSet = sets.first(where: { isContent($0, "video") }) else { throw noVideoError }
        let audioSets = sets.filter { isContent($0, "audio") }
        let audioSet = audioSets.first { set in
            set.children("Role").contains { $0.attributes["value"] == "main" }
        } ?? audioSets.first

        let context = Context(mpd: mpd, period: period, baseURL: baseURL, duration: duration)
        let video = try track(videoSet, context: context)
        let audio = try audioSet.map { try track($0, context: context) }
        return DASHManifest(duration: duration, video: video, audio: audio)
    }

    // MARK: Tree

    /// One kept element: local name, attributes, kept children and its text (for `BaseURL`).
    private final class Node {
        let name: String
        let attributes: [String: String]
        var children: [Node] = []
        var text = ""

        init(name: String, attributes: [String: String]) {
            self.name = name
            self.attributes = attributes
        }

        func children(_ name: String) -> [Node] {
            children.filter { $0.name == name }
        }

        func child(_ name: String) -> Node? {
            children.first { $0.name == name }
        }
    }

    /// Builds the tree of the elements SegDown reads. Elements are matched by local name, so
    /// `mpd:` prefixes work; the subtree of any other element is dropped.
    private final class TreeBuilder: NSObject, XMLParserDelegate {
        static let kept: Set<String> = [
            "MPD", "Period", "AdaptationSet", "Representation", "BaseURL", "SegmentBase", "SegmentTemplate",
            "SegmentTimeline", "S", "SegmentList", "SegmentURL", "Initialization", "ContentProtection", "Role",
        ]
        var root: Node?
        /// Nil entries are dropped elements (and everything below them).
        private var stack: [Node?] = []

        func parser(
            _ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?,
            qualifiedName qName: String?, attributes attributeDict: [String: String] = [:]
        ) {
            let keep = Self.kept.contains(elementName) && (stack.isEmpty ? elementName == "MPD" : stack.last! != nil)
            guard keep else {
                stack.append(nil)
                return
            }
            let node = Node(name: elementName, attributes: attributeDict)
            if let parent = stack.last ?? nil {
                parent.children.append(node)
            } else {
                root = node
            }
            stack.append(node)
        }

        func parser(
            _ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?
        ) {
            _ = stack.popLast()
        }

        func parser(_ parser: XMLParser, foundCharacters string: String) {
            if let node = stack.last ?? nil, node.name == "BaseURL" {
                node.text += string
            }
        }
    }

    private static func tree(_ data: Data) throws -> Node {
        let parser = XMLParser(data: data)
        parser.shouldResolveExternalEntities = false
        parser.shouldProcessNamespaces = true
        let builder = TreeBuilder()
        parser.delegate = builder
        guard parser.parse(), let root = builder.root else { throw notManifestError }
        return root
    }

    // MARK: Track

    private struct Context {
        var mpd: Node
        var period: Node
        var baseURL: URL
        var duration: Double?
    }

    /// The highest-bandwidth Representation of `set` (first wins on ties) as a track.
    private static func track(_ set: Node, context: Context) throws -> DASHTrack {
        let representations = set.children("Representation")
        guard let best = representations.max(by: { bandwidth($0) < bandwidth($1) }) else { throw unsupportedError }
        // max(by:) returns the last of equal maxima; take the first instead.
        let rep = representations.first { bandwidth($0) == bandwidth(best) } ?? best
        guard set.child("ContentProtection") == nil, rep.child("ContentProtection") == nil else { throw drmError }

        // The BaseURL chain: the first BaseURL per level, each resolved against the previous one.
        var base = context.baseURL
        var hasBaseURL = false
        for level in [context.mpd, context.period, set, rep] {
            guard let text = level.child("BaseURL")?.text.trimmingCharacters(in: .whitespacesAndNewlines),
                  !text.isEmpty else { continue }
            base = try resolve(text, baseURL: base)
            hasBaseURL = true
        }

        let mimeType = (rep.attributes["mimeType"] ?? set.attributes["mimeType"])?.lowercased()
        let ext = mimeType == "video/webm" || mimeType == "audio/webm" ? "webm" : "mp4"
        let content = try addressing(
            levels: [context.period, set, rep], rep: rep, base: base, hasBaseURL: hasBaseURL,
            duration: context.duration
        )
        if case let .segments(_, segments) = content {
            guard !segments.isEmpty else { throw noSegmentsError }
            let total = segments.reduce(0) { $0 + $1.duration }
            guard total <= Validation.maxSegmentEnd else { throw durationError }
        }
        return DASHTrack(
            bandwidth: bandwidth(rep), ext: ext, codecs: rep.attributes["codecs"] ?? set.attributes["codecs"],
            content: content
        )
    }

    /// The content of `rep` from the deepest addressing element of `levels` (Period, AdaptationSet,
    /// Representation); its attributes inherit from the shallower levels.
    private static func addressing(
        levels: [Node], rep: Node, base: URL, hasBaseURL: Bool, duration: Double?
    ) throws -> DASHTrackContent {
        // The deepest level that has any addressing element decides the kind.
        let deepest = levels.reversed().lazy.compactMap { level in
            ["SegmentTemplate", "SegmentList", "SegmentBase"].lazy.compactMap { level.child($0) }.first
        }.first
        guard let deepest else {
            guard hasBaseURL else { throw noFileError }
            return .file(base)
        }
        let elements = levels.compactMap { $0.child(deepest.name) }
        var attributes: [String: String] = [:]
        for element in elements {
            attributes.merge(element.attributes) { _, deeper in deeper }
        }
        let timeline = elements.last { $0.child("SegmentTimeline") != nil }?.child("SegmentTimeline")

        switch deepest.name {
        case "SegmentTemplate":
            return try template(attributes, timeline: timeline, rep: rep, base: base, duration: duration)
        case "SegmentList":
            let initialization = elements.last { $0.child("Initialization") != nil }?.child("Initialization")
            let urls = elements.last { !$0.children("SegmentURL").isEmpty }?.children("SegmentURL") ?? []
            return try list(
                attributes, initialization: initialization, urls: urls, timeline: timeline, base: base,
                hasBaseURL: hasBaseURL, duration: duration
            )
        default:
            guard hasBaseURL else { throw noFileError }
            return .file(base)
        }
    }

    // MARK: SegmentTemplate

    private static func template(
        _ attributes: [String: String], timeline: Node?, rep: Node, base: URL, duration: Double?
    ) throws -> DASHTrackContent {
        let timescale = try positive(attributes["timescale"], default: 1)
        let startNumber = try nonNegative(attributes["startNumber"], default: 1)
        guard let mediaText = attributes["media"] else { throw unsupportedError }
        let media = try TemplateString(mediaText)
        let values = TemplateValues(id: rep.attributes["id"] ?? "", bandwidth: bandwidth(rep))

        var initURL: URL?
        if let initText = attributes["initialization"] {
            initURL = try resolve(TemplateString(initText).expand(values, number: startNumber, time: 0), baseURL: base)
        }

        let times = try segmentTimes(
            timeline: timeline, duration: attributes["duration"], timescale: timescale,
            presentationTimeOffset: try nonNegative(attributes["presentationTimeOffset"], default: 0), total: duration
        )
        var segments: [HLSMediaSegment] = []
        segments.reserveCapacity(times.count)
        for (index, time) in times.enumerated() {
            let (number, overflow) = startNumber.addingReportingOverflow(index)
            guard !overflow else { throw unsupportedError }
            let url = try resolve(media.expand(values, number: number, time: time.start), baseURL: base)
            segments.append(HLSMediaSegment(url: url, duration: try seconds(time.duration, timescale: timescale)))
        }
        return .segments(initURL: initURL, segments: segments)
    }

    /// Start time and duration of one segment, in timescale units.
    private struct SegmentTime {
        var start: Int
        var duration: Int
    }

    /// The segment times of a `SegmentTimeline`, else of a `@duration`. The segment count is
    /// checked against `maxSegments` before any `@r` or `@duration` count is expanded.
    private static func segmentTimes(
        timeline: Node?, duration: String?, timescale: Int, presentationTimeOffset: Int, total: Double?
    ) throws -> [SegmentTime] {
        if let timeline {
            return try timelineTimes(timeline, timescale: timescale, presentationTimeOffset: presentationTimeOffset, total: total)
        }
        guard let duration else { throw unsupportedError }
        let length = try positive(duration, default: 1)
        guard let total else { throw noDurationError }
        // `total` is at most 7 days, but `timescale` is untrusted: keep the end time inside Int.
        guard total * Double(timescale) < 1e18 else { throw durationError }
        let count = (total * Double(timescale) / Double(length)).rounded(.up)
        guard count.isFinite, count <= Double(maxSegments) else { throw tooManyError }
        let whole = Int(count)
        guard whole > 0 else { throw noSegmentsError }
        return try (0..<whole).map { index in
            let start = index * length
            // The last segment ends at the period end, so the durations add up to `total`.
            let end = index == whole - 1 ? max(Int((total * Double(timescale)).rounded()), start + 1) : start + length
            // `presentationTimeOffset` is untrusted (up to Int.max).
            let (shifted, overflow) = presentationTimeOffset.addingReportingOverflow(start)
            guard !overflow else { throw durationError }
            return SegmentTime(start: shifted, duration: end - start)
        }
    }

    private static func timelineTimes(
        _ timeline: Node, timescale: Int, presentationTimeOffset: Int, total: Double?
    ) throws -> [SegmentTime] {
        let entries = timeline.children("S")
        var times: [SegmentTime] = []
        var time = presentationTimeOffset
        for (index, entry) in entries.enumerated() {
            if let t = entry.attributes["t"] { time = try nonNegative(t, default: 0) }
            let length = try positive(entry.attributes["d"], default: nil)
            let repeats = try integer(entry.attributes["r"], default: 0)
            guard repeats >= -1 else { throw unsupportedError }

            var count: Int
            if repeats == -1 {
                // Repeats up to the next S@t, else to the period end.
                let end: Double
                if let next = entries.dropFirst(index + 1).first?.attributes["t"] {
                    end = Double(try nonNegative(next, default: 0))
                } else {
                    guard let total else { throw noDurationError }
                    end = Double(presentationTimeOffset) + total * Double(timescale)
                }
                let exact = ((end - Double(time)) / Double(length)).rounded(.up)
                guard exact.isFinite, exact <= Double(maxSegments) else { throw tooManyError }
                count = max(Int(exact), 0)
            } else {
                guard repeats < maxSegments else { throw tooManyError }
                count = repeats + 1
            }
            guard times.count + count <= maxSegments else { throw tooManyError }
            for _ in 0..<count {
                times.append(SegmentTime(start: time, duration: length))
                let (next, overflow) = time.addingReportingOverflow(length)
                guard !overflow else { throw durationError }
                time = next
            }
        }
        return times
    }

    // MARK: SegmentList

    private static func list(
        _ attributes: [String: String], initialization: Node?, urls: [Node], timeline: Node?, base: URL,
        hasBaseURL: Bool, duration: Double?
    ) throws -> DASHTrackContent {
        guard !urls.contains(where: { $0.attributes["media"] != nil && $0.attributes["mediaRange"] != nil }) else {
            throw unsupportedError
        }
        let withMedia = urls.filter { $0.attributes["media"] != nil }
        if withMedia.isEmpty {
            // Byte ranges of the BaseURL itself (`ffmpeg -f dash -single_file 1`): one whole file.
            guard hasBaseURL, initialization?.attributes["sourceURL"] == nil else { throw unsupportedError }
            return .file(base)
        }
        guard withMedia.count == urls.count, urls.count <= maxSegments else {
            throw urls.count > maxSegments ? tooManyError : unsupportedError
        }

        let timescale = try positive(attributes["timescale"], default: 1)
        let lengths: [Double]
        if let length = attributes["duration"] {
            let value = try seconds(try positive(length, default: nil), timescale: timescale)
            lengths = Array(repeating: value, count: urls.count)
        } else if let timeline {
            let times = try timelineTimes(timeline, timescale: timescale, presentationTimeOffset: 0, total: duration)
            guard times.count == urls.count else { throw unsupportedError }
            lengths = try times.map { try seconds($0.duration, timescale: timescale) }
        } else {
            guard let duration else { throw noDurationError }
            lengths = Array(repeating: duration / Double(urls.count), count: urls.count)
        }

        let initURL = try initialization?.attributes["sourceURL"].map { try resolve($0, baseURL: base) }
        let segments = try zip(urls, lengths).map { url, length in
            HLSMediaSegment(url: try resolve(url.attributes["media"]!, baseURL: base), duration: length)
        }
        return .segments(initURL: initURL, segments: segments)
    }

    // MARK: Template strings

    private struct TemplateValues {
        var id: String
        var bandwidth: Int
    }

    /// A `media` / `initialization` template, split once into literal text and identifiers.
    /// Never handed to `String(format:)`: the `%0Nd` width is parsed and padded here.
    private struct TemplateString {
        enum Identifier: String {
            case representationID = "RepresentationID"
            case number = "Number"
            case time = "Time"
            case bandwidth = "Bandwidth"
        }

        enum Part {
            case literal(String)
            case identifier(Identifier, width: Int)
        }

        /// Widths above this are refused (a huge `%0Nd` would build a huge string).
        static let maxWidth = 32
        var parts: [Part] = []

        init(_ text: String) throws {
            var rest = Substring(text)
            while let dollar = rest.firstIndex(of: "$") {
                parts.append(.literal(String(rest[..<dollar])))
                let after = rest.index(after: dollar)
                guard let close = rest[after...].firstIndex(of: "$") else { throw DASHManifest.unsupportedError }
                let token = rest[after..<close]
                rest = rest[rest.index(after: close)...]
                if token.isEmpty {
                    parts.append(.literal("$"))
                    continue
                }
                let name = token.prefix { $0 != "%" }
                guard let identifier = Identifier(rawValue: String(name)) else { throw DASHManifest.unsupportedError }
                var width = 0
                let format = token.dropFirst(name.count)
                if !format.isEmpty {
                    // `%0Nd` (or `%d`), never on `$RepresentationID$`.
                    guard identifier != .representationID, format.hasPrefix("%"), format.hasSuffix("d"),
                          format.count >= 2 else { throw DASHManifest.unsupportedError }
                    let digits = format.dropFirst().dropLast()
                    if !digits.isEmpty {
                        guard digits.hasPrefix("0"), digits.allSatisfy(\.isASCIIDigit),
                              let value = Int(digits), value <= Self.maxWidth else { throw DASHManifest.unsupportedError }
                        width = value
                    }
                }
                parts.append(.identifier(identifier, width: width))
            }
            parts.append(.literal(String(rest)))
        }

        func expand(_ values: TemplateValues, number: Int, time: Int) -> String {
            var result = ""
            for part in parts {
                switch part {
                case let .literal(text):
                    result += text
                case let .identifier(identifier, width):
                    let value: String
                    switch identifier {
                    case .representationID: value = values.id
                    case .number: value = String(number)
                    case .time: value = String(time)
                    case .bandwidth: value = String(values.bandwidth)
                    }
                    result += String(repeating: "0", count: max(width - value.count, 0)) + value
                }
            }
            return result
        }
    }

    // MARK: Helpers

    private static func bandwidth(_ rep: Node) -> Int {
        rep.attributes["bandwidth"].flatMap { Int($0) } ?? 0
    }

    /// True when `set` has `contentType == kind`, or a `<kind>/…` mimeType on itself or its first
    /// Representation.
    private static func isContent(_ set: Node, _ kind: String) -> Bool {
        if set.attributes["contentType"]?.lowercased() == kind { return true }
        let mimeType = set.attributes["mimeType"] ?? set.child("Representation")?.attributes["mimeType"]
        return mimeType?.lowercased().hasPrefix(kind + "/") == true
    }

    /// `uri` resolved against `baseURL`; throws `schemeError` unless the result is http(s) with a host.
    private static func resolve(_ uri: String, baseURL: URL) throws -> URL {
        guard let url = URL(string: uri, relativeTo: baseURL)?.absoluteURL,
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty else {
            throw schemeError
        }
        return url
    }

    /// `units / timescale` seconds; throws unless finite and > 0.
    private static func seconds(_ units: Int, timescale: Int) throws -> Double {
        let value = Double(units) / Double(timescale)
        guard value.isFinite, value > 0, value <= Validation.maxSegmentEnd else { throw durationError }
        return value
    }

    private static func integer(_ text: String?, default fallback: Int?) throws -> Int {
        guard let text else {
            guard let fallback else { throw unsupportedError }
            return fallback
        }
        guard let value = Int(text.trimmingCharacters(in: .whitespaces)) else { throw unsupportedError }
        return value
    }

    private static func nonNegative(_ text: String?, default fallback: Int?) throws -> Int {
        let value = try integer(text, default: fallback)
        guard value >= 0 else { throw unsupportedError }
        return value
    }

    private static func positive(_ text: String?, default fallback: Int?) throws -> Int {
        let value = try integer(text, default: fallback)
        guard value > 0 else { throw unsupportedError }
        return value
    }

    /// Seconds of an ISO 8601 duration `P[nD]T[nH][nM][n.nS]` (`PT12.0S`), else nil.
    static func isoDuration(_ text: String) -> Double? {
        var rest = Substring(text.trimmingCharacters(in: .whitespaces))
        guard rest.hasPrefix("P") else { return nil }
        rest = rest.dropFirst()
        var total = 0.0
        var inTime = false
        var number = ""
        var parsedAny = false
        for character in rest {
            if character == "T" {
                guard !inTime, number.isEmpty else { return nil }
                inTime = true
            } else if character.isASCIIDigit || character == "." {
                number.append(character)
            } else {
                let unit: Double
                switch (character, inTime) {
                case ("D", false): unit = 86_400
                case ("H", true): unit = 3600
                case ("M", true): unit = 60
                case ("S", true): unit = 1
                default: return nil
                }
                guard let value = Double(number) else { return nil }
                total += value * unit
                number = ""
                parsedAny = true
            }
        }
        guard number.isEmpty, parsedAny, total.isFinite else { return nil }
        return total
    }
}

private extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber }
}

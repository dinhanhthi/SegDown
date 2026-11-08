// HLS media playlists whose MPEG-TS segments hide behind a prefix (some sites serve
// `file_N.png`: a real PNG, padding, then the TS). ffmpeg's hls demuxer probes such a segment as
// an image and finds no stream to copy, and has no option to force the segment format. So the host
// downloads the segments, strips the prefix and hands ffmpeg a local playlist of its own.
// Segment bytes are untrusted: they are only scanned for the TS sync pattern and copied.
import Foundation

enum DisguisedHLS {
    /// Bytes of the first segment read to detect a disguise; also the head of each downloaded
    /// segment searched for its TS start, and its write chunk size.
    static let probeBytes = 64 * 1024
    /// Segments larger than this are rejected, also without a job size cap; real ones are a few MB.
    static let maxSegmentBytes: Int64 = 256 * 1024 * 1024
    /// Pieces in flight per job at the start (`JobRunner.downloadPieces`): 4-6 stay under CDN burst limits.
    static let parallelPieces = 4
    /// The session of `download` and `isDisguised`: ephemeral, with no cookie store and no cache, so
    /// a CDN's `Set-Cookie` is never stored or replayed and nothing is cached. Headers stay per
    /// request (`scoped`, `RedirectGuard.request`). Its connections per host stay at the default:
    /// it is shared by all jobs, and each job limits itself (`JobRunner`'s `pieceLimit`).
    static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()
    /// MPEG-TS packet size and sync byte.
    private static let packetSize = 188
    private static let syncByte: UInt8 = 0x47
    /// Segment extensions that name real media: those playlists are never probed.
    private static let mediaExtensions: Set<String> = [
        "ts", "m4s", "mp4", "m4v", "m4a", "aac", "mp3", "mpg", "mpeg", "mpegts", "fmp4", "cmfv", "cmfa",
        "ac3", "ec3", "vtt", "webvtt",
    ]

    // MARK: Detect

    /// The first offset `o` where `data[o]`, `data[o+188]` and `data[o+376]` are all the TS sync
    /// byte (three packets in a row), else nil. Offsets count from the start of `data`, also for
    /// a slice; the bytes are scanned in place, not copied.
    static func tsStart(in data: Data) -> Int? {
        data.withUnsafeBytes { bytes in
            var offset = 0
            while offset + 2 * packetSize < bytes.count {
                if bytes[offset] == syncByte, bytes[offset + packetSize] == syncByte,
                   bytes[offset + 2 * packetSize] == syncByte {
                    return offset
                }
                offset += 1
            }
            return nil
        }
    }

    /// True when `header` (a segment's first bytes) holds MPEG-TS after some prefix, and is
    /// neither plain TS (sync byte first) nor fMP4 (`ftyp`/`styp` box first).
    static func isDisguised(header: Data) -> Bool {
        let bytes = [UInt8](header)
        guard let start = tsStart(in: header), start > 0, bytes.first != syncByte else { return false }
        if bytes.count >= 8 {
            let box = String(decoding: bytes[4..<8], as: UTF8.self)
            if box == "ftyp" || box == "styp" { return false }
        }
        return true
    }

    /// True when `playlist` is a plain media playlist (`HLSPlaylist.isPlain`) whose first segment
    /// has no media extension and starts with a disguise (`isDisguised` on its first 64 KiB).
    /// Other playlists cost no request. Throws on a failed request (403/429/503: `Refused`; 410:
    /// `JobError.linkExpired`).
    static func isDisguised(
        _ playlist: HLSPlaylist, headers: [String: String], source: URL, session: URLSession = DisguisedHLS.session
    ) async throws -> Bool {
        guard !playlist.isMaster, playlist.isPlain, let first = playlist.segments.first,
              !mediaExtensions.contains(first.url.pathExtension.lowercased()) else { return false }
        let (bytes, response) = try await session.bytes(
            for: RedirectGuard.request(first.url, headers: scoped(headers, for: first.url, source: source)),
            delegate: RedirectGuard(original: first.url)
        )
        defer { bytes.task.cancel() }
        try check(response, what: "Segment")
        // Read up to probeBytes ourselves: servers may ignore a Range header.
        var header = Data()
        for try await byte in bytes {
            header.append(byte)
            if header.count >= probeBytes { break }
        }
        return isDisguised(header: header)
    }

    // MARK: Local playlist

    /// The indices of the `segments` overlapping [`start`, `end`) by cumulative `EXTINF` time,
    /// and the cumulative start time of the first one. Always the segment holding `start` (the
    /// last one when `start` is past the end) and at least one segment; empty only for no segments.
    static func window(_ segments: [HLSMediaSegment], start: Double, end: Double) -> (range: Range<Int>, offset: Double) {
        guard !segments.isEmpty else { return (0..<0, 0) }
        var starts: [Double] = []
        var time = 0.0
        for segment in segments {
            starts.append(time)
            time += segment.duration
        }
        let first = segments.indices.first { starts[$0] + segments[$0].duration > start } ?? segments.count - 1
        let last = max(segments.indices.last { starts[$0] < end } ?? first, first)
        return (first..<last + 1, starts[first])
    }

    /// The files of one staged window (`stagedFiles`).
    struct StagedFiles {
        var segments: [URL]
        var folder: URL
        var playlist: URL
        /// `<directory>/hls-init.mp4`, the fMP4 init section, when staged `withInit`; else nil.
        var initFile: URL?
    }

    /// Where one window is staged. Its `segments` (`hls-0001.<segmentExtension>`… for `count`) and
    /// `initFile` (`withInit`) download directly into `directory` (the job's temp dir), so the size
    /// cap counts them while they grow. Once all are in, they move into `folder` (`<directory>/hls/`)
    /// beside `playlist` (`hls.m3u8`): the cap lists only the top level, so a window is not counted
    /// again beside the part ffmpeg writes from it. Names the host chooses, never taken from the
    /// playlist; they do not match `part-NNN`. fMP4 segments need `m4s`: ffmpeg's `extension_picky`
    /// rejects fMP4 named `.ts`.
    static func stagedFiles(
        count: Int, in directory: URL, segmentExtension: String = "ts", withInit: Bool = false
    ) -> StagedFiles {
        let segments = (0..<count).map {
            directory.appendingPathComponent(String(format: "hls-%04d", $0 + 1) + ".\(segmentExtension)")
        }
        let folder = directory.appendingPathComponent("hls", isDirectory: true)
        return StagedFiles(
            segments: segments, folder: folder, playlist: folder.appendingPathComponent("hls.m3u8"),
            initFile: withInit ? directory.appendingPathComponent("hls-init.mp4") : nil
        )
    }

    /// The text of a VOD media playlist listing `fileNames` (relative to the playlist's directory)
    /// with `durations`, and `mapFileName` as its `EXT-X-MAP` init section when given. Formatting
    /// never depends on the locale.
    static func playlist(durations: [Double], fileNames: [String], mapFileName: String? = nil) -> String {
        // Clamped before the Int conversion: durations come from an untrusted playlist.
        let target = Int(min(durations.max() ?? 0, 1e9).rounded(.up))
        let version = mapFileName == nil ? 3 : 7
        var text = "#EXTM3U\n#EXT-X-VERSION:\(version)\n#EXT-X-TARGETDURATION:\(target)\n#EXT-X-PLAYLIST-TYPE:VOD\n"
        if let mapFileName {
            text += "#EXT-X-MAP:URI=\"\(mapFileName)\"\n"
        }
        for (duration, name) in zip(durations, fileNames) {
            // String(format:) without a locale is not localized: always a `.` separator.
            text += "#EXTINF:\(String(format: "%.6f", duration)),\n\(name)\n"
        }
        return text + "#EXT-X-ENDLIST\n"
    }

    // MARK: Download

    /// A request the server refused for now (HTTP 403, 429 or 503), with its `Retry-After` in
    /// seconds when it gave one as delta-seconds. `JobRunner.downloadPieces` backs off on it, and
    /// turns a 403 it gives up on into `JobError.linkExpired`. Not a `JobError` case: those go on the wire.
    struct Refused: Error {
        var status: Int
        var retryAfter: Double?
    }

    /// One file to download (`download`): `segment` into `file`, `number` its 1-based playlist or
    /// manifest position for the errors (0 for an init section).
    struct Piece: Sendable {
        var segment: HLSMediaSegment
        var number: Int
        var file: URL
        var stripPrefix: Bool
    }

    /// Downloads `segment` (playlist position `number`, 1-based, for the errors) into `file`
    /// without the bytes before its MPEG-TS start (`stripPrefix`; else the bytes as they come, with
    /// no scan). The bytes arrive in chunks from a data-task delegate (`SegmentReceiver`), not one
    /// by one. Only the first `probeBytes` (plus the chunks not yet written) are held in memory to
    /// find that start; the rest streams into `file` in chunks, so the job's size cap, which watches
    /// the temp dir, and a cancel can stop it. Throws when it is larger than `maxSegmentBytes`, holds
    /// no MPEG-TS (`stripPrefix`), or the task is cancelled. On a throw `file` may hold a partial
    /// segment: the caller removes it.
    static func download(
        _ segment: HLSMediaSegment, number: Int, headers: [String: String], source: URL, to file: URL,
        stripPrefix: Bool = true, session: URLSession = DisguisedHLS.session
    ) async throws {
        let (events, continuation) = AsyncThrowingStream.makeStream(of: SegmentReceiver.Event.self)
        let task = session.dataTask(
            with: RedirectGuard.request(segment.url, headers: scoped(headers, for: segment.url, source: source))
        )
        task.delegate = SegmentReceiver(original: segment.url, continuation: continuation)
        continuation.onTermination = { _ in task.cancel() }
        task.resume()
        defer { task.cancel() }
        let tooLarge = JobError.invalid("Segment \(number) is larger than \(maxSegmentBytes) bytes")

        // Opened once the response is checked.
        var handle: FileHandle?
        defer { try? handle?.close() }
        // The first probeBytes until the TS start is found in them, then the next chunk to write.
        var buffer = Data()
        var foundStart = false
        func flush() throws {
            guard let handle else { throw JobError.processFailed("Segment \(number) response is not HTTP") }
            var start = 0
            if stripPrefix, !foundStart {
                guard let offset = tsStart(in: buffer.prefix(probeBytes)) else {
                    throw JobError.processFailed("Segment \(number) is not MPEG-TS")
                }
                start = offset
                foundStart = true
            }
            try handle.write(contentsOf: buffer.dropFirst(start))
            buffer.removeAll(keepingCapacity: true)
        }
        var received: Int64 = 0
        for try await event in events {
            switch event {
            case let .response(response):
                try check(response, what: "Segment \(number)")
                guard response.expectedContentLength <= maxSegmentBytes else { throw tooLarge }
                guard FileManager.default.createFile(atPath: file.path, contents: nil) else {
                    throw JobError.processFailed("Cannot create \(file.lastPathComponent)")
                }
                handle = try FileHandle(forWritingTo: file)
            case let .data(chunk):
                received += Int64(chunk.count)
                if received > maxSegmentBytes { throw tooLarge }
                buffer.append(contentsOf: chunk)
                if buffer.count >= probeBytes { try flush() }
            }
        }
        // A cancel ends the stream without an error: never write it as a whole segment.
        try Task.checkCancellation()
        try flush()
    }

    /// The delegate of one `download` data task: yields its response and its body chunks into a
    /// stream, finishes it when the task completes (throwing its error), and keeps `RedirectGuard`
    /// on its redirects.
    private final class SegmentReceiver: NSObject, URLSessionDataDelegate, Sendable {
        enum Event: Sendable {
            case response(URLResponse)
            case data(Data)
        }

        private let redirectGuard: RedirectGuard
        private let continuation: AsyncThrowingStream<Event, Error>.Continuation

        init(original: URL, continuation: AsyncThrowingStream<Event, Error>.Continuation) {
            redirectGuard = RedirectGuard(original: original)
            self.continuation = continuation
        }

        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest
        ) async -> URLRequest? {
            await redirectGuard.urlSession(
                session, task: task, willPerformHTTPRedirection: response, newRequest: request
            )
        }

        func urlSession(
            _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse
        ) async -> URLSession.ResponseDisposition {
            continuation.yield(.response(response))
            return .allow
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            continuation.yield(.data(data))
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            continuation.finish(throwing: error)
        }
    }

    // MARK: Helpers

    /// `headers` without `Cookie` unless `url` is on `source`'s origin, as for ffmpeg's `-cookies`.
    static func scoped(_ headers: [String: String], for url: URL, source: URL) -> [String: String] {
        RedirectGuard.sameOrigin(url, source) ? headers : headers.filter { $0.key != "Cookie" }
    }

    /// Throws unless `response` is HTTP 2xx, as `HLSPlaylist.fetch` does: `Refused` for 403, 429
    /// and 503, `JobError.linkExpired` for 410.
    private static func check(_ response: URLResponse, what: String) throws {
        guard let http = response as? HTTPURLResponse else {
            throw JobError.processFailed("\(what) response is not HTTP")
        }
        switch http.statusCode {
        case 200..<300: break
        case 403, 429, 503: throw Refused(status: http.statusCode, retryAfter: retryAfter(http))
        case 410: throw JobError.linkExpired
        default: throw JobError.processFailed("\(what) request failed with HTTP \(http.statusCode)")
        }
    }

    /// `Retry-After` as delta-seconds (finite, not negative); nil for an HTTP-date or anything else.
    private static func retryAfter(_ response: HTTPURLResponse) -> Double? {
        guard let text = response.value(forHTTPHeaderField: "Retry-After"),
              let seconds = Double(text.trimmingCharacters(in: .whitespaces)),
              seconds.isFinite, seconds >= 0 else { return nil }
        return seconds
    }
}

/// How `JobRunner` stages an HLS media playlist itself: its `segments`, its `EXT-X-MAP` init
/// section (`mapURL`, fMP4), and whether each segment's bytes before the MPEG-TS start are
/// stripped (`DisguisedHLS.download`), as for disguised TS, or kept as they come.
struct StagedHLS {
    var segments: [HLSMediaSegment]
    var mapURL: URL?
    var stripPrefix: Bool
}

// Guards the disguised-HLS path: detecting TS behind a prefix, the segment window, the parsed
// segments it relies on, and the ffmpeg argv for the host-written local playlist.
import Foundation
import Testing
@testable import SegDownCore

struct DisguisedHLSTests {
    private let source = URL(string: "https://cdn.example.com/v/index.m3u8")!
    private let output = URL(fileURLWithPath: "/tmp/job/part-001.mp4")

    private func segmentArgs(input: URL, kind: MediaKind = .hls) -> [String] {
        CommandBuilder.ffmpegSegment(
            input: input,
            kind: kind,
            audio: nil,
            headers: ["Referer": "https://example.com/", "User-Agent": "UA", "Cookie": "a=b"],
            source: source,
            segment: Segment(start: 3, end: 8),
            precision: .fast,
            output: output
        )
    }

    /// `packets` MPEG-TS packets (sync byte, then zeros).
    private func tsPackets(packets: Int = 3) -> Data {
        var packet = Data(repeating: 0x00, count: 188)
        packet[0] = 0x47
        return Data((0..<packets).flatMap { _ in packet })
    }

    /// `prefix` padded with 0xFF to `offset`, then `packets` TS packets.
    private func disguised(prefix: [UInt8], offset: Int, packets: Int = 3) -> Data {
        Data(prefix) + Data(repeating: 0xFF, count: offset - prefix.count) + tsPackets(packets: packets)
    }

    // MARK: CommandBuilder

    @Test func fileInputGetsOnlyFileWhitelistAndNoHeaders() {
        let args = segmentArgs(input: URL(fileURLWithPath: "/tmp/x/hls.m3u8"))
        let expected = ["-protocol_whitelist", "file", "-f", "hls", "-ss", "3.000", "-i", "/tmp/x/hls.m3u8"]
        let found = args.indices.contains { start in
            start + expected.count <= args.count && Array(args[start..<start + expected.count]) == expected
        }
        #expect(found)
        for option in [
            "-extension_picky", "-user_agent", "-headers", "-cookies", "-reconnect", "-multiple_requests",
            "-seg_max_retry",
        ] {
            #expect(!args.contains(option))
        }

        // A joined DASH track gets a forced demuxer from its host-chosen name, never `hls`.
        let dash = segmentArgs(input: URL(fileURLWithPath: "/tmp/x/dash/video.mp4"), kind: .dash)
        let dashExpected = ["-protocol_whitelist", "file", "-f", "mov", "-ss", "3.000", "-i", "/tmp/x/dash/video.mp4"]
        #expect(dash.indices.contains { start in
            start + dashExpected.count <= dash.count && Array(dash[start..<start + dashExpected.count]) == dashExpected
        })
        #expect(!dash.contains("hls"))
        for option in [
            "-extension_picky", "-user_agent", "-headers", "-cookies", "-reconnect", "-multiple_requests",
            "-seg_max_retry",
        ] {
            #expect(!dash.contains(option))
        }
    }

    @Test func remoteInputWhitelistExcludesFile() throws {
        let args = segmentArgs(input: source)
        let whitelist = try #require(args.firstIndex(of: "-protocol_whitelist"))
        #expect(!args[whitelist + 1].split(separator: ",").contains("file"))
    }

    // MARK: Detect

    @Test func pngPrefixedTSIsDisguised() {
        let png: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]
        let data = disguised(prefix: png, offset: 230)
        #expect(DisguisedHLS.tsStart(in: data) == 230)
        #expect(DisguisedHLS.isDisguised(header: data))
    }

    @Test func plainTSAndFMP4AreNotDisguised() {
        #expect(DisguisedHLS.tsStart(in: tsPackets()) == 0)
        #expect(!DisguisedHLS.isDisguised(header: tsPackets()))
        let ftyp: [UInt8] = [0x00, 0x00, 0x00, 0x20] + Array("ftyp".utf8)
        #expect(!DisguisedHLS.isDisguised(header: disguised(prefix: ftyp, offset: 230)))
    }

    @Test func tsStartInSliceIsRelativeToSlice() {
        let data = Data(repeating: 0xFF, count: 100) + disguised(prefix: [0x89], offset: 230)
        let slice = data.dropFirst(100)
        #expect(slice.startIndex == 100)
        #expect(DisguisedHLS.tsStart(in: slice) == 230)
    }

    // MARK: Window

    @Test func windowCoversOverlappingSegments() {
        let url = URL(string: "https://cdn.example.com/s.png")!
        let segments = Array(repeating: HLSMediaSegment(url: url, duration: 5), count: 4)

        let middle = DisguisedHLS.window(segments, start: 7, end: 12)
        #expect(middle.range == 1..<3)
        #expect(middle.offset == 5)

        let first = DisguisedHLS.window(segments, start: 0, end: 3)
        #expect(first.range == 0..<1)
        #expect(first.offset == 0)

        let past = DisguisedHLS.window(segments, start: 25, end: 30)
        #expect(past.range == 3..<4)
        #expect(past.offset == 15)
    }

    /// Source times map onto a local playlist without the skipped segments; a time inside a
    /// skipped one snaps to the next kept segment's start.
    @Test func localTimeSkipsEmptySegments() {
        let url = URL(string: "https://cdn.example.com/s.png")!
        let segments = Array(repeating: HLSMediaSegment(url: url, duration: 5), count: 6)
        let local = { DisguisedHLS.localTime($0, segments: segments, range: 1..<5, skipped: [2, 4]) }
        #expect(local(7) == 2)
        #expect(local(12) == 5)
        #expect(local(17) == 7)
        #expect(local(24) == 10)
        #expect(DisguisedHLS.localTime(7, segments: segments, range: 1..<5, skipped: []) == 2)
    }

    @Test func emptyWarningNamesTheSkippedSegments() {
        #expect(DisguisedHLS.emptyWarning([:]) == nil)
        #expect(DisguisedHLS.emptyWarning([4: 90]) == "Segment 4 has no video data "
            + "(the server returned only a 90-byte image); this video is broken on the site")
        #expect(DisguisedHLS.emptyWarning([11: 90, 4: 90]) == "Segments 4, 11 have no video data "
            + "(the server returned only 90-byte images); this video is broken on the site")
        #expect(DisguisedHLS.emptyWarning([4: 90, 5: 120])?.contains("returned only images") == true)
    }

    /// The size cap counts staged segments while they download, and no longer once they move into
    /// the playlist's folder, so a window is never counted next to the part ffmpeg writes from it.
    @Test func stagedSegmentsAreCountedAndPlaylistFolderIsNot() throws {
        let fileManager = FileManager.default
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("SegDownTests-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: directory) }
        let files = DisguisedHLS.stagedFiles(count: 2, in: directory)
        #expect(files.playlist.deletingLastPathComponent().path == files.folder.path)
        for segment in files.segments {
            try Data(count: 1000).write(to: segment)
        }
        try Data(count: 300).write(to: directory.appendingPathComponent(CommandBuilder.partFileName(index: 1)))
        #expect(SizeEstimate.countedBytes(in: directory) == 2300)

        try fileManager.createDirectory(at: files.folder, withIntermediateDirectories: true)
        for segment in files.segments {
            try fileManager.moveItem(at: segment, to: files.folder.appendingPathComponent(segment.lastPathComponent))
        }
        #expect(SizeEstimate.countedBytes(in: directory) == 300)
    }

    // MARK: Parse

    @Test func parseReadsSegmentsAndPlainness() throws {
        let media = """
        #EXTM3U
        #EXT-X-TARGETDURATION:5
        #EXTINF:5.0,
        seg/file_0.png
        #EXTINF:4,title
        https://other.example.com/file_1.png
        #EXT-X-ENDLIST
        """
        let playlist = try HLSPlaylist.parse(media, baseURL: source)
        #expect(!playlist.isMaster)
        #expect(playlist.isPlain)
        #expect(playlist.segments.map(\.url.absoluteString) == [
            "https://cdn.example.com/v/seg/file_0.png", "https://other.example.com/file_1.png",
        ])
        #expect(playlist.segments.map(\.duration) == [5, 4])

        let keyed = media.replacingOccurrences(of: "#EXT-X-TARGETDURATION:5", with: "#EXT-X-KEY:METHOD=AES-128,URI=\"k\"")
        #expect(try !HLSPlaylist.parse(keyed, baseURL: source).isPlain)
        let unkeyed = media.replacingOccurrences(of: "#EXT-X-TARGETDURATION:5", with: "#EXT-X-KEY:METHOD=NONE")
        #expect(try HLSPlaylist.parse(unkeyed, baseURL: source).isPlain)

        let fragmented = """
        #EXTM3U
        #EXT-X-MAP:URI="init.mp4"
        #EXTINF:4,
        seg-1.m4s
        #EXTINF:4,
        blob:https://example.com/0b1c
        #EXT-X-ENDLIST
        """
        let mapped = try HLSPlaylist.parse(fragmented, baseURL: source)
        #expect(!mapped.isPlain)
        #expect(mapped.mapURL?.absoluteString == "https://cdn.example.com/v/init.mp4")
        #expect(mapped.mapCount == 1)
        #expect(mapped.skippedURIs == 1)
        #expect(mapped.segments.map(\.url.absoluteString) == ["https://cdn.example.com/v/seg-1.m4s"])

        let text = DisguisedHLS.playlist(durations: [4], fileNames: ["hls-0001.m4s"], mapFileName: "hls-init.mp4")
        #expect(text.contains("#EXT-X-VERSION:7\n"))
        #expect(text.contains("#EXT-X-MAP:URI=\"hls-init.mp4\"\n#EXTINF:"))
    }

    // MARK: Download

    /// The body arrives in 10 000-byte chunks and is longer than `probeBytes`: the TS start is found
    /// across chunks and the rest is written as it comes.
    @Test func downloadStripsPrefixAcrossChunks() async throws {
        let fileManager = FileManager.default
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("SegDownTests-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: directory) }
        let session = StubProtocol.session()
        defer { session.invalidateAndCancel() }
        func download(_ path: String, to name: String, stripPrefix: Bool = true) async throws -> URL {
            let file = directory.appendingPathComponent(name)
            try await DisguisedHLS.download(
                HLSMediaSegment(url: URL(string: "https://cdn.example.com\(path)")!, duration: 4), number: 1,
                headers: [:], source: source, to: file, stripPrefix: stripPrefix, session: session
            )
            return file
        }

        let png: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
        let stripped = try await download("/seg.png", to: "stripped.ts")
        #expect(try Data(contentsOf: stripped) == tsPackets(packets: 400))
        let kept = try await download("/seg.png", to: "kept.ts", stripPrefix: false)
        #expect(try Data(contentsOf: kept) == disguised(prefix: png, offset: 1000, packets: 400))

        // A 429 is refused for now, with its `Retry-After`, for `JobRunner`'s back-off; a 410 is final.
        let refused = await #expect(throws: DisguisedHLS.Refused.self) {
            _ = try await download("/busy", to: "busy.ts")
        }
        #expect(refused?.status == 429)
        #expect(refused?.retryAfter == 3)
        await #expect(throws: JobError.linkExpired) {
            _ = try await download("/gone", to: "gone.ts")
        }

        // A bare image with no TS: an empty segment, skipped by `JobRunner`.
        let empty = await #expect(throws: DisguisedHLS.EmptySegment.self) {
            _ = try await download("/empty.png", to: "empty.ts")
        }
        #expect(empty?.bytes == 90)
        // A short body that is no image (an error page) still fails: it is not the cover alone.
        await #expect(throws: JobError.processFailed("Segment 1 is not MPEG-TS")) {
            _ = try await download("/error", to: "error.ts")
        }
    }
}

/// Answers requests by URL path with fixed bodies, sent in 10 000-byte `didLoad` calls. Registered
/// only on its own ephemeral session (`session()`), never globally.
private final class StubProtocol: URLProtocol, @unchecked Sendable {
    private struct Route: Sendable {
        var status: Int
        var headers: [String: String] = [:]
        var body = Data()
    }

    private static let routes: [String: Route] = {
        var packet = Data(repeating: 0x00, count: 188)
        packet[0] = 0x47
        // A PNG signature, 0xFF padding to 1 000 bytes, then 400 TS packets (more than `probeBytes`).
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        let segment = png + Data(repeating: 0xFF, count: 1000 - png.count) + Data((0..<400).flatMap { _ in packet })
        return [
            "/seg.png": Route(status: 200, body: segment),
            "/busy": Route(status: 429, headers: ["Retry-After": "3"]),
            "/gone": Route(status: 410),
            "/empty.png": Route(status: 200, body: png + Data(repeating: 0x00, count: 82)),
            "/error": Route(status: 200, body: Data("<html>Too many requests</html>".utf8)),
        ]
    }()

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let route = Self.routes[url.path] else {
            client?.urlProtocol(self, didFailWithError: URLError(.fileDoesNotExist))
            return
        }
        var headers = route.headers
        headers["Content-Length"] = String(route.body.count)
        let response = HTTPURLResponse(url: url, statusCode: route.status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        var offset = 0
        while offset < route.body.count {
            let end = min(offset + 10_000, route.body.count)
            client?.urlProtocol(self, didLoad: route.body.subdata(in: offset..<end))
            offset = end
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

// Guards the disguised-HLS path: detecting TS behind a prefix, the segment window, the parsed
// segments it relies on, and the ffmpeg argv for the host-written local playlist.
import Foundation
import Testing
@testable import SegDownCore

struct DisguisedHLSTests {
    private let source = URL(string: "https://cdn.example.com/v/index.m3u8")!
    private let output = URL(fileURLWithPath: "/tmp/job/part-001.mp4")

    private func segmentArgs(input: URL) -> [String] {
        CommandBuilder.ffmpegSegment(
            input: input,
            kind: .hls,
            audio: nil,
            headers: ["Referer": "https://example.com/", "User-Agent": "UA", "Cookie": "a=b"],
            source: source,
            segment: Segment(start: 3, end: 8),
            precision: .fast,
            output: output
        )
    }

    /// Three MPEG-TS packets (sync byte, then zeros).
    private func tsPackets() -> Data {
        var packet = Data(repeating: 0x00, count: 188)
        packet[0] = 0x47
        return packet + packet + packet
    }

    /// `prefix` padded with 0xFF to `offset`, then three TS packets.
    private func disguised(prefix: [UInt8], offset: Int) -> Data {
        Data(prefix) + Data(repeating: 0xFF, count: offset - prefix.count) + tsPackets()
    }

    // MARK: CommandBuilder

    @Test func fileInputGetsOnlyFileWhitelistAndNoHeaders() {
        let args = segmentArgs(input: URL(fileURLWithPath: "/tmp/x/hls.m3u8"))
        let expected = ["-protocol_whitelist", "file", "-f", "hls", "-ss", "3.000", "-i", "/tmp/x/hls.m3u8"]
        let found = args.indices.contains { start in
            start + expected.count <= args.count && Array(args[start..<start + expected.count]) == expected
        }
        #expect(found)
        for option in ["-extension_picky", "-user_agent", "-headers", "-cookies"] {
            #expect(!args.contains(option))
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
    }
}

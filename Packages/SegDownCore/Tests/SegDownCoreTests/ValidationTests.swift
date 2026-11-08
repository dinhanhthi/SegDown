// Guards the security boundary: everything from the extension passes through Validation.
import Foundation
import Testing
@testable import SegDownCore

struct ValidationTests {
    private func hlsRequest(url: String = "https://cdn.example.com/master.m3u8", headers: [String: String]) -> JobRequest {
        JobRequest(
            source: .media(url: URL(string: url)!, kind: .hls, headers: headers, variantURL: nil, audioURL: nil),
            title: "Clip",
            segments: [Segment(start: 10, end: 20)],
            mode: .separate,
            precision: .precise
        )
    }

    @Test func acceptsValidHLSRequest() throws {
        let validated = try Validation.validate(hlsRequest(headers: ["referer": "https://example.com/"]))
        guard case let .media(_, _, headers, _, _) = validated.source else {
            Issue.record("Expected a media source")
            return
        }
        #expect(headers == ["Referer": "https://example.com/"])
    }

    @Test func rejectsNonHTTPURL() {
        #expect(throws: JobError.self) {
            try Validation.validate(hlsRequest(url: "file:///etc/passwd", headers: [:]))
        }
    }

    @Test func rejectsNonAllowlistedHeader() {
        #expect(throws: JobError.self) {
            try Validation.validate(hlsRequest(headers: ["Authorization": "Bearer x"]))
        }
    }

    @Test func rejectsHeaderValueWithCRLF() {
        #expect(throws: JobError.self) {
            try Validation.validate(hlsRequest(headers: ["Referer": "https://example.com/\r\nX-Evil: 1"]))
        }
    }

    @Test func rejectsHugeFiniteSegmentEnd() {
        var request = hlsRequest(headers: [:])
        request.segments = [Segment(start: 0, end: 1e19)]
        #expect(throws: JobError.self) {
            try Validation.validate(request)
        }
    }

    @Test func checkRejectsTotalDurationOverMax() throws {
        var request = hlsRequest(headers: [:])
        request.segments = [Segment(start: 0, end: 10), Segment(start: 20, end: 40)]
        try Validation.check(request, limits: JobLimits(maxDuration: 30))
        #expect(throws: JobError.self) {
            try Validation.check(request, limits: JobLimits(maxDuration: 29))
        }
    }

    @Test func fallbackIsValidatedLikeASource() throws {
        let page = Source.page(url: URL(string: "https://example.com/watch")!)
        func media(_ url: String, headers: [String: String]) -> Source {
            .media(url: URL(string: url)!, kind: .hls, headers: headers, variantURL: nil, audioURL: nil)
        }
        func request(source: Source, fallback: Source) -> JobRequest {
            JobRequest(
                source: source, title: "Clip", segments: [Segment(start: 10, end: 20)],
                mode: .separate, precision: .precise, fallback: fallback
            )
        }

        let validated = try Validation.validate(request(
            source: page, fallback: media("https://cdn.example.com/master.m3u8", headers: ["referer": "https://example.com/"])
        ))
        guard case let .media(_, _, headers, _, _)? = validated.fallback else {
            Issue.record("Expected a media fallback")
            return
        }
        #expect(headers == ["Referer": "https://example.com/"])

        let playlist = Source.playlist(
            text: "#EXTM3U\n", baseURL: URL(string: "https://cdn.example.com/1.ts")!,
            headers: ["referer": "https://example.com/"]
        )
        let validatedPlaylist = try Validation.validate(request(source: page, fallback: playlist))
        guard case let .playlist(_, _, playlistHeaders)? = validatedPlaylist.fallback else {
            Issue.record("Expected a playlist fallback")
            return
        }
        #expect(playlistHeaders == ["Referer": "https://example.com/"])

        let rejected = [
            request(source: page, fallback: media("https://cdn.example.com/master.m3u8", headers: ["Authorization": "Bearer x"])),
            request(source: page, fallback: media("file:///etc/passwd", headers: [:])),
            request(source: page, fallback: page),
            request(source: media("https://cdn.example.com/a.m3u8", headers: [:]), fallback: media("https://cdn.example.com/b.m3u8", headers: [:])),
        ]
        for request in rejected {
            #expect(throws: JobError.self) {
                try Validation.validate(request)
            }
        }
    }

    @Test func playlistSourceNeedsAnHTTPBaseURLAndASmallHLSText() throws {
        func request(_ text: String, baseURL: String = "https://cdn.example.com/1.ts") -> JobRequest {
            JobRequest(
                source: .playlist(text: text, baseURL: URL(string: baseURL)!, headers: [:]), title: "Clip",
                segments: [Segment(start: 10, end: 20)], mode: .separate, precision: .precise
            )
        }
        let small = "#EXTM3U\n#EXTINF:4,\nhttps://cdn.example.com/1.ts\n"

        #expect(try Validation.validate(request(small)).source == request(small).source)
        #expect(throws: JobError.invalid("The playlist is larger than 256 KB")) {
            try Validation.validate(request(small + String(repeating: "#", count: Validation.maxInlinePlaylistBytes)))
        }
        #expect(throws: JobError.invalid("baseURL must use http or https")) {
            try Validation.validate(request(small, baseURL: "file:///etc/passwd"))
        }
    }

    @Test func handoffNeedsAnHTTPLinkWithoutCredentialsWithinTheCap() throws {
        let link = URL(string: "https://example.com/v.mp4")!
        #expect(try Validation.validateHandoff(link) == link)

        let long = "https://example.com/" + String(repeating: "a", count: 9000)
        for bad in ["file:///etc/passwd", "https://user:pw@example.com/v.mp4", long] {
            #expect(throws: JobError.self) {
                try Validation.validateHandoff(URL(string: bad)!)
            }
        }
    }

    @Test func maxHeightNeedsAPageSourceAndARange() throws {
        let page = JobRequest(
            source: .page(url: URL(string: "https://example.com/watch")!), title: "Clip",
            segments: [Segment(start: 10, end: 20)], mode: .separate, precision: .precise, maxHeight: 720
        )
        #expect(try Validation.validate(page).maxHeight == 720)

        var zero = page
        zero.maxHeight = 0
        var media = hlsRequest(headers: [:])
        media.maxHeight = 720
        for request in [zero, media] {
            #expect(throws: JobError.self) {
                try Validation.validate(request)
            }
        }
    }

    @Test func traversalTitleStaysOneComponentUnderBase() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("SegDown", isDirectory: true)
        let directory = try PathSanitizer.outputDirectory(title: "../../etc/x", base: base)
        #expect(directory.deletingLastPathComponent().path == base.standardizedFileURL.path)
    }
}

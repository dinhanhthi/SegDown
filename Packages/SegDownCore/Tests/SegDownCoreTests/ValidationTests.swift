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

    @Test func traversalTitleStaysOneComponentUnderBase() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("SegDown", isDirectory: true)
        let directory = try PathSanitizer.outputDirectory(title: "../../etc/x", base: base)
        #expect(directory.deletingLastPathComponent().path == base.standardizedFileURL.path)
    }
}

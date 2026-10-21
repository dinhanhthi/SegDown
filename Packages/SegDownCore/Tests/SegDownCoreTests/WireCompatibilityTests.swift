// Guards the wire contract between peers of different versions: the Chromium extension is loaded
// separately from the app, so an older extension talks to a newer app and the other way round.
import Foundation
import Testing
@testable import SegDownCore

struct WireCompatibilityTests {
    @Test func enqueueFromProtocol1ExtensionDecodesWithNewKeysNil() throws {
        // Exactly what extension/background.js `onDownload` sends today.
        let line = #"{"type":"enqueue","job":{"source":{"type":"media","url":"https://example.com/v.m3u8","kind":"hls","headers":{"Referer":"https://example.com/"}},"title":"T","segments":[{"start":1,"end":2}],"mode":"separate","precision":"precise"}}"#

        let request = try IPC.decodeLine(IPCRequest.self, from: Data((line + "\n").utf8))

        guard case let .enqueue(job) = request else {
            Issue.record("expected .enqueue, got \(request)")
            return
        }
        #expect(job.source == .media(
            url: try #require(URL(string: "https://example.com/v.m3u8")),
            kind: .hls,
            headers: ["Referer": "https://example.com/"],
            variantURL: nil,
            audioURL: nil
        ))
        #expect(job.title == "T")
        #expect(job.segments == [Segment(start: 1, end: 2)])
        #expect(job.mode == .separate)
        #expect(job.precision == .precise)
        #expect(job.incognito == nil)
        #expect(job.fallback == nil)
        #expect(job.mediaDuration == nil)
        #expect(job.pageURL == nil)
        #expect(job.maxHeight == nil)
    }

    @Test func enqueueWithMaxHeightDecodesAndReencodesTheKey() throws {
        let line = #"{"type":"enqueue","job":{"source":{"type":"page","url":"https://example.com/watch"},"title":"T","segments":[{"start":1,"end":2}],"mode":"separate","precision":"precise","maxHeight":720}}"#

        let request = try IPC.decodeLine(IPCRequest.self, from: Data(line.utf8))

        guard case let .enqueue(job) = request else {
            Issue.record("expected .enqueue, got \(request)")
            return
        }
        #expect(job.maxHeight == 720)
        #expect(String(decoding: try IPC.encodeLine(request), as: UTF8.self).contains(#""maxHeight":720"#))
    }

    @Test func pongFromProtocol1AppDecodesAsProtocol1WithoutSettings() throws {
        let line = #"{"type":"pong","version":"0.1.0","missing":[]}"#

        let response = try IPC.decodeLine(IPCResponse.self, from: Data(line.utf8))

        #expect(response == .pong(version: "0.1.0", missing: [], protocol: 1, settings: nil))
    }

    @Test func pongWithSettingsRoundTripsAndSendsTheCurrentProtocol() throws {
        let pong = IPCResponse.pong(
            version: "1.0",
            missing: ["deno"],
            protocol: IPC.protocolVersion,
            settings: ClientSettings(
                mode: .merged,
                incognitoDefault: true,
                maxDuration: 600,
                fullClipButton: false,
                playerButton: false,
                preferredHeight: 1080
            )
        )

        let line = try IPC.encodeLine(pong)

        #expect(String(decoding: line, as: UTF8.self).contains(#""protocol":\#(IPC.protocolVersion)"#))
        #expect(String(decoding: line, as: UTF8.self).contains(#""preferredHeight":1080"#))
        #expect(try IPC.decodeLine(IPCResponse.self, from: line) == pong)
    }

    @Test func protocol2PongWithoutButtonKeysDecodesWithBothButtonsOn() throws {
        let line = #"{"type":"pong","version":"0.2.1","missing":[],"protocol":2,"settings":{"mode":"separate","incognitoDefault":false}}"#

        let response = try IPC.decodeLine(IPCResponse.self, from: Data(line.utf8))

        guard case let .pong(_, _, _, settings) = response else {
            Issue.record("expected .pong, got \(response)")
            return
        }
        let decoded = try #require(settings)
        #expect(decoded.fullClipButton)
        #expect(decoded.playerButton)
        #expect(decoded.maxDuration == nil)
        #expect(decoded.preferredHeight == nil)
    }

    @Test func formatsRoundTripsWithItsType() throws {
        let formats = IPCResponse.formats(heights: [1080, 720])

        let line = try IPC.encodeLine(formats)

        #expect(String(decoding: line, as: UTF8.self).contains(#""type":"formats""#))
        #expect(try IPC.decodeLine(IPCResponse.self, from: line) == formats)
    }

    @Test func statusWithoutBytesAndFallbackUsedDecodesAndNilKeysAreOmitted() throws {
        let line = #"{"type":"status","jobs":[{"id":"j1","state":"running","segmentIndex":0,"segmentCount":2,"fraction":0.5,"outputs":[]}]}"#

        let response = try IPC.decodeLine(IPCResponse.self, from: Data(line.utf8))

        #expect(response == .status([
            JobStatus(id: "j1", state: .running, segmentIndex: 0, segmentCount: 2, fraction: 0.5),
        ]))

        let encoded = try IPC.encodeLine(JobStatus(id: "j1", state: .running, segmentCount: 2))
        let object = try #require(try JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(object["bytes"] == nil)
        #expect(object["fallbackUsed"] == nil)
        #expect(object["id"] as? String == "j1")
    }
}

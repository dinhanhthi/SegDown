// Guards the native messaging boundary: what Chrome sends to segdown-host is untrusted.
import Foundation
import Testing
@testable import SegDownCore

struct NativeMessagingTests {
    @Test func readsValidFrameAndRejectsOversizeAndTruncatedFrames() throws {
        let frame = try NativeMessaging.encodeFrame(Data(#"{"type":"ping"}"#.utf8))
        try withPipe(containing: frame) { fd in
            let payload = try #require(try NativeMessaging.readFrame(from: fd))
            #expect(try NativeMessaging.decodeRequest(payload) == .ping)
            #expect(try NativeMessaging.readFrame(from: fd) == nil)
        }

        // 1 MB + 1 declared, no body: rejected from the prefix alone, before reading the body.
        try withPipe(containing: Data([0x01, 0x00, 0x10, 0x00])) { fd in
            #expect(throws: NativeMessagingError.frameTooLarge(1024 * 1024 + 1)) {
                try NativeMessaging.readFrame(from: fd)
            }
        }

        // 10 bytes declared, 3 present before EOF.
        try withPipe(containing: Data([0x0A, 0x00, 0x00, 0x00]) + Data("{}x".utf8)) { fd in
            #expect(throws: NativeMessagingError.truncated) {
                try NativeMessaging.readFrame(from: fd)
            }
        }
    }

    /// Runs `body` with the read end of a pipe holding `bytes` followed by EOF; closes both ends.
    private func withPipe(containing bytes: Data, _ body: (Int32) throws -> Void) throws {
        var fds: [Int32] = [-1, -1]
        try #require(pipe(&fds) == 0)
        let (readEnd, writeEnd) = (fds[0], fds[1])
        defer { close(readEnd) }
        let written = bytes.withUnsafeBytes { write(writeEnd, $0.baseAddress, $0.count) }
        close(writeEnd)
        try #require(written == bytes.count)
        try body(readEnd)
    }
}

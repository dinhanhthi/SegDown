// Chrome native messaging framing, used by segdown-host on stdin/stdout (and later the Safari
// handler). Each message is a 4-byte little-endian length followed by that many bytes of UTF-8
// JSON. Inbound frames are capped at `maxFrameBytes` before any allocation; Chrome itself refuses
// host messages above 1 MB.
import Foundation

/// Framing errors. Descriptions never include the payload.
public enum NativeMessagingError: Error, Sendable, Hashable {
    /// The frame length (from the prefix, or of the payload to send) exceeds `maxFrameBytes`.
    case frameTooLarge(Int)
    /// The input ended inside the length prefix or the body.
    case truncated
    /// A system call failed with `errno`.
    case system(String, errno: Int32)
}

extension NativeMessagingError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case let .frameTooLarge(length):
            return "Message is \(length) bytes; the limit is \(NativeMessaging.maxFrameBytes)"
        case .truncated: return "Message ended before its declared length"
        case let .system(operation, code): return "\(operation) failed: \(String(cString: strerror(code)))"
        }
    }
}

public enum NativeMessaging {
    /// Same cap as an IPC line. A frame of exactly this size is accepted.
    public static let maxFrameBytes = IPC.maxLineBytes
    static let headerBytes = 4

    /// `payload` with its 4-byte little-endian length prefix.
    public static func encodeFrame(_ payload: Data) throws -> Data {
        guard payload.count <= maxFrameBytes else { throw NativeMessagingError.frameTooLarge(payload.count) }
        var frame = withUnsafeBytes(of: UInt32(payload.count).littleEndian) { Data($0) }
        frame.append(payload)
        return frame
    }

    /// Reads exactly one frame from `fd` (blocking) and returns its payload, or `nil` on a clean
    /// end of input before the first byte. The length is checked before the body is allocated.
    public static func readFrame(from fd: Int32) throws -> Data? {
        var header = Data(count: headerBytes)
        let headerRead = try readFully(fd, into: &header)
        if headerRead == 0 { return nil }
        guard headerRead == headerBytes else { throw NativeMessagingError.truncated }
        let length = try checkedLength(header)
        var body = Data(count: length)
        guard try readFully(fd, into: &body) == length else { throw NativeMessagingError.truncated }
        return body
    }

    /// Writes `payload` as one frame to `fd` with `write(2)`, so it works on a pipe (stdout).
    /// Throws `frameTooLarge` before writing anything, `.system("write", …)` on failure (EPIPE
    /// included; ignore SIGPIPE in the process to get it instead of a signal).
    public static func writeFrame(_ payload: Data, to fd: Int32) throws {
        let frame = try encodeFrame(payload)
        try frame.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = Darwin.write(fd, raw.baseAddress! + offset, raw.count - offset)
                if written < 0 {
                    let code = errno
                    if code == EINTR { continue }
                    throw NativeMessagingError.system("write", errno: code)
                }
                offset += written
            }
        }
    }

    /// Decodes a payload as an `IPCRequest`: a JSON object whose `type` is known. Throws
    /// `IPCError.malformed` with the coding path only, never the payload.
    public static func decodeRequest(_ payload: Data) throws -> IPCRequest {
        try IPC.decodeLine(IPCRequest.self, from: payload)
    }

    // MARK: Helpers

    /// The little-endian length in a 4-byte `header`, rejected when above `maxFrameBytes`.
    private static func checkedLength(_ header: Data) throws -> Int {
        let raw = header.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) }
        let length = Int(raw)
        guard length <= maxFrameBytes else { throw NativeMessagingError.frameTooLarge(length) }
        return length
    }

    /// Fills `buffer` from `fd` until it is full or the input ends; returns the bytes read.
    private static func readFully(_ fd: Int32, into buffer: inout Data) throws -> Int {
        let total = buffer.count
        guard total > 0 else { return 0 }
        return try buffer.withUnsafeMutableBytes { raw in
            var offset = 0
            while offset < total {
                let count = Darwin.read(fd, raw.baseAddress! + offset, total - offset)
                if count < 0 {
                    let code = errno
                    if code == EINTR { continue }
                    throw NativeMessagingError.system("read", errno: code)
                }
                if count == 0 { break }
                offset += count
            }
            return offset
        }
    }
}

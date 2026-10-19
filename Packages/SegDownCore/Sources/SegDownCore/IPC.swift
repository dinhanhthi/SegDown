// Request/response protocol between the clients (segdown-host, later the Safari appex) and the
// menu bar app, which runs the jobs. Each Unix-socket connection carries exactly one request line
// and one response line of newline-delimited JSON.
//
// Wire format (this is the browser extension contract; unknown keys are ignored, an unknown
// `type` fails decoding):
//
// Requests
//
//     {"type": "ping"}
//     {"type": "enqueue", "job": {…JobRequest…}}
//     {"type": "status"}                              // all jobs
//     {"type": "status", "ids": ["…", "…"]}           // only these jobs
//     {"type": "cancel", "id": "…"}
//     {"type": "probe", "source": {…Source…}}
//
// Responses
//
//     {"type": "pong", "version": "1.0", "missing": ["yt-dlp", "deno"]}   // missing tools, may be []
//     {"type": "enqueued", "id": "…"}
//     {"type": "status", "jobs": [{…JobStatus…}]}
//     {"type": "cancelled", "id": "…"}
//     {"type": "variants", "variants": [{…HLSVariant…}]}   // [] for a media playlist or an mp4
//     {"type": "error", "code": "invalid", "message": "…"}
//
// Error codes: "invalid" (bad request), "notFound" (unknown job id), "unavailable" (cannot serve
// now, e.g. a missing tool), "internal". Messages never echo header values or cookies.
import Foundation

public enum IPCRequest: Sendable, Hashable {
    case ping
    case enqueue(JobRequest)
    /// `nil` asks for all jobs.
    case status(ids: [String]?)
    case cancel(id: String)
    case probe(Source)
}

extension IPCRequest: Codable {
    private enum CodingKeys: String, CodingKey {
        case type, job, ids, id, source
    }

    private enum RequestType: String, Codable {
        case ping, enqueue, status, cancel, probe
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(RequestType.self, forKey: .type) {
        case .ping: self = .ping
        case .enqueue: self = .enqueue(try c.decode(JobRequest.self, forKey: .job))
        case .status: self = .status(ids: try c.decodeIfPresent([String].self, forKey: .ids))
        case .cancel: self = .cancel(id: try c.decode(String.self, forKey: .id))
        case .probe: self = .probe(try c.decode(Source.self, forKey: .source))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .ping:
            try c.encode(RequestType.ping, forKey: .type)
        case let .enqueue(job):
            try c.encode(RequestType.enqueue, forKey: .type)
            try c.encode(job, forKey: .job)
        case let .status(ids):
            try c.encode(RequestType.status, forKey: .type)
            try c.encodeIfPresent(ids, forKey: .ids)
        case let .cancel(id):
            try c.encode(RequestType.cancel, forKey: .type)
            try c.encode(id, forKey: .id)
        case let .probe(source):
            try c.encode(RequestType.probe, forKey: .type)
            try c.encode(source, forKey: .source)
        }
    }
}

public enum IPCResponse: Sendable, Hashable {
    /// `missing` holds the raw values of `Binaries.missing()`.
    case pong(version: String, missing: [String])
    case enqueued(id: String)
    case status([JobStatus])
    case cancelled(id: String)
    /// Master playlist variants; empty for a media playlist or an mp4.
    case variants([HLSVariant])
    /// `code` is one of `IPCResponse.ErrorCode`.
    case error(code: String, message: String)

    /// The `code` values of `.error`.
    public enum ErrorCode {
        public static let invalid = "invalid"
        public static let notFound = "notFound"
        public static let unavailable = "unavailable"
        public static let `internal` = "internal"
    }
}

extension IPCResponse: Codable {
    private enum CodingKeys: String, CodingKey {
        case type, version, missing, id, jobs, variants, code, message
    }

    private enum ResponseType: String, Codable {
        case pong, enqueued, status, cancelled, variants, error
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(ResponseType.self, forKey: .type) {
        case .pong:
            self = .pong(
                version: try c.decode(String.self, forKey: .version),
                missing: try c.decodeIfPresent([String].self, forKey: .missing) ?? []
            )
        case .enqueued: self = .enqueued(id: try c.decode(String.self, forKey: .id))
        case .status: self = .status(try c.decode([JobStatus].self, forKey: .jobs))
        case .cancelled: self = .cancelled(id: try c.decode(String.self, forKey: .id))
        case .variants: self = .variants(try c.decode([HLSVariant].self, forKey: .variants))
        case .error:
            self = .error(
                code: try c.decode(String.self, forKey: .code),
                message: try c.decode(String.self, forKey: .message)
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .pong(version, missing):
            try c.encode(ResponseType.pong, forKey: .type)
            try c.encode(version, forKey: .version)
            try c.encode(missing, forKey: .missing)
        case let .enqueued(id):
            try c.encode(ResponseType.enqueued, forKey: .type)
            try c.encode(id, forKey: .id)
        case let .status(jobs):
            try c.encode(ResponseType.status, forKey: .type)
            try c.encode(jobs, forKey: .jobs)
        case let .cancelled(id):
            try c.encode(ResponseType.cancelled, forKey: .type)
            try c.encode(id, forKey: .id)
        case let .variants(variants):
            try c.encode(ResponseType.variants, forKey: .type)
            try c.encode(variants, forKey: .variants)
        case let .error(code, message):
            try c.encode(ResponseType.error, forKey: .type)
            try c.encode(code, forKey: .code)
            try c.encode(message, forKey: .message)
        }
    }
}

/// Transport errors. `appNotRunning` and `timeout` are separate so the host can decide to launch
/// the app. Descriptions never include the payload.
public enum IPCError: Error, Sendable, Hashable {
    /// No socket file (ENOENT) or nobody listening on it (ECONNREFUSED).
    case appNotRunning
    case timeout
    /// The socket path does not fit in `sun_path` (byte count, limit).
    case socketPathTooLong(Int, limit: Int)
    /// A line exceeded `IPC.maxLineBytes` before its newline.
    case lineTooLong
    /// The peer closed the connection before sending a full line.
    case connectionClosed
    /// The line is not valid JSON for the expected type.
    case malformed(String)
    /// A system call failed with `errno`.
    case system(String, errno: Int32)
}

extension IPCError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .appNotRunning: return "SegDown is not running"
        case .timeout: return "SegDown did not answer in time"
        case let .socketPathTooLong(count, limit):
            return "Socket path is \(count) bytes; the limit is \(limit - 1)"
        case .lineTooLong: return "Message is larger than \(IPC.maxLineBytes) bytes"
        case .connectionClosed: return "Connection closed before a full message was received"
        case let .malformed(detail): return "Malformed message: \(detail)"
        case let .system(operation, code): return "\(operation) failed: \(String(cString: strerror(code)))"
        }
    }
}

public enum IPC {
    /// Same cap as a native messaging frame.
    public static let maxLineBytes = 1024 * 1024
    public static let defaultTimeout: TimeInterval = 30

    /// `~/Library/Application Support/SegDown/segdown.sock`. The single place the socket path is
    /// decided; the folder is not created here. The `sun_path` length is checked by `socketAddress`.
    /// `~` is the user's real home from the password database, so the sandboxed Safari appex (whose
    /// `FileManager`/`NSHomeDirectory` point into its container) resolves the same path as the app.
    public static func socketURL() -> URL {
        let home = getpwuid(getuid()).flatMap { $0.pointee.pw_dir.map { String(cString: $0) } }
            ?? NSHomeDirectory()
        return URL(filePath: home, directoryHint: .isDirectory)
            .appending(path: "Library/Application Support/SegDown/segdown.sock", directoryHint: .notDirectory)
    }

    /// The `AF_UNIX` address of `url`, for `connect` here and `bind` in the server.
    /// Throws `socketPathTooLong` when the path does not fit in `sun_path` with its NUL.
    public static func socketAddress(for url: URL) throws -> sockaddr_un {
        var address = sockaddr_un()
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        let path = Array(url.path(percentEncoded: false).utf8)
        guard !path.contains(0) else { throw IPCError.malformed("socket path contains NUL") }
        guard path.count < capacity else { throw IPCError.socketPathTooLong(path.count, limit: capacity) }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: path) }
        return address
    }

    // MARK: Codec

    /// `value` as one JSON line ending in `\n`.
    public static func encodeLine(_ value: some Encodable) throws -> Data {
        var data = try JSONEncoder().encode(value)
        // JSONEncoder escapes newlines inside strings and adds none without .prettyPrinted.
        guard !data.contains(0x0A) else { throw IPCError.malformed("encoded JSON contains a newline") }
        guard data.count < maxLineBytes else { throw IPCError.lineTooLong }
        data.append(0x0A)
        return data
    }

    /// Decodes one line; a trailing `\n` or `\r\n` is ignored.
    public static func decodeLine<T: Decodable>(_ type: T.Type, from line: Data) throws -> T {
        var line = line
        if line.last == 0x0A { line.removeLast() }
        if line.last == 0x0D { line.removeLast() }
        do {
            return try JSONDecoder().decode(type, from: line)
        } catch let error as DecodingError {
            throw IPCError.malformed(describe(error))
        }
    }

    // MARK: Socket I/O

    /// Reads up to the first `\n` (excluded) from `fd`, at most `maxLineBytes`. Bytes after the
    /// newline are discarded (one message per connection). `deadline` bounds the whole read, since
    /// `SO_RCVTIMEO` only bounds each `recv`.
    public static func readLine(from fd: Int32, deadline: Date? = nil) throws -> Data {
        var line = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            if let deadline, Date() >= deadline { throw IPCError.timeout }
            let count = buffer.withUnsafeMutableBytes { recv(fd, $0.baseAddress, $0.count, 0) }
            if count < 0 {
                let code = errno
                if code == EINTR { continue }
                if code == EAGAIN || code == EWOULDBLOCK { throw IPCError.timeout }
                throw IPCError.system("recv", errno: code)
            }
            if count == 0 { throw IPCError.connectionClosed }
            let chunk = buffer[..<count]
            if let newline = chunk.firstIndex(of: 0x0A) {
                line.append(contentsOf: chunk[..<newline])
                guard line.count <= maxLineBytes else { throw IPCError.lineTooLong }
                return line
            }
            line.append(contentsOf: chunk)
            guard line.count <= maxLineBytes else { throw IPCError.lineTooLong }
        }
    }

    /// Writes all of `data` to `fd`. The socket should have `SO_NOSIGPIPE` set.
    public static func writeAll(_ data: Data, to fd: Int32) throws {
        try data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = Darwin.send(fd, raw.baseAddress! + offset, raw.count - offset, 0)
                if written < 0 {
                    let code = errno
                    if code == EINTR { continue }
                    if code == EAGAIN || code == EWOULDBLOCK { throw IPCError.timeout }
                    if code == EPIPE { throw IPCError.connectionClosed }
                    throw IPCError.system("send", errno: code)
                }
                offset += written
            }
        }
    }

    /// Sets `SO_NOSIGPIPE` and, when `timeout` is given, `SO_RCVTIMEO`/`SO_SNDTIMEO` on `fd`.
    public static func configure(_ fd: Int32, timeout: TimeInterval?) throws {
        var on: Int32 = 1
        try setOption(fd, SO_NOSIGPIPE, &on)
        if let timeout {
            let seconds = max(timeout, 0.001)
            var value = timeval(
                tv_sec: Int(seconds),
                tv_usec: Int32((seconds - seconds.rounded(.down)) * 1_000_000)
            )
            try setOption(fd, SO_RCVTIMEO, &value)
            try setOption(fd, SO_SNDTIMEO, &value)
        }
    }

    // MARK: Client

    /// Sends one request and waits for its response, blocking the calling thread.
    /// Throws `IPCError.appNotRunning` when nothing listens on `socket`, `.timeout` after `timeout`.
    public static func send(
        _ request: IPCRequest,
        to socket: URL = socketURL(),
        timeout: TimeInterval = defaultTimeout
    ) throws -> IPCResponse {
        let deadline = Date().addingTimeInterval(timeout)
        let line = try encodeLine(request)
        var address = try socketAddress(for: socket)

        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw IPCError.system("socket", errno: errno) }
        defer { _ = close(fd) }
        try configure(fd, timeout: timeout)

        while true {
            let result = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            if result == 0 { break }
            let code = errno
            switch code {
            case EINTR: continue
            case ENOENT, ECONNREFUSED: throw IPCError.appNotRunning
            case ETIMEDOUT, EAGAIN: throw IPCError.timeout
            default: throw IPCError.system("connect", errno: code)
            }
        }

        try writeAll(line, to: fd)
        let reply = try readLine(from: fd, deadline: deadline)
        return try decodeLine(IPCResponse.self, from: reply)
    }

    // MARK: Helpers

    private static func setOption<T: BitwiseCopyable>(_ fd: Int32, _ option: Int32, _ value: inout T) throws {
        let result = withUnsafeBytes(of: &value) {
            setsockopt(fd, SOL_SOCKET, option, $0.baseAddress, socklen_t($0.count))
        }
        guard result == 0 else { throw IPCError.system("setsockopt", errno: errno) }
    }

    /// A description of `error` with the coding path only, never the decoded values.
    private static func describe(_ error: DecodingError) -> String {
        func path(_ context: DecodingError.Context) -> String {
            let keys = context.codingPath.map { $0.intValue.map(String.init) ?? $0.stringValue }
            return keys.isEmpty ? "top level" : keys.joined(separator: ".")
        }
        switch error {
        case let .keyNotFound(key, context): return "missing \(key.stringValue) at \(path(context))"
        case let .typeMismatch(_, context): return "wrong type at \(path(context))"
        case let .valueNotFound(_, context): return "missing value at \(path(context))"
        case let .dataCorrupted(context): return "invalid data at \(path(context))"
        @unknown default: return "invalid data"
        }
    }
}

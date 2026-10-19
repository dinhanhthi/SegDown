// Unix-socket server for the IPC protocol in SegDownCore's IPC.swift. One request line and one
// response line per connection, from processes of the same user only. The accept loop runs on its
// own thread and each connection on a GCD queue, so nothing here blocks the main actor; only
// `JobStore.handle` runs there. Payloads are never logged (job sources may carry cookies).
import AppKit
import Foundation
import os
import SegDownCore

final class IPCServer: @unchecked Sendable {
    /// Connections served at once; extra ones are closed without a reply.
    static let maxConnections = 16
    /// Bounds reading the request and writing the response of one connection.
    static let connectionTimeout: TimeInterval = 10

    private let store: JobStore
    private let socket: URL
    private let logger = Logger(subsystem: "com.math2it.segdown", category: "ipc")
    /// Serializes `listener` between the start sequence and `stop()`.
    private let queue = DispatchQueue(label: "com.math2it.segdown.ipc")
    /// Listening fd, -1 when not listening. Guarded by `queue`.
    private var listener: Int32 = -1
    private var stopped = false
    private let active = OSAllocatedUnfairLock(initialState: 0)

    init(store: JobStore, socket: URL = IPC.socketURL()) {
        self.store = store
        self.socket = socket
    }

    /// Starts listening in the background and stops when the app terminates.
    @MainActor
    func start() {
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: nil
        ) { [self] _ in stop() }
        queue.async { [self] in
            do {
                try listen()
            } catch {
                logger.error("IPC server not started: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// Closes the listener and removes the socket file, if this process created it.
    func stop() {
        queue.sync {
            stopped = true
            guard listener >= 0 else { return }
            _ = close(listener)
            listener = -1
            _ = unlink(socket.path(percentEncoded: false))
        }
    }

    // MARK: - Listener

    /// Runs on `queue`.
    private func listen() throws {
        guard !stopped else { return }
        try prepareDirectory()
        guard try removeStaleSocket() else { return }

        var address = try IPC.socketAddress(for: socket)
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw IPCError.system("socket", errno: errno) }
        let path = socket.path(percentEncoded: false)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0 else {
            let code = errno
            _ = close(fd)
            throw IPCError.system("bind", errno: code)
        }
        // The folder is already 0700, so the short window before this chmod is not reachable.
        guard chmod(path, 0o600) == 0 else {
            let code = errno
            _ = close(fd)
            _ = unlink(path)
            throw IPCError.system("chmod", errno: code)
        }
        guard Darwin.listen(fd, SOMAXCONN) == 0 else {
            let code = errno
            _ = close(fd)
            _ = unlink(path)
            throw IPCError.system("listen", errno: code)
        }
        listener = fd
        logger.info("IPC server listening")

        let thread = Thread { [self] in acceptLoop(fd) }
        thread.name = "SegDown IPC accept"
        thread.start()
    }

    /// Creates the socket folder with mode 0700 and tightens it if it already exists.
    private func prepareDirectory() throws {
        let path = socket.deletingLastPathComponent().path(percentEncoded: false)
        if mkdir(path, 0o700) != 0, errno != EEXIST {
            throw IPCError.system("mkdir", errno: errno)
        }
        var info = stat()
        guard lstat(path, &info) == 0 else { throw IPCError.system("lstat", errno: errno) }
        guard info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid() else {
            throw IPCError.system("socket folder check", errno: EPERM)
        }
        guard chmod(path, 0o700) == 0 else { throw IPCError.system("chmod", errno: errno) }
    }

    /// Unlinks a socket nobody listens on. Returns false, without touching the file, when another
    /// SegDown answers on it; throws when the path is something other than a socket.
    private func removeStaleSocket() throws -> Bool {
        let path = socket.path(percentEncoded: false)
        var info = stat()
        guard lstat(path, &info) == 0 else {
            if errno == ENOENT { return true }
            throw IPCError.system("lstat", errno: errno)
        }
        guard info.st_mode & S_IFMT == S_IFSOCK else {
            throw IPCError.system("socket path check", errno: EEXIST)
        }
        do {
            _ = try IPC.send(.ping, to: socket, timeout: 2)
            logger.notice("Another SegDown is already listening; IPC server not started")
            return false
        } catch IPCError.appNotRunning {
            guard unlink(path) == 0 || errno == ENOENT else { throw IPCError.system("unlink", errno: errno) }
            return true
        } catch {
            // Something accepted the connection but did not answer: leave it alone.
            logger.notice("Socket in use but no valid reply; IPC server not started")
            return false
        }
    }

    private func acceptLoop(_ listener: Int32) {
        while true {
            let fd = accept(listener, nil, nil)
            if fd < 0 {
                let code = errno
                if code == EINTR || code == ECONNABORTED || code == EMFILE || code == ENFILE {
                    if code == EMFILE || code == ENFILE { usleep(100_000) }
                    continue
                }
                // EBADF/EINVAL after `stop()` closed the listener.
                return
            }
            admit(fd)
        }
    }

    /// Checks the peer and the connection cap, then serves `fd` on a GCD queue.
    private func admit(_ fd: Int32) {
        var uid: uid_t = 0
        var gid: gid_t = 0
        guard getpeereid(fd, &uid, &gid) == 0, uid == getuid() else {
            _ = close(fd)
            return
        }
        let admitted = active.withLock { count in
            guard count < Self.maxConnections else { return false }
            count += 1
            return true
        }
        guard admitted else {
            _ = close(fd)
            return
        }
        DispatchQueue.global(qos: .userInitiated).async { [self] in serve(fd) }
    }

    // MARK: - Connection

    private func serve(_ fd: Int32) {
        let request: IPCRequest
        do {
            try IPC.configure(fd, timeout: Self.connectionTimeout)
            let line = try IPC.readLine(from: fd, deadline: Date().addingTimeInterval(Self.connectionTimeout))
            request = try IPC.decodeLine(IPCRequest.self, from: line)
        } catch let error as IPCError {
            switch error {
            case .lineTooLong, .malformed:
                reply(.error(code: IPCResponse.ErrorCode.invalid,
                             message: error.errorDescription ?? "Invalid request"), on: fd)
            default:
                finish(fd)
            }
            return
        } catch {
            reply(.error(code: IPCResponse.ErrorCode.invalid, message: "Invalid request"), on: fd)
            return
        }
        Task { @MainActor [store] in
            let response = await store.handle(request)
            DispatchQueue.global(qos: .userInitiated).async { [self] in reply(response, on: fd) }
        }
    }

    /// Writes one response line, then closes `fd`. Never runs on the main actor.
    private func reply(_ response: IPCResponse, on fd: Int32) {
        let line: Data
        do {
            line = try IPC.encodeLine(response)
        } catch {
            line = (try? IPC.encodeLine(IPCResponse.error(
                code: IPCResponse.ErrorCode.internal, message: "Response could not be encoded"
            ))) ?? Data()
        }
        do {
            try IPC.writeAll(line, to: fd)
        } catch {
            logger.debug("IPC reply not delivered")
        }
        finish(fd)
    }

    private func finish(_ fd: Int32) {
        _ = close(fd)
        active.withLock { $0 -= 1 }
    }
}

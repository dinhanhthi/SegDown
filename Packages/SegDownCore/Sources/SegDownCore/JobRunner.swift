// Runs jobs end to end: resolves the media, runs ffmpeg (or yt-dlp) once per segment in a private
// temp dir, then moves the parts into the output dir or concats them into one file. The actor owns
// every child `Process`; status updates are published through one `AsyncStream` per job.
// Child processes always get an argv array (never a shell) and the absolute binary path.
import Foundation

public actor JobRunner {
    /// A started job: its id (for `cancel(id:)`) and its status updates, ending with a final
    /// `done`, `failed` or `cancelled` status.
    public struct Job: Sendable {
        public let id: String
        public let updates: AsyncStream<JobStatus>
    }

    public static let linkExpiredMessage =
        "Media link expired or forbidden (HTTP 403/410). Play the video again and retry."
    /// yt-dlp's 403/410 usually means the site blocks the download, not an expired link.
    public static let siteRefusedMessage =
        "The site refused the download (HTTP 403/410). It may block yt-dlp; try `brew upgrade yt-dlp`."
    /// Time between SIGINT and SIGTERM when a job is cancelled.
    static let cancelGracePeriod: Duration = .seconds(3)

    private struct Entry {
        var task: Task<Void, Never>?
        var process: Process?
        var cancelled = false
    }

    private let binaries: Binaries
    private let baseDirectory: URL
    private var jobs: [String: Entry] = [:]

    /// `baseDirectory` holds one folder per title (default `~/Downloads/SegDown`).
    public init(binaries: Binaries = Binaries(), baseDirectory: URL = PathSanitizer.defaultBaseDirectory) {
        self.binaries = binaries
        self.baseDirectory = baseDirectory
    }

    /// Starts `request` immediately. Jobs run concurrently; each has its own temp dir.
    /// The request is validated again here, so an invalid one ends as `failed`.
    public func start(_ request: JobRequest) -> Job {
        let id = UUID().uuidString
        let (updates, continuation) = AsyncStream.makeStream(
            of: JobStatus.self,
            bufferingPolicy: .bufferingNewest(100)
        )
        continuation.yield(JobStatus(id: id, state: .queued, segmentCount: request.segments.count))
        jobs[id] = Entry()
        jobs[id]?.task = Task {
            await self.execute(id: id, request: request, continuation: continuation)
        }
        return Job(id: id, updates: updates)
    }

    /// Cancels job `id`: SIGINT to its running process, then SIGTERM after 3 s if it is still
    /// running. The job ends as `cancelled` and its temp dir is removed. Unknown ids are ignored.
    public func cancel(id: String) {
        guard let entry = jobs[id], !entry.cancelled else { return }
        jobs[id]?.cancelled = true
        entry.task?.cancel()
        guard let process = entry.process, process.isRunning else { return }
        let pid = process.processIdentifier
        process.interrupt()
        Task {
            try? await Task.sleep(for: Self.cancelGracePeriod)
            self.terminate(id: id, pid: pid)
        }
    }

    // MARK: - Job

    private func execute(id: String, request: JobRequest, continuation: AsyncStream<JobStatus>.Continuation) async {
        let count = request.segments.count
        let tracker = ProgressTracker(id: id, segmentCount: count, continuation: continuation)
        let tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SegDown-\(id)", isDirectory: true)

        var final: JobStatus
        do {
            tracker.begin(index: 0, message: "Starting")
            let request = try Validation.validate(request)
            try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
            let outputs = try await run(id: id, request: request, tempDirectory: tempDirectory, tracker: tracker)
            final = JobStatus(
                id: id, state: .done, segmentIndex: count - 1, segmentCount: count,
                fraction: 1, outputs: outputs.map(\.path)
            )
        } catch {
            if jobs[id]?.cancelled == true {
                final = JobStatus(id: id, state: .cancelled, segmentIndex: tracker.index, segmentCount: count,
                                  message: "Cancelled")
            } else {
                final = JobStatus(id: id, state: .failed, segmentIndex: tracker.index, segmentCount: count,
                                  message: Self.message(for: error))
            }
        }
        final.fraction = final.state == .done ? 1 : tracker.fraction
        try? FileManager.default.removeItem(at: tempDirectory)
        jobs[id] = nil
        continuation.yield(final)
        continuation.finish()
    }

    /// Downloads every segment into `tempDirectory`, then writes the outputs. Returns their URLs.
    private func run(id: String, request: JobRequest, tempDirectory: URL, tracker: ProgressTracker) async throws -> [URL] {
        let ffmpeg = try binary(.ffmpeg)
        let parts: [URL]
        switch request.source {
        case let .media(url, kind, headers, variantURL, audioURL):
            let (input, audio) = try await resolveMedia(
                url: url, kind: kind, headers: headers, variantURL: variantURL, audioURL: audioURL, tracker: tracker
            )
            parts = try await downloadMedia(
                id: id, input: input, kind: kind, audio: audio, headers: headers, source: url,
                request: request, ffmpeg: ffmpeg, tempDirectory: tempDirectory, tracker: tracker
            )
        case let .page(url):
            parts = try await downloadPage(
                id: id, url: url, request: request, ffmpeg: ffmpeg, tempDirectory: tempDirectory, tracker: tracker
            )
        }
        try checkCancelled(id)

        let outputDirectory = try PathSanitizer.outputDirectory(title: request.title, base: baseDirectory)
        // Use the component outputDirectory produced, so a fallback name has one timestamp.
        let title = outputDirectory.lastPathComponent
        switch request.mode {
        case .separate:
            return try moveParts(parts, segments: request.segments, title: title, to: outputDirectory)
        case .merged:
            tracker.begin(index: request.segments.count - 1, message: "Merging")
            let merged = try await merge(id: id, parts: parts, ffmpeg: ffmpeg, tempDirectory: tempDirectory)
            try checkCancelled(id)
            try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
            // No await between picking the name and moving: the actor keeps concurrent jobs apart.
            let destination = PathSanitizer.uniqueFileURL(
                in: outputDirectory, fileName: PathSanitizer.mergedFileName(title: title)
            )
            try FileManager.default.moveItem(at: merged, to: destination)
            return [destination]
        }
    }

    /// The input (and separate audio) URLs for ffmpeg. For HLS without a chosen variant the
    /// playlist is fetched, and a master playlist is replaced by its best variant.
    private func resolveMedia(
        url: URL, kind: MediaKind, headers: [String: String], variantURL: URL?, audioURL: URL?,
        tracker: ProgressTracker
    ) async throws -> (input: URL, audio: URL?) {
        guard kind == .hls, variantURL == nil else {
            return (variantURL ?? url, audioURL)
        }
        tracker.begin(index: 0, message: "Reading playlist")
        let playlist = try await HLSPlaylist.fetch(url, headers: headers)
        guard playlist.isMaster else { return (url, audioURL) }
        guard let selection = playlist.pickVariant() else {
            throw JobError.invalid("The HLS master playlist has no playable variant")
        }
        return (selection.variant.url, selection.audioURL)
    }

    /// One ffmpeg run per segment into `<tmp>/part-NNN.mp4`.
    private func downloadMedia(
        id: String, input: URL, kind: MediaKind, audio: URL?, headers: [String: String], source: URL,
        request: JobRequest, ffmpeg: URL, tempDirectory: URL, tracker: ProgressTracker
    ) async throws -> [URL] {
        let count = request.segments.count
        var parts: [URL] = []
        for (index, segment) in request.segments.enumerated() {
            let part = tempDirectory.appendingPathComponent(CommandBuilder.partFileName(index: index + 1))
            let arguments = CommandBuilder.ffmpegSegment(
                input: input, kind: kind, audio: audio, headers: headers, source: source, segment: segment,
                precision: request.precision, output: part
            )
            let duration = segment.end - segment.start
            tracker.begin(index: index, message: "Downloading segment \(index + 1) of \(count)")
            try await runProcess(.ffmpeg, executable: ffmpeg, arguments: arguments, jobID: id) { stream, line in
                // Not `progress=end`: ffmpeg also prints it when interrupted by a cancel.
                guard stream == .stdout, line.hasPrefix("out_time_us="),
                      let micros = Double(line.dropFirst("out_time_us=".count)) else { return }
                tracker.progress(micros / 1_000_000 / duration)
            }
            guard FileManager.default.fileExists(atPath: part.path) else {
                throw JobError.processFailed("ffmpeg wrote no file for segment \(index + 1)")
            }
            parts.append(part)
        }
        return parts
    }

    /// One yt-dlp run for all segments; it writes `<tmp>/part-NNN.<ext>` in segment order.
    private func downloadPage(
        id: String, url: URL, request: JobRequest, ffmpeg: URL, tempDirectory: URL, tracker: ProgressTracker
    ) async throws -> [URL] {
        let ytDlp = try binary(.ytDlp)
        let segments = request.segments
        let arguments = CommandBuilder.ytDlp(
            url: url, segments: segments, precision: request.precision, ffmpeg: ffmpeg, tempDirectory: tempDirectory
        )
        tracker.begin(index: 0, message: "Downloading segment 1 of \(segments.count)")
        try await runProcess(.ytDlp, executable: ytDlp, arguments: arguments, jobID: id) { _, line in
            if line.contains("Destination:"), let number = Self.partNumber(in: line),
               (1...segments.count).contains(number) {
                if number - 1 != tracker.index {
                    tracker.begin(index: number - 1, message: "Downloading segment \(number) of \(segments.count)")
                }
            } else if let percent = Self.downloadPercent(line) {
                tracker.progress(percent / 100)
            } else if let range = line.range(of: "time="), let time = Self.clock(line[range.upperBound...]) {
                let segment = segments[min(tracker.index, segments.count - 1)]
                tracker.progress(time / (segment.end - segment.start))
            }
        }
        return try collectPageParts(in: tempDirectory, count: segments.count, merged: request.mode == .merged)
    }

    /// The finished `part-NNN.<ext>` file of each segment. In-progress and per-format files
    /// (`part-001.mp4.part`, `part-001.f137.mp4`) have more than one extension and are skipped.
    /// For a merge, non-mp4 parts are renamed to `partFileName` so `concatList` names them.
    private func collectPageParts(in directory: URL, count: Int, merged: Bool) throws -> [URL] {
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
        return try (1...count).map { index in
            let expected = CommandBuilder.partFileName(index: index)
            if names.contains(expected) {
                return directory.appendingPathComponent(expected)
            }
            let stem = (expected as NSString).deletingPathExtension + "."
            guard let name = names.first(where: { name in
                guard name.hasPrefix(stem) else { return false }
                let ext = name.dropFirst(stem.count)
                return !ext.isEmpty && !ext.contains(".") && ext != "part" && ext != "ytdl"
            }) else {
                throw JobError.processFailed("yt-dlp did not produce segment \(index) of \(count)")
            }
            let found = directory.appendingPathComponent(name)
            guard merged else { return found }
            let renamed = directory.appendingPathComponent(expected)
            try FileManager.default.moveItem(at: found, to: renamed)
            return renamed
        }
    }

    /// Concats `parts` (named by `partFileName`) into `<tmp>/merged.mp4`.
    private func merge(id: String, parts: [URL], ffmpeg: URL, tempDirectory: URL) async throws -> URL {
        let list = tempDirectory.appendingPathComponent("list.txt")
        try CommandBuilder.concatList(partCount: parts.count).write(to: list, atomically: true, encoding: .utf8)
        let output = tempDirectory.appendingPathComponent("merged.mp4")
        try await runProcess(
            .ffmpeg, executable: ffmpeg, arguments: CommandBuilder.ffmpegMerge(list: list, output: output),
            jobID: id
        ) { _, _ in }
        return output
    }

    /// Moves each part to `<output dir>/<title> - NN [start-end].<ext>` (ext of the part, mp4 normally).
    private func moveParts(_ parts: [URL], segments: [Segment], title: String, to directory: URL) throws -> [URL] {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var outputs: [URL] = []
        for (index, part) in parts.enumerated() {
            var fileName = PathSanitizer.segmentFileName(title: title, index: index + 1, segment: segments[index])
            if part.pathExtension.lowercased() != "mp4" {
                fileName = ((fileName as NSString).deletingPathExtension as NSString)
                    .appendingPathExtension(part.pathExtension) ?? fileName
            }
            // No await between picking the name and moving: the actor keeps concurrent jobs apart.
            let destination = PathSanitizer.uniqueFileURL(in: directory, fileName: fileName)
            try FileManager.default.moveItem(at: part, to: destination)
            outputs.append(destination)
        }
        return outputs
    }

    // MARK: - Processes

    private func binary(_ tool: Tool) throws -> URL {
        guard let url = binaries.url(for: tool) else { throw JobError.missingDependency(tool.rawValue) }
        return url
    }

    private func checkCancelled(_ id: String) throws {
        if jobs[id]?.cancelled != false || Task.isCancelled { throw CancellationError() }
    }

    /// Runs `executable` to completion, draining both pipes, and throws unless it exits with 0.
    /// `onLine` sees every stdout/stderr line (split on `\n` and `\r`) on a background thread.
    private func runProcess(
        _ tool: Tool, executable: URL, arguments: [String], jobID: String,
        onLine: @escaping @Sendable (ProcessIO.Stream, String) -> Void
    ) async throws {
        try checkCancelled(jobID)
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = Binaries.childEnvironment()
        process.standardInput = FileHandle.nullDevice
        let io = ProcessIO(onLine: onLine)
        io.attach(to: process)
        do {
            try process.run()
        } catch {
            io.detach()
            throw JobError.missingDependency(tool.rawValue)
        }
        jobs[jobID]?.process = process
        let outcome = await io.wait()
        jobs[jobID]?.process = nil
        try checkCancelled(jobID)

        guard outcome.reason != .exit || outcome.status != 0 else { return }
        if outcome.sawLinkExpired {
            throw tool == .ytDlp ? JobError.processFailed(Self.siteRefusedMessage) : JobError.linkExpired
        }
        let how = outcome.reason == .exit ? "exit \(outcome.status)" : "signal \(outcome.status)"
        let detail = Self.summary(outcome.stderrTail)
        throw JobError.processFailed("\(tool.rawValue) failed (\(how))" + (detail.isEmpty ? "" : ": \(detail)"))
    }

    /// Second step of `cancel`: SIGTERM when the same process is still running.
    private func terminate(id: String, pid: Int32) {
        guard let process = jobs[id]?.process, process.processIdentifier == pid, process.isRunning else { return }
        process.terminate()
    }

    // MARK: - Parsing helpers

    /// The last few stderr lines, with URLs (which may carry tokens) redacted, capped at 300 chars.
    static func summary(_ tail: Data) -> String {
        let lines = String(decoding: tail, as: UTF8.self)
            .split(whereSeparator: { $0 == "\n" || $0 == "\r" || $0 == "\r\n" })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let redacted = lines.suffix(3).map { line in
            line.split(separator: " ", omittingEmptySubsequences: false)
                .map { $0.contains("://") ? "<url>" : String($0) }
                .joined(separator: " ")
        }
        let text = redacted.joined(separator: " | ")
        return text.count > 300 ? "…" + String(text.suffix(300)) : text
    }

    /// True for stderr lines that report HTTP 403 or 410 (ffmpeg and yt-dlp wording).
    static func reportsLinkExpired(_ line: String) -> Bool {
        let lower = line.lowercased()
        return ["http error 403", "http error 410", "server returned 403", "server returned 410",
                "403 forbidden", "410 gone"].contains { lower.contains($0) }
    }

    /// `NNN` from a `…/part-NNN.…` path in a yt-dlp line.
    static func partNumber(in line: String) -> Int? {
        guard let range = line.range(of: "part-", options: .backwards) else { return nil }
        let digits = line[range.upperBound...].prefix(while: \.isASCII).prefix(while: \.isNumber)
        return Int(digits)
    }

    /// `42.0` from a yt-dlp `[download]  42.0% of …` line.
    static func downloadPercent(_ line: String) -> Double? {
        guard line.hasPrefix("[download]") else { return nil }
        guard let token = line.dropFirst("[download]".count).split(separator: " ").first,
              token.hasSuffix("%") else { return nil }
        return Double(token.dropLast())
    }

    /// Seconds from an ffmpeg `HH:MM:SS.xx` clock at the start of `text`.
    static func clock(_ text: Substring) -> Double? {
        let value = text.prefix(while: { !$0.isWhitespace })
        let fields = value.split(separator: ":")
        guard fields.count == 3, let hours = Double(fields[0]), let minutes = Double(fields[1]),
              let seconds = Double(fields[2]) else { return nil }
        return hours * 3600 + minutes * 60 + seconds
    }

    static func message(for error: Error) -> String {
        if let jobError = error as? JobError { return jobError.errorDescription ?? "\(jobError)" }
        return error.localizedDescription
    }
}

extension JobError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .linkExpired: return JobRunner.linkExpiredMessage
        case let .missingDependency(tool): return "\(tool) is not installed. Install it with: brew install \(tool)"
        case let .processFailed(detail): return detail
        case let .invalid(detail): return detail
        }
    }
}

// MARK: - Progress

/// Overall progress of one job, shared with the pipe reader threads. Overall fraction is
/// `(index + segment fraction) / count`, never goes backwards, and is published on index or
/// message changes and on steps of at least 1%.
private final class ProgressTracker: @unchecked Sendable {
    private let lock = NSLock()
    private let id: String
    private let segmentCount: Int
    private let continuation: AsyncStream<JobStatus>.Continuation
    private var currentIndex = 0
    private var currentFraction = 0.0
    private var message: String?
    private var lastSent = -1.0

    init(id: String, segmentCount: Int, continuation: AsyncStream<JobStatus>.Continuation) {
        self.id = id
        self.segmentCount = segmentCount
        self.continuation = continuation
    }

    var index: Int { lock.withLock { currentIndex } }
    var fraction: Double { lock.withLock { currentFraction } }

    /// Starts step `index` (0-based segment) with `message` and publishes it.
    func begin(index: Int, message: String) {
        lock.withLock {
            currentIndex = index
            self.message = message
            update(segmentFraction: 0, force: true)
        }
    }

    /// Progress within the current segment, 0...1 (clamped).
    func progress(_ segmentFraction: Double) {
        guard segmentFraction.isFinite else { return }
        lock.withLock { update(segmentFraction: segmentFraction, force: false) }
    }

    /// Caller holds `lock`.
    private func update(segmentFraction: Double, force: Bool) {
        let count = max(segmentCount, 1)
        let overall = (Double(currentIndex) + min(max(segmentFraction, 0), 1)) / Double(count)
        currentFraction = min(max(currentFraction, overall), 1)
        guard force || currentFraction - lastSent >= 0.01 else { return }
        lastSent = currentFraction
        continuation.yield(JobStatus(
            id: id, state: .running, segmentIndex: currentIndex, segmentCount: segmentCount,
            fraction: currentFraction, message: message
        ))
    }
}

// MARK: - Process I/O

/// Drains a child's stdout and stderr concurrently (so neither pipe can fill up and block it),
/// splits them into lines, keeps a bounded stderr tail and records HTTP 403/410 reports.
/// `wait()` returns once the process has exited and both pipes reached EOF, or 2 s after the
/// exit when a grandchild (yt-dlp's ffmpeg) still holds a pipe open.
final class ProcessIO: @unchecked Sendable {
    enum Stream: Sendable { case stdout, stderr }

    struct Outcome: Sendable {
        var status: Int32
        var reason: Process.TerminationReason
        var stderrTail: Data
        var sawLinkExpired: Bool
    }

    private static let maxTailBytes = 4096
    private static let maxLineBytes = 64 * 1024
    private static let eofGracePeriod: TimeInterval = 2

    private let lock = NSLock()
    private let onLine: @Sendable (Stream, String) -> Void
    private let stdoutPipe = Pipe()
    private let stderrPipe = Pipe()
    private var pending: [Stream: Data] = [.stdout: Data(), .stderr: Data()]
    private var openStreams = 2
    private var exit: (status: Int32, reason: Process.TerminationReason)?
    private var stderrTail = Data()
    private var sawLinkExpired = false
    private var outcome: Outcome?
    private var waiter: CheckedContinuation<Outcome, Never>?

    init(onLine: @escaping @Sendable (Stream, String) -> Void) {
        self.onLine = onLine
    }

    /// Wires the pipes and the termination handler. Call before `process.run()`.
    func attach(to process: Process) {
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        stdoutPipe.fileHandleForReading.readabilityHandler = { [self] handle in read(handle.availableData, from: .stdout) }
        stderrPipe.fileHandleForReading.readabilityHandler = { [self] handle in read(handle.availableData, from: .stderr) }
        process.terminationHandler = { [self] process in exited(status: process.terminationStatus, reason: process.terminationReason) }
    }

    /// Undoes `attach` after a failed launch.
    func detach() {
        stdoutPipe.fileHandleForReading.readabilityHandler = nil
        stderrPipe.fileHandleForReading.readabilityHandler = nil
    }

    func wait() async -> Outcome {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let outcome {
                lock.unlock()
                continuation.resume(returning: outcome)
            } else {
                waiter = continuation
                lock.unlock()
            }
        }
    }

    private func read(_ data: Data, from stream: Stream) {
        var lines: [String] = []
        lock.lock()
        if data.isEmpty {
            (stream == .stdout ? stdoutPipe : stderrPipe).fileHandleForReading.readabilityHandler = nil
            if let rest = pending[stream], !rest.isEmpty {
                lines.append(String(decoding: rest, as: UTF8.self))
            }
            pending[stream] = Data()
            openStreams -= 1
        } else {
            if stream == .stderr {
                stderrTail.append(data)
                if stderrTail.count > Self.maxTailBytes {
                    stderrTail = Data(stderrTail.suffix(Self.maxTailBytes))
                }
            }
            var buffer = pending[stream, default: Data()]
            buffer.append(data)
            while let end = buffer.firstIndex(where: { $0 == 0x0A || $0 == 0x0D }) {
                let line = buffer[buffer.startIndex..<end]
                if !line.isEmpty { lines.append(String(decoding: line, as: UTF8.self)) }
                buffer = Data(buffer[buffer.index(after: end)...])
            }
            // A line this long is not progress output; drop it to keep memory bounded.
            pending[stream] = buffer.count > Self.maxLineBytes ? Data() : buffer
        }
        if stream == .stderr, lines.contains(where: JobRunner.reportsLinkExpired) {
            sawLinkExpired = true
        }
        lock.unlock()

        for line in lines { onLine(stream, line) }
        if data.isEmpty { finishIfReady(force: false) }
    }

    private func exited(status: Int32, reason: Process.TerminationReason) {
        lock.withLock { exit = (status, reason) }
        finishIfReady(force: false)
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.eofGracePeriod) { [self] in
            finishIfReady(force: true)
        }
    }

    private func finishIfReady(force: Bool) {
        lock.lock()
        guard outcome == nil, let exit, force || openStreams == 0 else {
            lock.unlock()
            return
        }
        if force { detach() }
        let result = Outcome(status: exit.status, reason: exit.reason, stderrTail: stderrTail, sawLinkExpired: sawLinkExpired)
        outcome = result
        let continuation = waiter
        waiter = nil
        lock.unlock()
        continuation?.resume(returning: result)
    }
}

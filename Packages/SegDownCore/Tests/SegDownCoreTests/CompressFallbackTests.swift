// Guards the compression fallback in `JobRunner.compress`: an ffmpeg failure keeps the download
// uncompressed, while a cancel during compression still ends the job cancelled. A fake ffmpeg
// (a shell script found through `Binaries`) writes the segment, then fails or hangs on the compress call.
import Foundation
import Testing
@testable import SegDownCore

@Suite(.timeLimit(.minutes(1)))
struct CompressFallbackTests {
    static let downloadedContent = "downloaded"

    @Test func compressionFailureKeepsTheUncompressedDownload() async throws {
        let sandbox = try Sandbox(onCompress: "echo 'compress failed' >&2; exit 1")
        defer { sandbox.remove() }

        let job = await sandbox.runner.start(Self.request, options: sandbox.options)
        var final: JobStatus?
        for await status in job.updates { final = status }

        #expect(final?.state == .done)
        #expect(final?.message == "Compression failed; saved uncompressed")
        let outputs = final?.outputs ?? []
        #expect(outputs.count == 1)
        #expect(outputs.first?.hasSuffix(".compressed.mp4") == false)
        let content = try outputs.first.map { try String(contentsOfFile: $0, encoding: .utf8) }
        #expect(content == Self.downloadedContent)
    }

    @Test func cancelDuringCompressionEndsCancelled() async throws {
        // `exec` so the SIGINT from `cancel(id:)` reaches `sleep` itself, not a waiting shell.
        let sandbox = try Sandbox(onCompress: "exec /bin/sleep 30")
        defer { sandbox.remove() }

        let job = await sandbox.runner.start(Self.request, options: sandbox.options)
        var final: JobStatus?
        var cancelled = false
        for await status in job.updates {
            final = status
            if !cancelled, status.message?.hasPrefix("Compressing") == true {
                cancelled = true
                // Give ffmpeg time to start, so the cancel interrupts the running process.
                try await Task.sleep(for: .milliseconds(300))
                await sandbox.runner.cancel(id: job.id)
            }
        }

        #expect(cancelled)
        #expect(final?.state == .cancelled)
        #expect(final?.outputs.isEmpty == true)
        let leftovers = FileManager.default.enumerator(atPath: sandbox.base.path)?
            .compactMap { $0 as? String }
            .filter { $0.hasSuffix(".mp4") } ?? []
        #expect(leftovers.isEmpty)
    }

    static let request = JobRequest(
        source: .media(url: URL(string: "https://example.com/v.mp4")!, kind: .mp4, headers: [:],
                       variantURL: nil, audioURL: nil),
        title: "Clip",
        segments: [Segment(start: 0, end: 5)],
        mode: .separate,
        precision: .fast
    )

    /// A temp dir holding the fake `ffmpeg` (`bin/`) and the output base directory (`out/`).
    struct Sandbox {
        let root: URL
        let base: URL
        let runner: JobRunner

        var options: JobOptions { JobOptions(baseDirectory: base, compress: true) }

        /// `onCompress` is the shell the fake ffmpeg runs for the compress argv (output
        /// `*.compressed.mp4`); any other call writes `downloadedContent` to its output (last argv).
        init(onCompress: String) throws {
            let fileManager = FileManager.default
            root = fileManager.temporaryDirectory
                .appendingPathComponent("SegDownTests-\(UUID().uuidString)", isDirectory: true)
            let bin = root.appendingPathComponent("bin", isDirectory: true)
            base = root.appendingPathComponent("out", isDirectory: true)
            try fileManager.createDirectory(at: bin, withIntermediateDirectories: true)
            try fileManager.createDirectory(at: base, withIntermediateDirectories: true)
            let script = """
            #!/bin/sh
            for last; do :; done
            case "$last" in
              *.compressed.mp4) \(onCompress) ;;
              *) printf '%s' '\(CompressFallbackTests.downloadedContent)' > "$last"; exit 0 ;;
            esac
            """
            let ffmpeg = bin.appendingPathComponent(Tool.ffmpeg.rawValue)
            try script.write(to: ffmpeg, atomically: true, encoding: .utf8)
            try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: ffmpeg.path)
            runner = JobRunner(binaries: Binaries(searchDirectories: [bin.path]), baseDirectory: base)
        }

        func remove() {
            try? FileManager.default.removeItem(at: root)
        }
    }
}

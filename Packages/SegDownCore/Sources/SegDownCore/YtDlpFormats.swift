// Probes a page with yt-dlp for the video heights the overlay's Quality picker offers.
// yt-dlp runs by absolute path with an argv array (never a shell). Its output is site-controlled:
// only integers leave this type.
import Foundation

public enum YtDlpFormats {
    /// Most heights a probe returns.
    static let maxHeights = 32

    /// The video heights of the page `url`, tallest first, or `[]` when yt-dlp cannot run,
    /// fails, prints nothing usable or takes longer than `timeout` (then it is terminated).
    public static func heights(ytDlp: URL, url: URL, timeout: Duration = .seconds(20)) async -> [Int] {
        let stdout = Lines()
        let process = Process()
        process.executableURL = ytDlp
        process.arguments = CommandBuilder.ytDlpFormats(url: url)
        process.environment = Binaries.childEnvironment()
        process.standardInput = FileHandle.nullDevice
        let io = ProcessIO(onLine: { stream, line in if stream == .stdout { stdout.append(line) } })
        io.attach(to: process)
        do {
            try process.run()
        } catch {
            io.detach()
            return []
        }
        let deadline = Task {
            try await Task.sleep(for: timeout)
            if process.isRunning { process.terminate() }
        }
        let outcome = await io.wait()
        deadline.cancel()
        guard outcome.reason == .exit, outcome.status == 0 else { return [] }
        return parseHeights(stdout.joined)
    }

    /// The heights in the first stdout line that starts with `[` (a JSON array of formats):
    /// integer heights of formats with a video codec (a missing `vcodec` counts as video),
    /// deduplicated, tallest first, at most `maxHeights`. Anything unparseable gives `[]`.
    static func parseHeights(_ output: String) -> [Int] {
        guard let line = output.split(whereSeparator: \.isNewline)
            .first(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix("[") }),
            let formats = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [[String: Any]]
        else { return [] }
        let heights = formats.compactMap { format -> Int? in
            guard format["vcodec"] as? String != "none",
                  let height = format["height"] as? Int,
                  (1...Validation.maxHeightLimit).contains(height)
            else { return nil }
            return height
        }
        return Array(Set(heights).sorted(by: >).prefix(maxHeights))
    }
}

/// The stdout lines of a process, shared with the pipe reader threads.
private final class Lines: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []

    var joined: String { lock.withLock { lines.joined(separator: "\n") } }

    func append(_ line: String) {
        lock.withLock { lines.append(line) }
    }
}

// Checks and upgrades the Homebrew formulas SegDown depends on, for the Dependencies page.
// brew runs by absolute path with an argv array (never a shell); its output is only decoded.
import Foundation

public enum Brew {
    /// The formulas checked for updates; ffprobe ships with ffmpeg.
    public static let formulas = ["yt-dlp", "deno", "ffmpeg"]

    /// One entry of `brew outdated --json=v2`: a formula with a newer version available.
    public struct Outdated: Decodable, Sendable, Equatable {
        public let name: String
        public let installedVersions: [String]
        public let currentVersion: String
        public let pinned: Bool
        public let pinnedVersion: String?
    }

    private struct Report: Decodable {
        let formulae: [Outdated]
    }

    /// Decodes the formulas of `brew outdated --json=v2` output, skipping brew's update report before the JSON.
    static func parseOutdated(_ stdout: String) throws -> [Outdated] {
        let json = stdout.split(separator: "\n", omittingEmptySubsequences: false)
            .drop { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("{") }
            .joined(separator: "\n")
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(Report.self, from: Data(json.utf8)).formulae
    }

    /// The outdated `formulas`. brew updates itself first when its last update is over 24 h old,
    /// or always with `forceUpdate`. Its exit code is ignored (it exits 1 when anything is outdated).
    public static func outdated(brew: URL, forceUpdate: Bool) async throws -> [Outdated] {
        let stdout = Lines()
        let outcome = try await run(
            brew, arguments: ["outdated", "--json=v2"] + formulas,
            environment: forceUpdate ? ["HOMEBREW_AUTO_UPDATE_SECS": "1"] : [:],
            onLine: { stream, line in if stream == .stdout { stdout.append(line) } }
        )
        do {
            return try parseOutdated(stdout.joined)
        } catch {
            let detail = JobRunner.summary(outcome.stderrTail)
            throw JobError.processFailed("brew outdated failed" + (detail.isEmpty ? "" : ": \(detail)"))
        }
    }

    /// Runs `brew upgrade formula` (without updating brew first) and throws unless it exits with 0.
    public static func upgrade(_ formula: String, brew: URL) async throws {
        let outcome = try await run(
            brew, arguments: ["upgrade", formula],
            environment: ["HOMEBREW_NO_AUTO_UPDATE": "1"],
            onLine: { _, _ in }
        )
        guard outcome.reason != .exit || outcome.status != 0 else { return }
        let how = outcome.reason == .exit ? "exit \(outcome.status)" : "signal \(outcome.status)"
        let detail = JobRunner.summary(outcome.stderrTail)
        throw JobError.processFailed("brew upgrade \(formula) failed (\(how))" + (detail.isEmpty ? "" : ": \(detail)"))
    }

    /// Runs `brew` to completion with `Binaries.childEnvironment()` plus `environment`.
    private static func run(
        _ brew: URL, arguments: [String], environment: [String: String],
        onLine: @escaping @Sendable (ProcessIO.Stream, String) -> Void
    ) async throws -> ProcessIO.Outcome {
        let process = Process()
        process.executableURL = brew
        process.arguments = arguments
        process.environment = Binaries.childEnvironment().merging(environment) { $1 }
        process.standardInput = FileHandle.nullDevice
        let io = ProcessIO(onLine: onLine)
        io.attach(to: process)
        do {
            try process.run()
        } catch {
            io.detach()
            throw JobError.processFailed("Could not run Homebrew at \(brew.path)")
        }
        return await io.wait()
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

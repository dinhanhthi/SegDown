// The app's job list and the single entry point for IPC requests. Wraps one `JobRunner`; jobs
// start immediately and run concurrently. Every enqueued job and every probed source passes
// `Validation` before anything is fetched or run. Error messages never echo header values.
import Foundation
import Observation
import SegDownCore

@MainActor @Observable
final class JobStore {
    /// One job in the list. `JobStatus` has no title, so the store keeps it alongside.
    struct Item: Identifiable {
        let id: String
        let title: String
        var status: JobStatus
    }

    /// Finished jobs beyond this count are dropped, oldest first. Running jobs are never dropped.
    static let maxItems = 50
    /// UserDefaults key of the default precision (`Precision` raw value, `precise` when unset).
    /// Display only for now: the extension sends the precision with each job.
    static let defaultPrecisionKey = "defaultPrecision"

    /// Most recent first.
    private(set) var items: [Item] = []
    /// Tools not found by `Binaries`, refreshed by `recheckDependencies()`.
    private(set) var missing: [Tool] = []

    private let binaries = Binaries()
    private let runner: JobRunner
    @ObservationIgnored private var server: IPCServer?

    init() {
        runner = JobRunner(binaries: binaries)
        recheckDependencies()
        server = IPCServer(store: self)
        server?.start()
    }

    func recheckDependencies() {
        missing = binaries.missing()
    }

    // MARK: - IPC

    /// Maps every IPC request to its response:
    /// - `ping` → `pong` with the app version and the missing tools.
    /// - `enqueue` → validates, starts the job, returns `enqueued(id)`; invalid → `error("invalid")`.
    /// - `status(ids)` → the statuses of those jobs (unknown ids are omitted); `nil` → all jobs.
    /// - `cancel(id)` → `cancelled(id)` for any listed job (a finished one is left as is);
    ///   unknown id → `error("notFound")`.
    /// - `probe(source)` → validates, then the variants of an HLS master playlist (`[]` for a media
    ///   playlist, an mp4 or a page); fetch failures → `error("unavailable")` or `error("invalid")`.
    func handle(_ request: IPCRequest) async -> IPCResponse {
        switch request {
        case .ping:
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
            recheckDependencies()
            return .pong(version: version, missing: missing.map(\.rawValue))
        case let .enqueue(job):
            return await enqueue(job)
        case let .status(ids):
            let selected = ids.map { ids in items.filter { ids.contains($0.id) } } ?? items
            return .status(selected.map(\.status))
        case let .cancel(id):
            guard items.contains(where: { $0.id == id }) else {
                return .error(code: IPCResponse.ErrorCode.notFound, message: "No job with that id")
            }
            await runner.cancel(id: id)
            return .cancelled(id: id)
        case let .probe(source):
            return await probe(source)
        }
    }

    // MARK: - Jobs

    func cancel(_ id: String) {
        Task { await runner.cancel(id: id) }
    }

    /// Removes every job that is done, failed or cancelled.
    func clearFinished() {
        items.removeAll { $0.status.state.isFinished }
    }

    private func enqueue(_ request: JobRequest) async -> IPCResponse {
        let validated: JobRequest
        do {
            validated = try Validation.validate(request)
        } catch {
            return .error(code: IPCResponse.ErrorCode.invalid, message: Self.message(for: error))
        }
        let job = await runner.start(validated)
        // Listed before returning, so a `status` request right after `enqueued` finds it.
        items.insert(
            Item(id: job.id, title: validated.title,
                 status: JobStatus(id: job.id, state: .queued, segmentCount: validated.segments.count)),
            at: 0
        )
        trim()
        Task { [weak self] in
            for await status in job.updates {
                self?.apply(status)
            }
        }
        return .enqueued(id: job.id)
    }

    private func apply(_ status: JobStatus) {
        guard let index = items.firstIndex(where: { $0.id == status.id }) else { return }
        items[index].status = status
    }

    private func trim() {
        var index = items.count - 1
        while items.count > Self.maxItems, index >= 0 {
            if items[index].status.state.isFinished { items.remove(at: index) }
            index -= 1
        }
    }

    // MARK: - Probe

    private func probe(_ source: Source) async -> IPCResponse {
        let validated: Source
        do {
            validated = try Validation.validate(source)
        } catch {
            return .error(code: IPCResponse.ErrorCode.invalid, message: Self.message(for: error))
        }
        guard case let .media(url, .hls, headers, _, _) = validated else { return .variants([]) }
        do {
            let playlist = try await HLSPlaylist.fetch(url, headers: headers)
            return .variants(playlist.isMaster ? playlist.variants : [])
        } catch JobError.invalid(let detail) {
            return .error(code: IPCResponse.ErrorCode.invalid, message: detail)
        } catch {
            return .error(code: IPCResponse.ErrorCode.unavailable, message: Self.message(for: error))
        }
    }

    /// `JobError` descriptions never contain URLs or header values; other errors (URLSession's
    /// may carry the URL) get a fixed text.
    private static func message(for error: Error) -> String {
        if let jobError = error as? JobError, let description = jobError.errorDescription {
            return description
        }
        return "Could not fetch the playlist"
    }
}

extension JobState {
    var isFinished: Bool {
        switch self {
        case .done, .failed, .cancelled: return true
        case .queued, .running: return false
        }
    }
}

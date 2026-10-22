// The app's job list and the single entry point for IPC requests. Wraps one `JobRunner`; jobs
// start immediately and run concurrently. Every enqueued job and every probed source passes
// `Validation` before anything is fetched or run. Error messages never echo header values.
// Finished jobs are kept in `JobHistory` (never incognito ones) and listed again at launch.
import Foundation
import Observation
import os
import SegDownCore

@MainActor @Observable
final class JobStore {
    /// One job in the list. `JobStatus` carries a title only when the runner replaced the tab's,
    /// so the store keeps it alongside, with the metadata the window cards show.
    struct Item: Identifiable {
        enum SourceKind { case page, media }

        let id: String
        var title: String
        var status: JobStatus
        let segmentCount: Int
        /// Sum of the segments' `end - start`, in seconds.
        let totalDuration: Double
        /// Latest size reported by the runner.
        var bytes: Int64?
        /// The request's source; `nil` for jobs loaded from the history (not recorded there).
        let sourceKind: SourceKind?
        /// `true` once any status reported the switch to the captured media.
        var fallbackUsed: Bool
        /// The tab's page; `nil` when the request had none (a media source from an older extension).
        let pageURL: URL?
        let incognito: Bool
        let createdAt: Date
        /// Set when the job ends (done, failed or cancelled).
        var finishedAt: Date?
        /// Listed in the Archived list instead of the main one; kept across launches.
        var archived: Bool
    }

    /// A file `remove(ids:trashFiles:)` could not move to the Trash.
    struct TrashFailure: Identifiable {
        var id: String { path }
        let path: String
        let message: String
    }

    /// Finished jobs beyond this count are dropped from the list, oldest first; running jobs are
    /// never dropped. History records count toward it: only the newest `maxItems` are listed at
    /// launch (the file keeps up to `JobHistory.maxRecords`). Kept small because `status` without
    /// ids (the extension's 1 s poll) returns every listed job in one message.
    static let maxItems = 50
    /// Legacy UserDefaults key of the default precision, migrated once by `SettingsStore`.
    static let defaultPrecisionKey = "defaultPrecision"
    /// `~/Library/Application Support/SegDown/history.json`, next to the settings and the socket.
    static let historyFileURL = IPC.socketURL().deletingLastPathComponent()
        .appending(path: "history.json", directoryHint: .notDirectory)

    /// Most recent first.
    private(set) var items: [Item] = []
    /// Tools not found by `Binaries`, refreshed by `recheckDependencies()`.
    private(set) var missing: [Tool] = []
    /// Last connection time per browser bundle id (display only, never used for authorization).
    private(set) var lastConnected: [String: Date] = [:]
    /// Outdated `Brew.formulas`, refreshed by `checkForUpdates(force:)`.
    private(set) var outdated: [Brew.Outdated] = []
    /// `true` while `brew outdated` runs.
    private(set) var checkingUpdates = false
    /// `true` once `brew outdated` has run; until then `outdated` is unknown, not empty.
    private(set) var updatesChecked = false
    /// The formula `brew upgrade` is running for.
    private(set) var upgrading: String?
    /// The last check's or upgrade's error, shown on the Dependencies page.
    private(set) var updateError: String?

    let settings: SettingsStore
    private let binaries = Binaries()
    private let runner: JobRunner
    @ObservationIgnored private var server: IPCServer?
    /// Saved into the socket's folder, which `IPCServer.start()` creates before any job can end.
    @ObservationIgnored private var history: JobHistory
    @ObservationIgnored private let logger = Logger(subsystem: "com.math2it.segdown", category: "jobs")

    init(settings: SettingsStore, historyFileURL: URL = JobStore.historyFileURL) {
        self.settings = settings
        runner = JobRunner(binaries: binaries)
        history = JobHistory(fileURL: historyFileURL)
        history.load()
        items = history.records.prefix(Self.maxItems).map(Self.item(from:))
        recheckDependencies()
        server = IPCServer(store: self)
        server?.start()
    }

    func recheckDependencies() {
        missing = binaries.missing()
    }

    // MARK: - Updates

    /// `true` while any job is queued or running; upgrades wait for them.
    var hasActiveJobs: Bool {
        items.contains { !$0.status.state.isFinished }
    }

    /// Refreshes `outdated`; `force` makes brew update itself first. Skipped while a check or an
    /// upgrade runs, so only one brew process runs at a time.
    func checkForUpdates(force: Bool) async {
        guard !checkingUpdates, upgrading == nil else { return }
        guard let brew = binaries.brewURL() else {
            outdated = []
            updateError = "Homebrew not found in /opt/homebrew/bin or /usr/local/bin"
            return
        }
        checkingUpdates = true
        defer {
            checkingUpdates = false
            updatesChecked = true
        }
        do {
            outdated = try await Brew.outdated(brew: brew, forceUpdate: force)
            updateError = nil
        } catch {
            updateError = error.localizedDescription
        }
    }

    /// Runs `brew upgrade formula`, then re-checks the tools and the updates. Skipped while a job
    /// is active, a check runs or another upgrade runs. A failed upgrade's error outlasts the check.
    func upgrade(_ formula: String) async {
        guard !hasActiveJobs, !checkingUpdates, upgrading == nil, let brew = binaries.brewURL() else { return }
        upgrading = formula
        updateError = nil
        var failure: String?
        do {
            try await Brew.upgrade(formula, brew: brew)
        } catch {
            failure = error.localizedDescription
        }
        upgrading = nil
        recheckDependencies()
        await checkForUpdates(force: false)
        if let failure { updateError = failure }
    }

    // MARK: - IPC

    /// Maps every IPC request to its response:
    /// - `ping` → `pong` with the app version, the missing tools, the protocol version and the
    ///   client settings (never paths).
    /// - `enqueue` → validates, starts the job, returns `enqueued(id)`; invalid → `error("invalid")`.
    /// - `status(ids)` → the statuses of those jobs (unknown ids are omitted); `nil` → all jobs.
    /// - `cancel(id)` → `cancelled(id)` for any listed job (a finished one is left as is);
    ///   unknown id → `error("notFound")`.
    /// - `probe(source)` → validates, then the variants of an HLS master playlist (`[]` for a media
    ///   playlist or an mp4); fetch failures → `error("unavailable")` or `error("invalid")`. A page
    ///   → `formats(heights)` from yt-dlp (`[]` on any failure).
    /// - `setIgnored(host, ignored)` → adds the host's site to (or removes every domain covering the
    ///   host from) `ignoredDomains`, then `pong` like `ping` (without re-checking the tools); not a
    ///   hostname or a full list → `error("invalid")`.
    func handle(_ request: IPCRequest) async -> IPCResponse {
        switch request {
        case .ping:
            recheckDependencies()
            return pong()
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
        case let .setIgnored(host, ignored):
            return setIgnored(host: host, ignored: ignored)
        }
    }

    private func pong() -> IPCResponse {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        return .pong(
            version: version, missing: missing.map(\.rawValue),
            protocol: IPC.protocolVersion, settings: settings.settings.clientSettings
        )
    }

    /// Ignoring a host a listed domain already covers changes nothing. Turning a host back on
    /// removes every listed domain covering it (the same host or a parent domain).
    private func setIgnored(host: String, ignored: Bool) -> IPCResponse {
        guard let site = IgnoredDomain.site(forHost: host), let normalized = IgnoredDomain.normalize(host) else {
            return .error(code: IPCResponse.ErrorCode.invalid, message: "SegDown can't be turned off on this page.")
        }
        let domains = settings.settings.ignoredDomains
        if !ignored {
            settings.update { $0.ignoredDomains.removeAll { IgnoredDomain.covers($0, host: normalized) } }
        } else if !domains.contains(where: { IgnoredDomain.covers($0, host: normalized) }) {
            guard domains.count < AppSettings.maxIgnoredDomains else {
                return .error(code: IPCResponse.ErrorCode.invalid, message: "The Ignored sites list is full.")
            }
            settings.update { $0.ignoredDomains.append(site) }
        }
        return pong()
    }

    // MARK: - Jobs

    func cancel(_ id: String) {
        Task { await runner.cancel(id: id) }
    }

    func noteConnection(bundleID: String) {
        lastConnected[bundleID] = Date()
    }

    /// Removes the jobs `ids` from the list and the history; running ones are cancelled first.
    /// With `trashFiles`, each existing output goes to the Trash (never deleted permanently).
    /// Returns the files that could not be trashed.
    @discardableResult
    func remove(ids: Set<String>, trashFiles: Bool) -> [TrashFailure] {
        let removed = items.filter { ids.contains($0.id) }
        for item in removed where !item.status.state.isFinished {
            cancel(item.id)
        }
        items.removeAll { ids.contains($0.id) }
        do {
            try history.remove(ids: ids)
        } catch {
            logHistoryError(error)
        }
        guard trashFiles else { return [] }
        var failures: [TrashFailure] = []
        for path in removed.flatMap(\.status.outputs)
        where FileManager.default.fileExists(atPath: path) {
            do {
                try FileManager.default.trashItem(at: URL(filePath: path), resultingItemURL: nil)
            } catch {
                failures.append(TrashFailure(path: path, message: error.localizedDescription))
            }
        }
        return failures
    }

    /// Archives or unarchives the jobs `ids` in the list and the history. Incognito jobs and running
    /// ones are not in the history yet: a running one is recorded with its flag when it ends.
    func setArchived(ids: Set<String>, archived: Bool) {
        for index in items.indices where ids.contains(items[index].id) {
            items[index].archived = archived
        }
        do {
            try history.setArchived(ids: ids, archived: archived)
        } catch {
            logHistoryError(error)
        }
    }

    /// Removes every job that is done, failed or cancelled and clears the history file.
    /// Running jobs are untouched.
    func clearHistory() {
        items.removeAll { $0.status.state.isFinished }
        do {
            try history.clear()
        } catch {
            logHistoryError(error)
        }
    }

    private func enqueue(_ request: JobRequest) async -> IPCResponse {
        let current = settings.settings
        var validated: JobRequest
        do {
            validated = try Validation.validate(request)
            try Validation.check(validated, limits: current.limits)
        } catch {
            return .error(code: IPCResponse.ErrorCode.invalid, message: Self.message(for: error))
        }
        validated.precision = current.precision
        let incognito = validated.incognito ?? current.incognitoDefault
        let job = await runner.start(validated, options: current.jobOptions)
        let sourceKind: Item.SourceKind
        var pageURL = validated.pageURL
        switch validated.source {
        case let .page(url):
            sourceKind = .page
            pageURL = pageURL ?? url
        case .media: sourceKind = .media
        }
        // Listed before returning, so a `status` request right after `enqueued` finds it.
        items.insert(
            Item(id: job.id, title: validated.title,
                 status: JobStatus(id: job.id, state: .queued, segmentCount: validated.segments.count),
                 segmentCount: validated.segments.count,
                 totalDuration: validated.segments.reduce(0) { $0 + ($1.end - $1.start) },
                 sourceKind: sourceKind, fallbackUsed: false, pageURL: pageURL, incognito: incognito,
                 createdAt: Date(), archived: false),
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

    /// Updates the job's item. On its end, records it in the history (unless incognito). A job
    /// removed while running is gone from `items`, so it is never recorded. A job the site refused
    /// (yt-dlp's HTTP 403/410, often an old yt-dlp) checks for updates, the only automatic check.
    private func apply(_ status: JobStatus) {
        guard let index = items.firstIndex(where: { $0.id == status.id }) else { return }
        items[index].status = status
        if let title = status.title { items[index].title = title }
        if let bytes = status.bytes { items[index].bytes = bytes }
        if status.fallbackUsed == true { items[index].fallbackUsed = true }
        guard status.state.isFinished, items[index].finishedAt == nil else { return }
        items[index].finishedAt = Date()
        if status.state == .failed, status.message == JobRunner.siteRefusedMessage {
            Task { await checkForUpdates(force: true) }
        }
        let item = items[index]
        do {
            try history.append(Self.record(from: item), incognito: item.incognito)
        } catch {
            logHistoryError(error)
        }
    }

    private func logHistoryError(_ error: Error) {
        let code = (error as NSError).code
        logger.error("history.json not saved (code \(code, privacy: .public))")
    }

    private static func record(from item: Item) -> JobRecord {
        JobRecord(
            id: item.id, title: item.title, state: item.status.state,
            createdAt: item.createdAt, finishedAt: item.finishedAt ?? Date(),
            segmentCount: item.segmentCount, totalDuration: item.totalDuration,
            bytes: item.bytes, outputs: item.status.outputs, message: item.status.message,
            fallbackUsed: item.fallbackUsed ? true : nil, pageURL: item.pageURL,
            archived: item.archived ? true : nil
        )
    }

    private static func item(from record: JobRecord) -> Item {
        let done = record.state == .done
        let status = JobStatus(
            id: record.id, state: record.state,
            segmentIndex: done ? max(record.segmentCount - 1, 0) : 0,
            segmentCount: record.segmentCount, fraction: done ? 1 : 0,
            message: record.message, outputs: record.outputs,
            bytes: record.bytes, fallbackUsed: record.fallbackUsed
        )
        return Item(
            id: record.id, title: record.title, status: status,
            segmentCount: record.segmentCount, totalDuration: record.totalDuration,
            bytes: record.bytes, sourceKind: nil, fallbackUsed: record.fallbackUsed == true,
            pageURL: record.pageURL, incognito: false, createdAt: record.createdAt, finishedAt: record.finishedAt,
            archived: record.archived == true
        )
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
        // Every page probe failure (yt-dlp missing, unsupported site, timeout) answers `[]` on
        // purpose: the extension caches it, while an error would be retried and respawn yt-dlp.
        if case let .page(url) = validated {
            guard let ytDlp = binaries.url(for: .ytDlp) else { return .formats(heights: []) }
            return .formats(heights: await YtDlpFormats.heights(ytDlp: ytDlp, url: url))
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

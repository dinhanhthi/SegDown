// Finished jobs, persisted as JSON so the window can list them across launches. Privacy: a
// record never holds the request, its source, URLs or headers, and the stored message has every
// URL replaced by `<link>`. Incognito jobs are never stored.
import Foundation

/// One finished job as stored in the history. `outputs` holds absolute file paths.
public struct JobRecord: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var state: JobState
    public var createdAt: Date
    public var finishedAt: Date
    public var segmentCount: Int
    public var totalDuration: Double
    public var bytes: Int64?
    public var outputs: [String]
    public var message: String?
    public var fallbackUsed: Bool?

    public init(
        id: String,
        title: String,
        state: JobState,
        createdAt: Date,
        finishedAt: Date,
        segmentCount: Int,
        totalDuration: Double,
        bytes: Int64? = nil,
        outputs: [String] = [],
        message: String? = nil,
        fallbackUsed: Bool? = nil
    ) {
        self.id = id
        self.title = title
        self.state = state
        self.createdAt = createdAt
        self.finishedAt = finishedAt
        self.segmentCount = segmentCount
        self.totalDuration = totalDuration
        self.bytes = bytes
        self.outputs = outputs
        self.message = message
        self.fallbackUsed = fallbackUsed
    }
}

/// The history file (`history.json`, URL injected) and its records, newest first. Every mutation
/// saves atomically and leaves the file at mode 0600; the parent folder is the caller's (never
/// created or changed here).
public struct JobHistory: Sendable {
    /// Older records beyond this count are dropped on append.
    public static let maxRecords = 500

    public let fileURL: URL
    /// Newest first.
    public private(set) var records: [JobRecord] = []

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    /// Reads the file. A missing, unreadable or corrupt file loads as empty and is left untouched
    /// until the next save.
    public mutating func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? Self.decoder.decode([JobRecord].self, from: data) else {
            records = []
            return
        }
        records = decoded
    }

    /// Stores `record` (message scrubbed) as the newest, unless `incognito`, which drops it entirely.
    public mutating func append(_ record: JobRecord, incognito: Bool) throws {
        guard !incognito else { return }
        var record = record
        record.message = record.message.map(Self.scrubURLs)
        records.removeAll { $0.id == record.id }
        records.insert(record, at: 0)
        if records.count > Self.maxRecords { records.removeLast(records.count - Self.maxRecords) }
        try save()
    }

    public mutating func remove(ids: Set<String>) throws {
        records.removeAll { ids.contains($0.id) }
        try save()
    }

    public mutating func clear() throws {
        records = []
        try save()
    }

    /// Replaces every `http://` or `https://` URL (up to whitespace, a quote or a closing bracket,
    /// query string included) with `<link>`.
    static func scrubURLs(_ text: String) -> String {
        text.replacing(/(?i)https?:\/\/[^\s"'<>)\]}]+/, with: "<link>")
    }

    private func save() throws {
        let data = try Self.encoder.encode(records)
        try data.write(to: fileURL, options: .atomic)
        // An atomic write creates a fresh file with the default umask.
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }

    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

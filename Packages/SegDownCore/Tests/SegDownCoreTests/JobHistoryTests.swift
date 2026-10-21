// Guards the history's privacy (incognito jobs, sources, URLs, the file's permissions) and the
// persisted archived flag.
import Foundation
import Testing
@testable import SegDownCore

struct JobHistoryTests {
    private func tempFileURL() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("JobHistoryTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("history.json")
    }

    private func record(id: String, message: String? = nil) -> JobRecord {
        JobRecord(
            id: id, title: "Clip", state: .failed, createdAt: Date(), finishedAt: Date(),
            segmentCount: 1, totalDuration: 10, message: message
        )
    }

    @Test func incognitoRecordNeverReachesTheFile() throws {
        let url = try tempFileURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        var history = JobHistory(fileURL: url)
        try history.append(record(id: "kept"), incognito: false)
        try history.append(record(id: "secret"), incognito: true)

        let text = try String(contentsOf: url, encoding: .utf8)
        #expect(text.contains("kept"))
        #expect(!text.contains("secret"))
        var reloaded = JobHistory(fileURL: url)
        reloaded.load()
        #expect(reloaded.records.map(\.id) == ["kept"])
    }

    @Test func savedRecordWithoutPageURLHasNoSourceOrURLs() throws {
        let url = try tempFileURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        var history = JobHistory(fileURL: url)
        let message = "ERROR: unable to download https://cdn.example.com/v.m3u8?sig=abc&exp=1 "
            + "(HTTP 403) from \"http://example.com/watch\""
        try history.append(record(id: "a", message: message), incognito: false)

        let data = try Data(contentsOf: url)
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        for key in ["source", "headers", "url"] {
            #expect(json.allSatisfy { $0[key] == nil })
        }
        let text = try #require(String(data: data, encoding: .utf8))
        #expect(!text.contains("http://") && !text.contains("https://"))
        #expect(!text.contains("sig=abc"))
        #expect(text.contains("<link>"))
    }

    @Test func savedFileIsOwnerOnly() throws {
        let url = try tempFileURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        var history = JobHistory(fileURL: url)
        try history.append(record(id: "a"), incognito: false)

        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }

    @Test func archivedFlagSurvivesReloadAndUnarchiveClearsIt() throws {
        let url = try tempFileURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        var history = JobHistory(fileURL: url)
        try history.append(record(id: "a"), incognito: false)
        try history.setArchived(ids: ["a"], archived: true)

        var reloaded = JobHistory(fileURL: url)
        reloaded.load()
        #expect(reloaded.records.first?.archived == true)

        try reloaded.setArchived(ids: ["a"], archived: false)
        var again = JobHistory(fileURL: url)
        again.load()
        #expect(again.records.map(\.id) == ["a"])
        #expect(again.records.first?.archived == nil)
    }

    @Test func fileWithoutArchivedKeyLoadsAsNotArchived() throws {
        let url = try tempFileURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let json = """
            [{"id": "old", "title": "Clip", "state": "done", "createdAt": "2026-10-01T10:00:00Z",
              "finishedAt": "2026-10-01T10:05:00Z", "segmentCount": 1, "totalDuration": 10, "outputs": []}]
            """
        try Data(json.utf8).write(to: url)

        var history = JobHistory(fileURL: url)
        history.load()
        #expect(history.records.map(\.id) == ["old"])
        #expect(history.records.first?.archived == nil)
    }
}

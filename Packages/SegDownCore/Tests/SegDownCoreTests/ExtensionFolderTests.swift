// Guards the copy of the Chromium extension that the user loads once: it follows the bundled version and
// never keeps files from an older one.
import Foundation
import Testing
@testable import SegDownCore

struct ExtensionFolderTests {
    private func tempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ExtensionFolderTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func writeExtension(at folder: URL, version: String, files: [String: String]) throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data(#"{"manifest_version":3,"version":"\#(version)"}"#.utf8).write(to: folder.appending(path: "manifest.json"))
        for (name, text) in files {
            try Data(text.utf8).write(to: folder.appending(path: name))
        }
    }

    @Test func copiesWhenMissingAndSkipsTheSameVersion() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let source = dir.appending(path: "bundle")
        let target = dir.appending(path: "Chrome Extension")
        try writeExtension(at: source, version: "1.0.0", files: ["background.js": "one"])

        #expect(try ExtensionFolder.sync(from: source, to: target))
        #expect(try String(contentsOf: target.appending(path: "background.js"), encoding: .utf8) == "one")
        #expect(try ExtensionFolder.sync(from: source, to: target) == false)
    }

    @Test func newVersionReplacesTheFolderAndDropsStaleFiles() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let source = dir.appending(path: "bundle")
        let target = dir.appending(path: "Chrome Extension")
        try writeExtension(at: target, version: "1.0.0", files: ["background.js": "old", "gone.js": "old"])
        try writeExtension(at: source, version: "1.1.0", files: ["background.js": "new"])

        #expect(try ExtensionFolder.sync(from: source, to: target))

        #expect(ExtensionFolder.version(at: target) == "1.1.0")
        #expect(try String(contentsOf: target.appending(path: "background.js"), encoding: .utf8) == "new")
        #expect(!FileManager.default.fileExists(atPath: target.appending(path: "gone.js").path(percentEncoded: false)))
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: dir.path(percentEncoded: false))
        #expect(Set(leftovers) == ["bundle", "Chrome Extension"])
    }
}

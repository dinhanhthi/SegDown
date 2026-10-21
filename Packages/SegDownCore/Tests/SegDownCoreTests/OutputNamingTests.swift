// Guards the output naming options: snake_case names (`PathSanitizer.snakeCase`) and a flattened
// output folder (`JobOptions.flatten`), which writes the files straight into the base directory.
import Foundation
import Testing
@testable import SegDownCore

@Suite(.timeLimit(.minutes(1)))
struct OutputNamingTests {
    @Test func snakeCaseFoldsToASCIIWords() {
        #expect(PathSanitizer.snakeCase("Học Swift cơ bản — Phần 2") == "hoc_swift_co_ban_phan_2")
        #expect(PathSanitizer.snakeCase("  Đà Nẵng: (Live) ") == "da_nang_live")
        #expect(PathSanitizer.snakeCase("日本語 🎬") == "")
    }

    @Test func snakeCaseSanitizeFallsBackToSnakeCaseName() {
        let name = PathSanitizer.sanitize("日本語", snakeCase: true)
        #expect(name.hasPrefix("segdown_"))
        #expect(PathSanitizer.snakeCase(name) == name)
    }

    @Test func snakeCaseCapLeavesNoTrailingUnderscore() {
        let title = String(repeating: "a", count: PathSanitizer.maxTitleLength - 1) + " b"
        #expect(PathSanitizer.sanitize(title, snakeCase: true) == String(repeating: "a", count: PathSanitizer.maxTitleLength - 1))
    }

    @Test func snakeCaseFileNames() {
        let segment = Segment(start: 65, end: 90)
        #expect(PathSanitizer.segmentFileName(title: "my_clip", index: 1, segment: segment, snakeCase: true)
            == "my_clip_01_0h01m05s_0h01m30s.mp4")
        #expect(PathSanitizer.mergedFileName(title: "my_clip", snakeCase: true) == "my_clip_merged.mp4")
    }

    @Test func flattenedSnakeCaseJobWritesIntoBase() async throws {
        let sandbox = try CompressFallbackTests.Sandbox(onCompress: "exit 1")
        defer { sandbox.remove() }
        var request = CompressFallbackTests.request
        request.title = "My Clip"
        let options = JobOptions(baseDirectory: sandbox.base, flatten: true, snakeCaseNames: true)

        var outputs: [String] = []
        for _ in 0..<2 {
            let job = await sandbox.runner.start(request, options: options)
            var final: JobStatus?
            for await status in job.updates { final = status }
            #expect(final?.state == .done)
            outputs += final?.outputs ?? []
        }

        let base = sandbox.base.standardizedFileURL.path
        #expect(outputs == [
            base + "/my_clip_01_0h00m00s_0h00m05s.mp4",
            base + "/my_clip_01_0h00m00s_0h00m05s_2.mp4",
        ])
    }
}

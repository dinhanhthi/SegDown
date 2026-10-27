// Guards the key-feature contract of the ffmpeg and yt-dlp argv.
import Foundation
import Testing
@testable import SegDownCore

struct CommandBuilderTests {
    private let input = URL(string: "https://cdn.example.com/720p.m3u8")!
    private let output = URL(fileURLWithPath: "/tmp/job/part-001.mp4")

    private func segmentArgs(
        precision: Precision,
        headers: [String: String] = ["Referer": "https://example.com/", "User-Agent": "UA"],
        source: URL? = nil
    ) -> [String] {
        CommandBuilder.ffmpegSegment(
            input: input,
            kind: .hls,
            audio: nil,
            headers: headers,
            source: source ?? input,
            segment: Segment(start: 65.5, end: 90),
            precision: precision,
            output: output
        )
    }

    @Test func hlsPreciseSeeksBeforeInputWithHeadersAndWhitelist() throws {
        let args = segmentArgs(precision: .precise)
        let ss = try #require(args.firstIndex(of: "-ss"))
        let i = try #require(args.firstIndex(of: "-i"))
        #expect(ss < i)
        #expect(args[ss + 1] == "65.500")
        #expect(args[i + 1] == input.absoluteString)
        let headers = try #require(args.firstIndex(of: "-headers"))
        #expect(args[headers + 1] == "Referer: https://example.com/\r\n")
        let whitelist = try #require(args.firstIndex(of: "-protocol_whitelist"))
        #expect(args[whitelist + 1] == "http,https,tcp,tls,crypto,data")
    }

    @Test func cookieGoesOnlyToSourceHostThroughScopedCookies() throws {
        let headers = ["Referer": "https://example.com/", "Cookie": "a=b; c=d"]
        let same = segmentArgs(precision: .fast, headers: headers)
        let cookies = try #require(same.firstIndex(of: "-cookies"))
        #expect(same[cookies + 1] == "a=b; domain=cdn.example.com\nc=d; domain=cdn.example.com\n")
        let headerValue = try #require(same.firstIndex(of: "-headers"))
        #expect(!same[headerValue + 1].contains("Cookie:"))

        let cross = segmentArgs(precision: .fast, headers: headers, source: URL(string: "https://www.example.com/v.m3u8")!)
        #expect(!cross.contains("-cookies"))

        let http = CommandBuilder.ffmpegSegment(
            input: URL(string: "http://cdn.example.com/720p.m3u8")!, kind: .hls, audio: nil, headers: headers,
            source: input, segment: Segment(start: 0, end: 1), precision: .fast, output: output
        )
        #expect(!http.contains("-cookies"))
    }

    @Test func extensionPickyOffOnlyForHLSInputs() {
        // ffmpeg 7.1+ rejects HLS segments named like `file-0000.png`; mp4 inputs fail on the option.
        let hls = CommandBuilder.ffmpegSegment(
            input: input, kind: .hls, audio: URL(string: "https://cdn.example.com/audio.m3u8")!,
            headers: [:], source: input, segment: Segment(start: 0, end: 1), precision: .fast, output: output
        )
        let inputs = hls.indices.filter { hls[$0] == "-i" }
        #expect(inputs.count == 2)
        let picky = hls.indices.filter { hls[$0] == "-extension_picky" && hls[$0 + 1] == "0" }
        #expect(picky.count == 2)
        #expect(zip(picky, inputs).allSatisfy { p, i in
            p < i && !hls[p..<i].contains("-i")
        })
        // A playlist served as `master.html` (text/html) is only read as HLS when forced.
        let format = hls.indices.filter { hls[$0] == "-f" && hls[$0 + 1] == "hls" }
        #expect(format.count == 2)
        #expect(zip(format, inputs).allSatisfy { f, i in
            f < i && !hls[f..<i].contains("-i")
        })

        let mp4 = CommandBuilder.ffmpegSegment(
            input: URL(string: "https://cdn.example.com/v.mp4")!, kind: .mp4, audio: nil, headers: [:],
            source: input, segment: Segment(start: 0, end: 1), precision: .fast, output: output
        )
        #expect(!mp4.contains("-extension_picky"))
        #expect(!mp4.contains("-f"))
    }

    @Test func fastModeCopiesStreams() throws {
        let args = segmentArgs(precision: .fast)
        let c = try #require(args.firstIndex(of: "-c"))
        #expect(args[c + 1] == "copy")
    }

    @Test func mergeHasNoProtocolWhitelist() {
        let args = CommandBuilder.ffmpegMerge(
            list: URL(fileURLWithPath: "/tmp/job/list.txt"),
            output: URL(fileURLWithPath: "/tmp/out/Clip - merged.mp4")
        )
        #expect(!args.contains("-protocol_whitelist"))
    }

    @Test func compressReencodesToSmallerH264() {
        let args = CommandBuilder.ffmpegCompress(
            input: URL(fileURLWithPath: "/tmp/job/merged.mp4"),
            output: URL(fileURLWithPath: "/tmp/job/merged.compressed.mp4")
        )
        #expect(args.contains("libx264"))
        #expect(args.firstIndex(of: "-crf").map { args[$0 + 1] } == "28")
        #expect(args.firstIndex(of: "-pix_fmt").map { args[$0 + 1] } == "yuv420p")
        #expect(args.firstIndex(of: "-i").map { args[$0 + 1] } == "/tmp/job/merged.mp4")
        #expect(args.last == "/tmp/job/merged.compressed.mp4")
    }

    @Test func ytDlpPutsURLAfterDoubleDash() {
        let url = URL(string: "https://www.youtube.com/watch?v=aqz-KE-bpKQ")!
        let args = CommandBuilder.ytDlp(
            url: url,
            segments: [Segment(start: 1, end: 2)],
            precision: .fast,
            ffmpeg: URL(fileURLWithPath: "/opt/homebrew/bin/ffmpeg"),
            tempDirectory: URL(fileURLWithPath: "/tmp/job")
        )
        #expect(Array(args.suffix(2)) == ["--", url.absoluteString])
    }

    @Test func ytDlpSortsByMaxHeightOnlyWhenSet() throws {
        let url = URL(string: "https://www.youtube.com/watch?v=aqz-KE-bpKQ")!
        func args(maxHeight: Int?) -> [String] {
            CommandBuilder.ytDlp(
                url: url,
                segments: [Segment(start: 1, end: 2)],
                precision: .fast,
                ffmpeg: URL(fileURLWithPath: "/opt/homebrew/bin/ffmpeg"),
                tempDirectory: URL(fileURLWithPath: "/tmp/job"),
                maxHeight: maxHeight
            )
        }
        let capped = args(maxHeight: 720)
        let sort = try #require(capped.firstIndex(of: "-S"))
        #expect(capped[sort + 1] == "height:720")
        #expect(sort < (capped.firstIndex(of: "--") ?? -1))
        #expect(!args(maxHeight: nil).contains("-S"))
    }

    @Test func timestampsUseDotUnderGermanLocale() {
        // A locale-dependent formatter would produce a comma here; the builder must not.
        #expect(String(format: "%.3f", locale: Locale(identifier: "de_DE"), 1.5) == "1,500")
        #expect(CommandBuilder.seconds(1.5) == "1.500")
    }
}

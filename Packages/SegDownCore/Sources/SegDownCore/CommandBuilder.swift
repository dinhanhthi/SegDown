// Builds the argument lists for ffmpeg and yt-dlp. Every command is an argv array handed to
// `Process.arguments` (the executable comes from `Binaries`); no shell is ever involved.
// Inputs are expected to have passed `Validation` already.
import Foundation

public enum CommandBuilder {
    /// Header names that go into ffmpeg's single `-headers` value, in this order.
    /// `User-Agent` is passed separately through `-user_agent`, `Cookie` through `-cookies`.
    static let ffmpegHeaderNames = ["Referer", "Origin"]

    static let protocolWhitelist = "http,https,tcp,tls,crypto,data"

    /// The temp-dir file name of part `index`, which is **1-based**: 1 -> `part-001.mp4`.
    /// Both the ffmpeg segment commands and yt-dlp (through `%(autonumber)03d`) write these names,
    /// so the job runner finds part `i` of either path under the same name.
    public static func partFileName(index: Int) -> String {
        "part-\(pad(index, width: 3)).mp4"
    }

    /// Seconds with exactly 3 decimals and a `.` separator, whatever the locale: 65.5 -> `65.500`.
    public static func seconds(_ value: Double) -> String {
        format(milliseconds: milliseconds(value))
    }

    /// ffmpeg arguments that download one segment into `output` (`<tmp>/part-NNN.mp4`).
    ///
    /// - `input`: the media URL (for HLS the chosen variant playlist, never the master).
    /// - `kind`: HLS inputs get `-extension_picky 0`, and in fast mode `-copypriorss 0` (see below).
    /// - `audio`: the separate HLS audio rendition, if any. It is a second input with its own
    ///   whitelist/headers (ffmpeg input options apply only to the next `-i`) and the same `-ss`.
    /// - `headers`: validated, canonically cased headers (`Referer`, `Origin`, `User-Agent`, `Cookie`).
    /// - `source`: the job's media URL, the one the headers were captured for. `Cookie` is sent
    ///   only to inputs on `source`'s origin (see `cookieArguments`).
    ///
    /// `-ss` comes before `-i` (input seeking), so ffmpeg fetches only the needed byte ranges.
    /// The HLS demuxer seeks only to the start of the media segment holding `-ss`, so with
    /// `-c copy` video would start up to a whole segment early while a separate audio rendition
    /// starts at `-ss`. `-copypriorss 0` drops packets before `-ss`: video then starts at the
    /// next keyframe, within one GOP. Not used for mp4, whose demuxer already seeks every stream
    /// to the keyframe before `-ss`.
    ///
    /// ffmpeg 7.1+ rejects HLS segments whose extension is not a known media one (some sites serve
    /// MPEG-TS as `file-0000.png`); `-extension_picky 0` lets them through. It is safe because
    /// `-protocol_whitelist` excludes `file`. HLS inputs only: the mp4 demuxer has no such option
    /// and ffmpeg exits on it.
    public static func ffmpegSegment(
        input: URL,
        kind: MediaKind,
        audio: URL?,
        headers: [String: String],
        source: URL,
        segment: Segment,
        precision: Precision,
        output: URL
    ) -> [String] {
        let startMs = milliseconds(segment.start)
        let durationMs = max(0, milliseconds(segment.end) - startMs)
        let start = format(milliseconds: startMs)

        var args = ["-hide_banner", "-nostdin", "-y"]
        args += inputArguments(url: input, kind: kind, source: source, start: start, headers: headers)
        if let audio {
            args += inputArguments(url: audio, kind: kind, source: source, start: start, headers: headers)
            args += ["-map", "0:v:0", "-map", "1:a:0"]
        }
        args += ["-t", format(milliseconds: durationMs)]
        switch precision {
        case .precise:
            args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-movflags", "+faststart"]
        case .fast:
            args += ["-c", "copy"]
            if kind == .hls {
                args += ["-copypriorss", "0"]
            }
            args += ["-avoid_negative_ts", "make_zero"]
        }
        args += ["-progress", "pipe:1", "-nostats", output.path]
        return args
    }

    /// ffmpeg arguments that join the parts listed in `list` (see `concatList`) into `output`.
    /// No `-protocol_whitelist` here: the concat demuxer needs the `file` protocol.
    public static func ffmpegMerge(list: URL, output: URL) -> [String] {
        [
            "-hide_banner", "-nostdin", "-y",
            "-f", "concat", "-safe", "0", "-i", list.path,
            "-c", "copy", "-movflags", "+faststart",
            output.path,
        ]
    }

    /// ffmpeg arguments that re-encode `input` into a smaller `output` mp4: H.264 CRF 28 and AAC 128k.
    /// Even width/height (libx264 rejects odd ones) and 8-bit 4:2:0 so every player can open it.
    public static func ffmpegCompress(input: URL, output: URL) -> [String] {
        [
            "-hide_banner", "-nostdin", "-y",
            "-i", input.path,
            "-c:v", "libx264", "-preset", "medium", "-crf", "28",
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
            output.path,
        ]
    }

    /// The `list.txt` text for parts 1...`partCount`: one `file 'part-NNN.mp4'` line each.
    /// Names come only from `partFileName`, never from external input; the concat demuxer
    /// resolves them relative to the list file's directory (the job's temp dir).
    public static func concatList(partCount: Int) -> String {
        guard partCount > 0 else { return "" }
        return (1...partCount).map { "file '\(partFileName(index: $0))'\n" }.joined()
    }

    /// yt-dlp arguments (secondary path) that download all `segments` of the page `url` into
    /// `tempDirectory` as `part-001.mp4`, `part-002.mp4`… in segment order.
    ///
    /// The plan's `%(section_number)03d` is not used: yt-dlp only sets `section_number` for chapter
    /// sections, so time ranges all render as `part-NA.mp4` and collide. `autonumber` increments
    /// once per downloaded section, in `--download-sections` order, starting at 1.
    ///
    /// `siteOnly` turns off yt-dlp's generic extractor (`--use-extractors default,-generic`), so a
    /// page without a site extractor fails fast with "No suitable extractor found".
    public static func ytDlp(
        url: URL,
        segments: [Segment],
        precision: Precision,
        ffmpeg: URL,
        tempDirectory: URL,
        siteOnly: Bool = false
    ) -> [String] {
        var args = ["--ignore-config"]
        if siteOnly {
            args += ["--use-extractors", "default,-generic"]
        }
        args += [
            "--no-playlist", "--newline",
            "-f", "bv*+ba/b",
            "--merge-output-format", "mp4",
            "--ffmpeg-location", ffmpeg.path,
        ]
        for segment in segments {
            args += ["--download-sections", "*\(seconds(segment.start))-\(seconds(segment.end))"]
        }
        if precision == .precise {
            args.append("--force-keyframes-at-cuts")
        }
        args += ["-P", tempDirectory.path, "-o", "part-%(autonumber)03d.%(ext)s"]
        args += ["--", url.absoluteString]
        return args
    }

    /// yt-dlp arguments that print only the title of the page `url`, without downloading.
    /// Site extractors only: the generic one would return the same page `<title>` as the tab.
    public static func ytDlpTitle(url: URL) -> [String] {
        [
            "--ignore-config", "--use-extractors", "default,-generic",
            "--skip-download", "--no-playlist", "--print", "title",
            "--", url.absoluteString,
        ]
    }

    // MARK: - Helpers

    /// Per-input options followed by `-ss S -i URL`.
    private static func inputArguments(
        url: URL, kind: MediaKind, source: URL, start: String, headers: [String: String]
    ) -> [String] {
        var args = ["-protocol_whitelist", protocolWhitelist]
        if kind == .hls {
            args += ["-extension_picky", "0"]
        }
        if let userAgent = headers["User-Agent"] {
            args += ["-user_agent", userAgent]
        }
        let headerLines = ffmpegHeaderNames.compactMap { name in
            headers[name].map { "\(name): \($0)\r\n" }
        }
        if !headerLines.isEmpty {
            args += ["-headers", headerLines.joined()]
        }
        args += cookieArguments(url: url, source: source, cookie: headers["Cookie"])
        args += ["-ss", start, "-i", url.absoluteString]
        return args
    }

    /// `-cookies` for an input on `source`'s origin (`RedirectGuard.sameOrigin`), else nothing: a
    /// `-headers` Cookie would go to every host the input's playlist, keys or redirects point at.
    /// Each cookie becomes one `name=value; domain=<host>` line, `<host>` being the input's Host
    /// value (attributes after the pair, so a cookie named `domain` cannot widen the scope; no `path`,
    /// which ffmpeg compares against the full URL behind a proxy). ffmpeg checks `domain` against the
    /// request's Host value as a plain suffix, so a host ending with the same name (`evilexample.com`
    /// for `example.com`) still gets the cookie, and a cookie the server refreshes without `Domain`
    /// may go to other hosts ffmpeg contacts next; see the README.
    private static func cookieArguments(url: URL, source: URL, cookie: String?) -> [String] {
        guard let cookie, RedirectGuard.sameOrigin(url, source), let host = ffmpegHost(url) else { return [] }
        let lines = cookie.split(separator: ";").compactMap { pair -> String? in
            let pair = pair.trimmingCharacters(in: .whitespaces)
            guard pair.contains("="), !pair.hasPrefix("=") else { return nil }
            return "\(pair); domain=\(host)\n"
        }
        return lines.isEmpty ? [] : ["-cookies", lines.joined()]
    }

    /// The Host value ffmpeg sends for `url`: lowercased host, IPv6 in brackets, `:port` only when
    /// the URL has one. Nil without a host.
    private static func ffmpegHost(_ url: URL) -> String? {
        guard let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        let name = host.contains(":") ? "[\(host)]" : host
        return url.port.map { "\(name):\($0)" } ?? name
    }

    /// Rounded whole milliseconds; non-finite or negative values become 0, and huge ones are
    /// capped (about 285 000 years) so the `Int` conversion cannot trap.
    private static func milliseconds(_ value: Double) -> Int {
        guard value.isFinite, value > 0 else { return 0 }
        return Int(min(value * 1000, 9e15).rounded())
    }

    /// Integer math only, so the output never depends on `Locale.current`.
    private static func format(milliseconds ms: Int) -> String {
        "\(ms / 1000).\(pad(ms % 1000, width: 3))"
    }

    private static func pad(_ value: Int, width: Int) -> String {
        let digits = String(value)
        return digits.count >= width ? digits : String(repeating: "0", count: width - digits.count) + digits
    }
}

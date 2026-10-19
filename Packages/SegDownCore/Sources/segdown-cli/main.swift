// Dev CLI for SegDownCore: a thin wrapper over Validation, Binaries and JobRunner.
//
//   segdown-cli --doctor
//   segdown-cli (--media URL [--hls] [--header "Name: value"]... | --page URL)
//               --seg A-B [--seg A-B]... [--merged] [--fast] [--out DIR] [--title T]
//
// Exit codes: 0 done, 1 failed or cancelled, 2 usage or validation error.
import Foundation
import SegDownCore

let usage = """
    usage: segdown-cli --doctor
           segdown-cli (--media URL [--hls] [--header "Name: value"]... | --page URL)
                       --seg A-B [--seg A-B]... [--merged] [--fast] [--out DIR] [--title T]
    """

func fail(_ message: String, code: Int32 = 2) -> Never {
    FileHandle.standardError.write(Data("segdown-cli: \(message)\n".utf8))
    exit(code)
}

// MARK: - Arguments

struct Options {
    var doctor = false
    var mediaURL: String?
    var pageURL: String?
    var hls = false
    var headers: [String: String] = [:]
    var segments: [Segment] = []
    var merged = false
    var fast = false
    var out: String?
    var title = "segdown-cli"
}

func parseSegment(_ text: String) -> Segment? {
    let parts = text.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count == 2, let start = Double(parts[0]), let end = Double(parts[1]) else { return nil }
    return Segment(start: start, end: end)
}

func parseOptions(_ arguments: [String]) -> Options {
    var options = Options()
    var iterator = arguments.makeIterator()
    func value(for flag: String) -> String {
        guard let value = iterator.next() else { fail("\(flag) needs a value\n\(usage)") }
        return value
    }
    while let argument = iterator.next() {
        switch argument {
        case "--doctor": options.doctor = true
        case "--media": options.mediaURL = value(for: argument)
        case "--page": options.pageURL = value(for: argument)
        case "--hls": options.hls = true
        case "--header":
            let header = value(for: argument)
            guard let colon = header.firstIndex(of: ":") else { fail("--header expects \"Name: value\"") }
            let name = header[..<colon].trimmingCharacters(in: .whitespaces)
            let headerValue = header[header.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard options.headers[name] == nil else { fail("duplicate header \(name)") }
            options.headers[name] = headerValue
        case "--seg":
            let text = value(for: argument)
            guard let segment = parseSegment(text) else { fail("--seg expects A-B in seconds, got \(text)") }
            options.segments.append(segment)
        case "--merged": options.merged = true
        case "--fast": options.fast = true
        case "--out": options.out = value(for: argument)
        case "--title": options.title = value(for: argument)
        case "-h", "--help":
            print(usage)
            exit(0)
        default: fail("unknown argument \(argument)\n\(usage)")
        }
    }
    return options
}

func makeRequest(_ options: Options) -> JobRequest {
    let source: Source
    switch (options.mediaURL, options.pageURL) {
    case let (media?, nil):
        guard let url = URL(string: media) else { fail("invalid --media URL") }
        source = .media(url: url, kind: options.hls ? .hls : .mp4, headers: options.headers,
                        variantURL: nil, audioURL: nil)
    case let (nil, page?):
        guard !options.hls, options.headers.isEmpty else { fail("--hls and --header only apply to --media") }
        guard let url = URL(string: page) else { fail("invalid --page URL") }
        source = .page(url: url)
    default:
        fail("give exactly one of --media or --page\n\(usage)")
    }
    return JobRequest(
        source: source, title: options.title, segments: options.segments,
        mode: options.merged ? .merged : .separate, precision: options.fast ? .fast : .precise
    )
}

// MARK: - Commands

func doctor() -> Never {
    let binaries = Binaries()
    for tool in Tool.allCases {
        print("\(tool.rawValue): \(binaries.url(for: tool)?.path ?? "MISSING")")
    }
    exit(binaries.missing().isEmpty ? 0 : 1)
}

func describe(_ status: JobStatus) -> String {
    let percent = String(format: "%5.1f%%", status.fraction * 100)
    let segment = "\(min(status.segmentIndex + 1, status.segmentCount))/\(status.segmentCount)"
    return "[\(status.state.rawValue)] \(percent) seg \(segment)" + (status.message.map { " \($0)" } ?? "")
}

func run(_ request: JobRequest, base: URL) async -> Int32 {
    let runner = JobRunner(baseDirectory: base)
    let job = await runner.start(request)

    // Ctrl+C cancels the job (SIGINT, then SIGTERM to the child) instead of killing the CLI.
    signal(SIGINT, SIG_IGN)
    let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    interrupt.setEventHandler {
        FileHandle.standardError.write(Data("segdown-cli: cancelling…\n".utf8))
        Task { await runner.cancel(id: job.id) }
    }
    interrupt.resume()

    var last: JobStatus?
    var lastLine = ""
    for await status in job.updates {
        last = status
        let line = describe(status)
        if line != lastLine { print(line) }
        lastLine = line
    }
    interrupt.cancel()

    guard let last else { return 1 }
    for path in last.outputs { print("output: \(path)") }
    return last.state == .done ? 0 : 1
}

// MARK: - Main

setvbuf(stdout, nil, _IOLBF, 0)
let options = parseOptions(Array(CommandLine.arguments.dropFirst()))
if options.doctor { doctor() }

let request: JobRequest
do {
    request = try Validation.validate(makeRequest(options))
} catch {
    fail("invalid request: \(error.localizedDescription)")
}
let base = options.out.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath, isDirectory: true) }
    ?? PathSanitizer.defaultBaseDirectory
exit(await run(request, base: base))

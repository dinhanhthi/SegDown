// segdown-host: the Chrome native messaging host, embedded at SegDown.app/Contents/MacOS.
// Chrome starts it with argv[1] = the caller origin. It relays each framed request on stdin to
// the menu bar app over the Unix socket (one connection per request) and writes the framed reply
// to stdout, launching the app hidden when it is not running. stdout carries frames only; logs go
// to stderr and never contain payloads.
import AppKit
import Foundation
import SegDownCore

/// Polling cadence and window for the socket after launching the app.
let retryInterval: TimeInterval = 0.25
let retryWindow: TimeInterval = 5
let launchTimeout: TimeInterval = 10

func log(_ message: String) {
    FileHandle.standardError.write(Data("segdown-host: \(message)\n".utf8))
}

/// Writes `response` as one frame on stdout; exits when stdout is gone.
func reply(_ response: IPCResponse) {
    do {
        var line = try IPC.encodeLine(response)
        line.removeLast()  // the frame carries the JSON object without the line's newline
        try NativeMessaging.writeFrame(line, to: STDOUT_FILENO)
    } catch {
        log("cannot write reply: \(error.localizedDescription)")
        exit(1)
    }
}

/// `SegDown.app` from this executable's resolved path (`<app>/Contents/MacOS/segdown-host`), or
/// nil when the host does not sit inside an app bundle.
func containingApp() -> URL? {
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    let app = executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return app.pathExtension == "app" ? app : nil
}

/// Opens `app` hidden, without activating it, and waits for the launch to finish (bounded).
func launch(_ app: URL) {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.hides = true
    let done = DispatchSemaphore(value: 0)
    NSWorkspace.shared.openApplication(at: app, configuration: configuration) { _, error in
        if let error { log("launch failed: \(error.localizedDescription)") }
        done.signal()
    }
    if done.wait(timeout: .now() + launchTimeout) == .timedOut { log("launch did not finish in time") }
}

/// Relays `request`; when the app is not running, launches it once and polls the socket.
func relay(_ request: IPCRequest) -> IPCResponse {
    let notRunning = IPCResponse.error(code: IPCResponse.ErrorCode.unavailable, message: "SegDown app is not running")
    do {
        return try IPC.send(request, timeout: IPC.defaultTimeout)
    } catch IPCError.appNotRunning {
        guard let app = containingApp() else {
            log("not inside an app bundle; cannot launch SegDown")
            return notRunning
        }
        launch(app)
        let deadline = Date().addingTimeInterval(retryWindow)
        while true {
            do {
                return try IPC.send(request, timeout: IPC.defaultTimeout)
            } catch IPCError.appNotRunning {
                if Date() >= deadline { return notRunning }
                Thread.sleep(forTimeInterval: retryInterval)
            } catch {
                return unavailable(error)
            }
        }
    } catch {
        return unavailable(error)
    }
}

func unavailable(_ error: any Error) -> IPCResponse {
    .error(code: IPCResponse.ErrorCode.unavailable, message: error.localizedDescription)
}

// Get EPIPE instead of being killed when Chrome closes the port mid-write.
signal(SIGPIPE, SIG_IGN)

let arguments = CommandLine.arguments
guard arguments.count >= 2, arguments[1] == ExtensionID.chromeOrigin else {
    log("rejected caller")
    reply(.error(code: IPCResponse.ErrorCode.invalid, message: "Unknown caller"))
    exit(1)
}

while true {
    let payload: Data
    do {
        guard let frame = try NativeMessaging.readFrame(from: STDIN_FILENO) else { exit(0) }
        payload = frame
    } catch {
        // Truncated, oversize or unreadable input leaves the stream out of sync: report and stop.
        log("bad frame: \(error.localizedDescription)")
        reply(.error(code: IPCResponse.ErrorCode.invalid, message: error.localizedDescription))
        exit(1)
    }

    let request: IPCRequest
    do {
        request = try NativeMessaging.decodeRequest(payload)
    } catch {
        reply(.error(code: IPCResponse.ErrorCode.invalid, message: error.localizedDescription))
        continue
    }

    reply(relay(request))
}

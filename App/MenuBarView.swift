// The menu bar window: dependency status, browser integration, job list, default precision and Quit.
import AppKit
import SegDownCore
import SwiftUI

struct MenuBarView: View {
    let store: JobStore
    @AppStorage(JobStore.defaultPrecisionKey) private var precision: Precision = .precise
    @State private var browsers: [HostManifestInstaller.Status] = []
    @State private var installError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            dependencies
            Divider()
            browserIntegration
            Divider()
            jobs
            Divider()
            Picker("Default precision", selection: $precision) {
                Text("Precise").tag(Precision.precise)
                Text("Fast").tag(Precision.fast)
            }
            .pickerStyle(.segmented)
            Divider()
            HStack {
                Spacer()
                Button("Quit SegDown") { NSApplication.shared.terminate(nil) }
                    .keyboardShortcut("q")
            }
        }
        .padding()
        .frame(width: 360)
        .onAppear {
            store.recheckDependencies()
            browsers = HostManifestInstaller.status()
        }
    }

    // MARK: - Dependencies

    private var dependencies: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Dependencies").font(.headline)
                Spacer()
                Button("Re-check") { store.recheckDependencies() }
            }
            ForEach(Tool.allCases, id: \.self) { tool in
                let installed = !store.missing.contains(tool)
                Label {
                    Text(tool.rawValue)
                } icon: {
                    Image(systemName: "circle.fill")
                        .foregroundStyle(installed ? .green : .red)
                        .imageScale(.small)
                }
            }
            if let hint = brewHint {
                Text(hint)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
            }
        }
    }

    /// One `brew install …` line for every missing tool. `ffprobe` ships in the `ffmpeg` formula.
    private var brewHint: String? {
        var formulas: [String] = []
        for tool in store.missing {
            let formula = tool == .ffprobe ? Tool.ffmpeg.rawValue : tool.rawValue
            if !formulas.contains(formula) { formulas.append(formula) }
        }
        return formulas.isEmpty ? nil : "brew install " + formulas.joined(separator: " ")
    }

    // MARK: - Browser integration

    private var browserIntegration: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Browser integration").font(.headline)
            let installed = browsers.filter(\.installed)
            if installed.isEmpty {
                Text("Not installed").foregroundStyle(.secondary)
            }
            ForEach(installed) { status in
                VStack(alignment: .leading, spacing: 1) {
                    Text(status.browser)
                    Text(status.manifestPath)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
            }
            if browsers.contains(where: \.stale) {
                Text("Re-install: the app moved since the browser integration was installed")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let installError {
                Text(installError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button("Install browser integration") { install() }
        }
    }

    private func install() {
        do {
            let written = try HostManifestInstaller.install()
            installError = written.isEmpty ? "No Chromium browser found" : nil
        } catch {
            installError = "Install failed: \(error.localizedDescription)"
        }
        browsers = HostManifestInstaller.status()
    }

    // MARK: - Jobs

    private var jobs: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Jobs").font(.headline)
                Spacer()
                Button("Clear finished") { store.clearFinished() }
                    .disabled(!store.items.contains { $0.status.state.isFinished })
            }
            if store.items.isEmpty {
                Text("No jobs yet").foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(store.items) { item in
                            JobRow(item: item, cancel: { store.cancel(item.id) })
                        }
                    }
                }
                .frame(maxHeight: 320)
            }
        }
    }
}

private struct JobRow: View {
    let item: JobStore.Item
    let cancel: () -> Void

    private var status: JobStatus { item.status }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(item.title.isEmpty ? "Untitled" : item.title)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Text(status.state.rawValue.capitalized)
                    .font(.caption)
                    .foregroundStyle(status.state == .failed ? .red : .secondary)
            }
            if !status.state.isFinished {
                HStack {
                    ProgressView(value: min(max(status.fraction, 0), 1))
                    Text("Segment \(min(status.segmentIndex + 1, status.segmentCount))/\(status.segmentCount)")
                        .font(.caption)
                        .monospacedDigit()
                }
            }
            if let message = status.message, !message.isEmpty {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                if !status.state.isFinished {
                    Button("Cancel", action: cancel)
                }
                if !status.outputs.isEmpty {
                    Button("Show in Finder") {
                        NSWorkspace.shared.activateFileViewerSelecting(
                            status.outputs.map { URL(fileURLWithPath: $0) }
                        )
                    }
                }
            }
            .controlSize(.small)
        }
    }
}

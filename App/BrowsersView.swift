// The Browsers page: the native messaging host manifest of each Chromium browser (install or reinstall),
// the folder Chromium browsers load the extension from, the state of the Safari extension, and when each
// browser last reached the app.
import SafariServices
import SegDownCore
import SwiftUI

struct BrowsersView: View {
    let store: JobStore
    @State private var statuses = HostManifestInstaller.status()
    @State private var safari = SafariState.unknown
    /// The outcome of the last install.
    @State private var message: (text: String, isError: Bool)?
    @State private var safariError: String?

    static let safariExtensionID = "com.math2it.segdown.safari"
    static let safariBundleID = "com.apple.Safari"

    enum SafariState {
        case on, off, unknown

        var title: String {
            switch self {
            case .on: "On"
            case .off: "Off"
            case .unknown: "Unknown"
            }
        }
    }

    var body: some View {
        Form {
            Section {
                ForEach(statuses) { status in
                    LabeledContent {
                        stateText(status)
                    } label: {
                        Text(status.browser)
                        Text(lastConnected(status.bundleID))
                    }
                }
                LabeledContent {
                    Button(statuses.contains(where: \.installed) ? "Reinstall" : "Install", action: install)
                } label: {
                    Text("Browser integration")
                    Text("Installs the native messaging host for every Chromium browser found.")
                }
                if let message {
                    Text(message.text)
                        .font(.caption)
                        .foregroundStyle(message.isError ? .red : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                LabeledContent {
                    HStack {
                        Text((ExtensionFolder.chromeURL().path(percentEncoded: false) as NSString).abbreviatingWithTildeInPath)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                        Button("Show in Finder", action: showExtensionFolder)
                            .buttonStyle(RowTextButtonStyle(formRow: true))
                        Button("Copy Path", action: copyExtensionPath)
                            .buttonStyle(RowTextButtonStyle(formRow: true))
                    }
                } label: {
                    Text("Extension folder")
                    Text("Load unpacked this folder once on your browser's extensions page, with Developer mode on. "
                        + "SegDown keeps it up to date with the app.")
                }
            } header: {
                HStack {
                    Text("Chromium browsers")
                    Spacer()
                    Button("Re-check", action: refresh)
                }
            }
            Section("Safari") {
                LabeledContent {
                    Text(safari.title).foregroundStyle(safari == .on ? .green : .secondary)
                } label: {
                    Text("SegDown extension")
                    Text(lastConnected(Self.safariBundleID))
                }
                LabeledContent {
                    Button("Open Safari Settings", action: openSafariSettings)
                } label: {
                    Text("Extensions")
                    Text("Turn SegDown on in Safari's Extensions settings.")
                }
                if let safariError {
                    Text(safariError)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .contentMargins(.top, 12, for: .scrollContent)
        .task { await refreshSafari() }
    }

    @ViewBuilder
    private func stateText(_ status: HostManifestInstaller.Status) -> some View {
        if status.stale {
            Text("Re-install: the app moved since the browser integration was installed")
                .foregroundStyle(.orange)
                .multilineTextAlignment(.trailing)
        } else if status.installed {
            Text("Installed").foregroundStyle(.green)
        } else {
            Text("Not installed").foregroundStyle(.secondary)
        }
    }

    private func lastConnected(_ bundleID: String) -> String {
        store.lastConnected[bundleID].map { "Last connected \($0.formatted(.relative(presentation: .named)))" }
            ?? "Not connected yet"
    }

    /// Selects the folder in Finder; beeps until the app has written it.
    private func showExtensionFolder() {
        let url = ExtensionFolder.chromeURL()
        guard FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) else {
            NSSound.beep()
            return
        }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    private func copyExtensionPath() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(ExtensionFolder.chromeURL().path(percentEncoded: false), forType: .string)
    }

    private func refresh() {
        statuses = HostManifestInstaller.status()
        message = nil
        safariError = nil
        Task { await refreshSafari() }
    }

    private func install() {
        do {
            let installed = try HostManifestInstaller.install()
            message = installed.isEmpty
                ? ("No Chromium browser found", true)
                : ("Installed for \(installed.joined(separator: ", "))", false)
        } catch {
            message = ("Install failed: \(error.localizedDescription)", true)
        }
        statuses = HostManifestInstaller.status()
    }

    /// The completion handler of `getStateOfSafariExtension` runs on the main actor, so its async form updates the
    /// state there without blocking it.
    private func refreshSafari() async {
        do {
            let state = try await SFSafariExtensionManager.stateOfSafariExtension(
                withIdentifier: Self.safariExtensionID)
            safari = state.isEnabled ? .on : .off
        } catch {
            safari = .unknown
        }
    }

    private func openSafariSettings() {
        Task {
            safariError = nil
            do {
                try await SFSafariApplication.showPreferencesForExtension(withIdentifier: Self.safariExtensionID)
            } catch {
                safariError = "Could not open Safari's settings: \(error.localizedDescription)"
            }
        }
    }
}

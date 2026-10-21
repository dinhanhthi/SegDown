// The Dependencies page: each Homebrew tool SegDown runs, found (with its path) or missing, its
// outdated formulas with an Upgrade button, and the `brew install …` line for the missing ones.
import SegDownCore
import SwiftUI

struct DependenciesView: View {
    let store: JobStore
    @State private var paths = Self.lookup()

    var body: some View {
        Form {
            Section {
                ForEach(Tool.allCases, id: \.self) { tool in
                    LabeledContent {
                        if let path = paths[tool] {
                            Text(path)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .textSelection(.enabled)
                        } else {
                            Text("Missing").foregroundStyle(.red)
                        }
                    } label: {
                        Label {
                            Text(tool.rawValue)
                        } icon: {
                            Image(systemName: paths[tool] == nil ? "xmark.circle.fill" : "checkmark.circle.fill")
                                .foregroundStyle(paths[tool] == nil ? .red : .green)
                        }
                    }
                }
            } header: {
                HStack {
                    Text("Tools")
                    Spacer()
                    Button("Re-check", action: recheck)
                }
            }
            Section {
                if store.checkingUpdates {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text("Checking for updates…")
                    }
                } else if let error = store.updateError {
                    Text(error)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                } else if store.outdated.isEmpty {
                    Text("All up to date").foregroundStyle(.secondary)
                }
                ForEach(store.outdated, id: \.name) { item in
                    LabeledContent {
                        if item.pinned {
                            Text("Pinned").foregroundStyle(.secondary)
                        } else if store.upgrading == item.name {
                            ProgressView().controlSize(.small)
                        } else {
                            Button("Upgrade") {
                                Task { await store.upgrade(item.name) }
                            }
                            .disabled(store.hasActiveJobs || store.upgrading != nil || store.checkingUpdates)
                        }
                    } label: {
                        Text(item.name)
                        Text("\(item.installedVersions.last ?? "?") → \(item.currentVersion)")
                    }
                }
            } header: {
                Text("Updates")
            } footer: {
                if store.hasActiveJobs && !store.outdated.isEmpty {
                    Text("Wait for downloads to finish to upgrade.")
                }
            }
            if let hint = brewHint {
                Section("Install the missing tools") {
                    Text(hint)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
        }
        .formStyle(.grouped)
        .task { await store.checkForUpdates(force: false) }
        .scrollContentBackground(.hidden)
        .contentMargins(.top, 12, for: .scrollContent)
    }

    private func recheck() {
        store.recheckDependencies()
        paths = Self.lookup()
        Task { await store.checkForUpdates(force: true) }
    }

    /// The path of every tool found.
    private static func lookup() -> [Tool: String] {
        let binaries = Binaries()
        return Dictionary(uniqueKeysWithValues: Tool.allCases.compactMap { tool in
            binaries.url(for: tool).map { (tool, $0.path) }
        })
    }

    /// One `brew install …` line for every missing tool. `ffprobe` ships in the `ffmpeg` formula.
    private var brewHint: String? {
        var formulas: [String] = []
        for tool in Tool.allCases where paths[tool] == nil {
            let formula = tool == .ffprobe ? Tool.ffmpeg.rawValue : tool.rawValue
            if !formulas.contains(formula) { formulas.append(formula) }
        }
        return formulas.isEmpty ? nil : "brew install " + formulas.joined(separator: " ")
    }
}

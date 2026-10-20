// The Dependencies page: each Homebrew tool SegDown runs, found (with its path) or missing, and the
// `brew install …` line for the missing ones.
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
            if let hint = brewHint {
                Section("Install the missing tools") {
                    Text(hint)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .contentMargins(.top, 12, for: .scrollContent)
    }

    private func recheck() {
        store.recheckDependencies()
        paths = Self.lookup()
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

// The Settings page: one grouped form over the window's glass; each change is saved at once through
// `SettingsStore.update`.
import AppKit
import SegDownCore
import SwiftUI

struct SettingsView: View {
    let store: JobStore
    let settings: SettingsStore
    @State private var sizeText = ""
    @State private var sizeUnit = SizeUnit.gb
    @State private var sizeError: String?
    @State private var durationText = ""
    @State private var durationError: String?
    @State private var confirmClear = false
    @FocusState private var focus: Field?

    private enum Field { case size, duration }

    enum SizeUnit: Int64, CaseIterable {
        case mb = 1_000_000
        case gb = 1_000_000_000

        var title: String { self == .mb ? "MB" : "GB" }
    }

    var body: some View {
        Form {
            Section("Output") {
                LabeledContent("Output folder") {
                    HStack {
                        Text((settings.settings.outputFolder as NSString).abbreviatingWithTildeInPath)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                        Button("Choose…", action: chooseFolder)
                    }
                }
                Picker("Default output", selection: setting(\.mode)) {
                    Text("Separate").tag(OutputMode.separate)
                    Text("Merged").tag(OutputMode.merged)
                }
                .pickerStyle(.segmented)
                Picker(selection: setting(\.precision)) {
                    Text("Precise").tag(Precision.precise)
                    Text("Fast").tag(Precision.fast)
                } label: {
                    Text("Default precision")
                    Text("Precise re-encodes for exact cuts; fast copies streams and cuts at keyframes.")
                }
                .pickerStyle(.segmented)
                switchRow(isOn: setting(\.autoFallback), title: "Auto fallback",
                          hint: "If yt-dlp fails, download the captured media instead.")
                switchRow(isOn: setting(\.compress), title: "Compress after download",
                          hint: "Re-encodes the files (H.264) to make them smaller; takes longer.")
            }
            Section("Limits") {
                switchRow(isOn: sizeLimited, title: "Limit size", hint: nil)
                if settings.settings.maxBytes != nil {
                    LabeledContent("Max size") {
                        HStack(spacing: 6) {
                            TextField("Max size", text: $sizeText)
                                .labelsHidden()
                                .multilineTextAlignment(.trailing)
                                .frame(width: 80)
                                .focused($focus, equals: .size)
                                .onSubmit(commitSize)
                            Picker("Unit", selection: unit) {
                                ForEach(SizeUnit.allCases, id: \.self) { Text($0.title).tag($0) }
                            }
                            .labelsHidden()
                            .pickerStyle(.menu)
                            .fixedSize()
                        }
                    }
                    if let sizeError { InlineError(text: sizeError) }
                }
                switchRow(isOn: durationLimited, title: "Limit total duration", hint: nil)
                if settings.settings.maxDuration != nil {
                    LabeledContent {
                        TextField("Max total duration", text: $durationText, prompt: Text("h:mm:ss"))
                            .labelsHidden()
                            .multilineTextAlignment(.trailing)
                            .frame(width: 100)
                            .focused($focus, equals: .duration)
                            .onSubmit(commitDuration)
                    } label: {
                        Text("Max total duration")
                        Text("h:mm:ss or m:ss, for all the segments of a job.")
                    }
                    if let durationError { InlineError(text: durationError) }
                }
            }
            Section("Privacy") {
                switchRow(isOn: setting(\.incognitoDefault), title: "Incognito by default",
                          hint: "Jobs are not kept in history; the browser does not keep their segments.")
            }
            Section("Browser") {
                switchRow(isOn: setting(\.fullClipButton), title: "Full clip button",
                          hint: "Adds a Full clip button to the overlay that downloads the whole video.")
                switchRow(isOn: setting(\.playerButton), title: "Button on video players",
                          hint: "Shows a SegDown button on a video while the pointer is over it.")
            }
            Section {
                LabeledContent {
                    Button("Clear history…") { confirmClear = true }
                } label: {
                    Text("History")
                    Text("Finished downloads in the list and in history. Files stay on disk.")
                }
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .contentMargins(.top, 12, for: .scrollContent)
        .onAppear(perform: loadFields)
        .onDisappear {
            commitSize()
            commitDuration()
        }
        .onChange(of: focus) { old, _ in
            if old == .size { commitSize() }
            if old == .duration { commitDuration() }
        }
        .alert("Remove all finished downloads from the list and history?", isPresented: $confirmClear) {
            Button("Clear History", role: .destructive) { store.clearHistory() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Files stay on disk.")
        }
    }

    /// A settings field for a control; each change is saved.
    private func setting<Value>(_ keyPath: WritableKeyPath<AppSettings, Value>) -> Binding<Value> {
        Binding(get: { settings.settings[keyPath: keyPath] }, set: { value in
            settings.update { $0[keyPath: keyPath] = value }
        })
    }

    /// A row with a title, an optional hint under it, and a `CompactSwitch` (which draws no label of its own).
    private func switchRow(isOn: Binding<Bool>, title: String, hint: String?) -> some View {
        LabeledContent {
            Toggle(title, isOn: isOn)
                .toggleStyle(CompactSwitch())
                .labelsHidden()
        } label: {
            Text(title)
            if let hint { Text(hint) }
        }
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(filePath: settings.settings.outputFolder, directoryHint: .isDirectory)
        panel.prompt = "Choose"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        settings.update { $0.outputFolder = url.path(percentEncoded: false) }
    }

    // MARK: - Limits

    /// A unit picked by the user saves the field in that unit.
    private var unit: Binding<SizeUnit> {
        Binding(get: { sizeUnit }, set: { unit in
            sizeUnit = unit
            commitSize()
        })
    }

    /// On: saves the field's value, or 1 GB when it is not valid. Off: no limit.
    private var sizeLimited: Binding<Bool> {
        Binding(get: { settings.settings.maxBytes != nil }, set: { on in
            sizeError = nil
            guard on else {
                settings.update { $0.maxBytes = nil }
                return
            }
            if Self.bytes(sizeText, unit: sizeUnit) == nil {
                sizeText = "1"
                sizeUnit = .gb
            }
            settings.update { $0.maxBytes = Self.bytes(sizeText, unit: sizeUnit) }
        })
    }

    /// On: saves the field's value, or 1:00:00 when it is not valid. Off: no limit.
    private var durationLimited: Binding<Bool> {
        Binding(get: { settings.settings.maxDuration != nil }, set: { on in
            durationError = nil
            guard on else {
                settings.update { $0.maxDuration = nil }
                return
            }
            if Self.seconds(durationText) == nil { durationText = "1:00:00" }
            settings.update { $0.maxDuration = Self.seconds(durationText) }
        })
    }

    private func loadFields() {
        if let bytes = settings.settings.maxBytes {
            sizeUnit = bytes >= SizeUnit.gb.rawValue ? .gb : .mb
            sizeText = (Double(bytes) / Double(sizeUnit.rawValue)).formatted(
                .number.precision(.fractionLength(0...2)).grouping(.never).locale(Locale(identifier: "en_US_POSIX")))
        }
        if let seconds = settings.settings.maxDuration {
            durationText = Self.format(seconds)
        }
    }

    /// Saves a valid size; an invalid one shows an error and keeps the saved value.
    private func commitSize() {
        guard settings.settings.maxBytes != nil else { return }
        guard let bytes = Self.bytes(sizeText, unit: sizeUnit) else {
            sizeError = "Enter a number greater than 0."
            return
        }
        sizeError = nil
        settings.update { $0.maxBytes = bytes }
    }

    /// Saves a valid duration; an invalid one shows an error and keeps the saved value.
    private func commitDuration() {
        guard settings.settings.maxDuration != nil else { return }
        guard let seconds = Self.seconds(durationText) else {
            durationError = "Enter a duration as h:mm:ss or m:ss, greater than 0."
            return
        }
        durationError = nil
        settings.update { $0.maxDuration = seconds }
    }

    /// "1.5" GB → 1_500_000_000; `nil` when not a number, ≤ 0, or too large.
    static func bytes(_ text: String, unit: SizeUnit) -> Int64? {
        let trimmed = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        guard let value = Double(trimmed), value.isFinite, value > 0,
              let bytes = Int64(exactly: (value * Double(unit.rawValue)).rounded()), bytes > 0
        else { return nil }
        return bytes
    }

    /// "1:30:00" or "90:00" → 5400; each part after the first is below 60; `nil` when invalid or 0.
    static func seconds(_ text: String) -> Double? {
        let parts = text.trimmingCharacters(in: .whitespaces).split(separator: ":", omittingEmptySubsequences: false)
        guard (2...3).contains(parts.count),
              parts.allSatisfy({ !$0.isEmpty && $0.count <= 6 && $0.allSatisfy { $0.isASCII && $0.isNumber } })
        else { return nil }
        let numbers = parts.compactMap { Int($0) }
        guard numbers.count == parts.count, numbers.dropFirst().allSatisfy({ $0 < 60 }) else { return nil }
        let total = numbers.reduce(0) { $0 * 60 + $1 }
        return total > 0 ? Double(total) : nil
    }

    /// 5400 → "1:30:00", 90 → "1:30".
    static func format(_ seconds: Double) -> String {
        let total = seconds.isFinite ? Int(min(max(seconds, 0), 9e15).rounded()) : 0
        let (hours, minutes, secs) = (total / 3600, total / 60 % 60, total % 60)
        let ss = String(format: "%02d", secs)
        return hours > 0 ? "\(hours):\(String(format: "%02d", minutes)):\(ss)" : "\(minutes):\(ss)"
    }
}

/// A validation message under a field.
private struct InlineError: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(.red)
    }
}

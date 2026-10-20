// The Downloads page: one card per job, newest first, with selection and remove-with-confirmation.
import AppKit
import SegDownCore
import SwiftUI

/// The jobs as cards. Click selects one, ⌘-click toggles, ⇧-click extends from the last clicked card; ⌘A (the Edit
/// menu's Select All) and ⌫ work while the page has focus, which a click on a card gives it.
struct DownloadsView: View {
    let store: JobStore
    @State private var selection: Set<String> = []
    @State private var anchor: String?
    @State private var confirmRemove = false
    @State private var trashFiles = false
    @State private var trashFailures: [JobStore.TrashFailure] = []
    /// Shown once the sheet is gone: a window shows one sheet or alert at a time.
    @State private var pendingFailures: [JobStore.TrashFailure] = []
    @FocusState private var focused: Bool

    var body: some View {
        Group {
            if store.items.isEmpty {
                EmptyDownloads()
            } else {
                list
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        .onCommand(#selector(NSResponder.selectAll(_:))) {
            selection = Set(store.items.map(\.id))
        }
        .onDeleteCommand(perform: askRemove)
        // Jobs that left the list (trimmed, history cleared, removed) are not selected.
        .onChange(of: store.items.map(\.id)) { _, ids in
            selection.formIntersection(ids)
        }
        .sheet(isPresented: $confirmRemove, onDismiss: {
            trashFailures = pendingFailures
            pendingFailures = []
        }) {
            RemoveSheet(count: selection.count, trashFiles: $trashFiles, remove: {
                pendingFailures = store.remove(ids: selection, trashFiles: trashFiles)
                selection.removeAll()
                confirmRemove = false
            }, cancel: { confirmRemove = false })
        }
        .alert("Some files were not moved to the Trash", isPresented: failuresShown) {
            Button("OK") {}
        } message: {
            Text(trashFailures.map { "\(URL(filePath: $0.path).lastPathComponent): \($0.message)" }
                .joined(separator: "\n"))
        }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                ForEach(store.items) { item in
                    DownloadCard(item: item, store: store, selected: selection.contains(item.id))
                        .contentShape(Rectangle())
                        .onTapGesture { select(item.id) }
                        .highPriorityGesture(TapGesture().modifiers(.command).onEnded { toggle(item.id) },
                                             including: .all)
                        .highPriorityGesture(TapGesture().modifiers(.shift).onEnded { extend(to: item.id) },
                                             including: .all)
                }
            }
            .padding(12)
        }
        .modifier(HardTopScrollEdge())
        .safeAreaInset(edge: .top, spacing: 0) {
            header
                .padding(.horizontal, 12)
                .padding(.top, 12)
                // Cards scrolling under the header do not show through around it.
                .background(WindowGlass())
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text(selection.isEmpty ? "Downloads" : "\(selection.count) selected")
                .font(.headline)
            Spacer()
            Button(action: askRemove) {
                Label("Remove", systemImage: "trash")
            }
            .disabled(selection.isEmpty)
            .help("Remove the selected downloads (⌫)")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .modifier(GlassCard(cornerRadius: 20, raised: true))
    }

    private var failuresShown: Binding<Bool> {
        Binding(get: { !trashFailures.isEmpty }, set: { if !$0 { trashFailures = [] } })
    }

    private func askRemove() {
        guard !selection.isEmpty else { return }
        trashFiles = false
        confirmRemove = true
    }

    private func select(_ id: String) {
        selection = [id]
        anchor = id
        focused = true
    }

    private func toggle(_ id: String) {
        if selection.contains(id) { selection.remove(id) } else { selection.insert(id) }
        anchor = id
        focused = true
    }

    /// Adds the cards from the anchor to `id`, in list order; without an anchor, selects `id` alone.
    private func extend(to id: String) {
        let ids = store.items.map(\.id)
        guard let anchor, let from = ids.firstIndex(of: anchor), let to = ids.firstIndex(of: id) else {
            select(id)
            return
        }
        selection.formUnion(ids[min(from, to)...max(from, to)])
        focused = true
    }
}

/// One job: title, state, segment, duration, size, progress, message and its buttons. Selected adds an accent fill
/// and stroke.
private struct DownloadCard: View {
    let item: JobStore.Item
    let store: JobStore
    let selected: Bool

    var body: some View {
        let status = item.status
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if item.incognito {
                    Image(systemName: "eye.slash")
                        .foregroundStyle(.secondary)
                        .help("Incognito: not kept in the history")
                        .accessibilityLabel("Incognito")
                }
                // Page titles are untrusted: plain text, never markdown.
                Text(verbatim: item.title)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(item.title)
                Spacer(minLength: 8)
                StateBadge(state: status.state)
            }
            HStack(spacing: 12) {
                Text("Segment \(min(status.segmentIndex + 1, status.segmentCount))/\(status.segmentCount)")
                Text(verbatim: Self.durationText(item.totalDuration))
                Text(verbatim: item.bytes.map { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) } ?? "—")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .monospacedDigit()
            if status.state == .running {
                ProgressView(value: min(max(status.fraction, 0), 1))
            }
            if item.fallbackUsed {
                Text("Switched to the captured media")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let message = status.message {
                Text(verbatim: message)
                    .font(.caption)
                    .foregroundStyle(status.state == .failed ? .red : .secondary)
                    .lineLimit(3)
            }
            HStack(spacing: 14) {
                if !status.outputs.isEmpty {
                    rowButton("Show in Finder", systemImage: "folder", action: showInFinder)
                }
                if !status.state.isFinished {
                    rowButton("Cancel", systemImage: "xmark.circle") { store.cancel(item.id) }
                }
            }
            .padding(.top, 2)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The fill sits under the content, on the surface; the stroke on top.
        .background {
            if selected { Self.shape.fill(Color.accentColor.opacity(0.18)) }
        }
        .modifier(GlassCard(cornerRadius: 20, raised: true))
        .overlay {
            if selected { Self.shape.strokeBorder(Color.accentColor, lineWidth: 1.5).allowsHitTesting(false) }
        }
    }

    /// The `GlassCard` shape, for the selection.
    private static let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)

    /// m:ss, or h:mm:ss from one hour; the same digits in every locale.
    static func durationText(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        let (hours, minutes, secs) = (total / 3_600, total % 3_600 / 60, total % 60)
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, secs)
            : String(format: "%d:%02d", minutes, secs)
    }

    private func rowButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .labelStyle(.iconOnly)
                .font(.system(size: 15))
        }
        .buttonStyle(RowIconButtonStyle())
        .foregroundStyle(.secondary)
        .help(title)
    }

    /// The outputs still on disk; a beep when none is left.
    private func showInFinder() {
        let urls = item.status.outputs.filter { FileManager.default.fileExists(atPath: $0) }.map { URL(filePath: $0) }
        if urls.isEmpty {
            NSSound.beep()
        } else {
            NSWorkspace.shared.activateFileViewerSelecting(urls)
        }
    }
}

/// The job's state as a small colored capsule.
private struct StateBadge: View {
    let state: JobState

    var body: some View {
        let (title, color): (String, Color) = switch state {
        case .queued: ("Queued", .secondary)
        case .running: ("Running", .accentColor)
        case .done: ("Done", .green)
        case .failed: ("Failed", .red)
        case .cancelled: ("Cancelled", .orange)
        }
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.15)))
    }
}

/// The confirmation: the count and "Also move files to Trash" (off by default).
private struct RemoveSheet: View {
    let count: Int
    @Binding var trashFiles: Bool
    let remove: () -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(count == 1 ? "Remove 1 download?" : "Remove \(count) downloads?")
                .font(.headline)
            Text("Running downloads are cancelled. Files stay on disk unless you move them to the Trash.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Toggle("Also move files to Trash", isOn: $trashFiles)
                .toggleStyle(.checkbox)
            HStack {
                Spacer()
                Button("Cancel", action: cancel)
                    .keyboardShortcut(.cancelAction)
                Button("Remove", role: .destructive, action: remove)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 360)
    }
}

/// No jobs yet: how to start one from the browser.
private struct EmptyDownloads: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("No downloads yet", systemImage: "arrow.down.circle")
                .font(.title3.weight(.semibold))
            Text("To download part of a video from your browser:")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 6) {
                Text("1. Open a page with a video.")
                Text("2. Click the SegDown toolbar button, or press Alt+Shift+S.")
                Text("3. Mark the segments you want.")
                Text("4. Click Download.")
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .frame(maxWidth: 420, alignment: .leading)
        .modifier(GlassCard(cornerRadius: 20))
        .padding(12)
    }
}

// The Downloads page: one card per job, newest first, with selection; remove from the list, or also move the files to
// the Trash after a confirmation.
import AppKit
import SegDownCore
import SwiftUI

/// The jobs as cards. Click selects one, ⌘-click toggles, ⇧-click extends from the last clicked card; ⌘A (the Edit
/// menu's Select All) and ⌫ (remove from the list) work while the page has focus, which a click on a card gives it.
struct DownloadsView: View {
    let store: JobStore
    @State private var selection: Set<String> = []
    @State private var anchor: String?
    @State private var confirmTrash = false
    /// The jobs the Trash sheet is about: the selection, or every job for Move All to Trash.
    @State private var trashIDs: Set<String> = []
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
        .onDeleteCommand(perform: removeFromList)
        // Jobs that left the list (trimmed, history cleared, removed) are not selected.
        .onChange(of: store.items.map(\.id)) { _, ids in
            selection.formIntersection(ids)
        }
        .sheet(isPresented: $confirmTrash, onDismiss: {
            trashFailures = pendingFailures
            pendingFailures = []
        }) {
            TrashSheet(count: trashIDs.count, remove: {
                pendingFailures = store.remove(ids: trashIDs, trashFiles: true)
                selection.subtract(trashIDs)
                confirmTrash = false
            }, cancel: { confirmTrash = false })
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
                    DownloadCard(item: item, store: store, selected: selection.contains(item.id),
                                 remove: { removeFromList(ids: [item.id]) },
                                 trash: { askTrash(ids: [item.id]) })
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
            Text("Downloads")
                .font(.title2.weight(.semibold))
            Text(verbatim: String(store.items.count))
                .font(.callout.weight(.semibold))
                .monospacedDigit()
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .background(Capsule().fill(Palette.inputSurface))
                .accessibilityLabel(store.items.count == 1 ? "1 download" : "\(store.items.count) downloads")
            if !selection.isEmpty {
                Text("\(selection.count) selected")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Spacer()
            // One download has its own Remove menu on its card.
            if selection.count > 1 {
                Menu {
                    Button("Remove from List", action: removeFromList)
                    Button("Move to Trash…", action: askTrash)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "trash").accessibilityLabel("Remove")
                        MenuChevron()
                    }
                }
                .menuStyle(.button)
                .buttonStyle(RaisedButtonStyle(horizontalPadding: 10))
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Remove the selected downloads from the list (⌫), or also move their files to the Trash")
            }
            Menu {
                Button("Remove All from List", action: removeAllFromList)
                Button("Move All to Trash…", action: askTrashAll)
            } label: {
                HStack(spacing: 4) {
                    Text("Remove All")
                    MenuChevron()
                }
            }
            .menuStyle(.button)
            .buttonStyle(RaisedButtonStyle(horizontalPadding: 10))
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Remove every download from the list, or also move their files to the Trash")
        }
        // Straight on the window glass, not a card, so it does not read as one of the downloads.
        .padding(.horizontal, 4)
        .padding(.bottom, 4)
    }

    private var failuresShown: Binding<Bool> {
        Binding(get: { !trashFailures.isEmpty }, set: { if !$0 { trashFailures = [] } })
    }

    /// Running downloads are cancelled; files stay on disk.
    private func removeFromList() {
        guard !selection.isEmpty else { return }
        store.remove(ids: selection, trashFiles: false)
        selection.removeAll()
    }

    /// One card's Remove menu: running downloads are cancelled; files stay on disk.
    private func removeFromList(ids: Set<String>) {
        store.remove(ids: ids, trashFiles: false)
        selection.subtract(ids)
    }

    private func askTrash() {
        guard !selection.isEmpty else { return }
        askTrash(ids: selection)
    }

    private func askTrash(ids: Set<String>) {
        trashIDs = ids
        confirmTrash = true
    }

    /// Running downloads are cancelled; files stay on disk.
    private func removeAllFromList() {
        store.remove(ids: Set(store.items.map(\.id)), trashFiles: false)
        selection.removeAll()
    }

    private func askTrashAll() {
        trashIDs = Set(store.items.map(\.id))
        confirmTrash = true
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

/// One job: title, Reveal in Finder, Remove and state, segment, duration, size, progress, then the message and Cancel.
/// Selected adds an accent fill and stroke.
private struct DownloadCard: View {
    let item: JobStore.Item
    let store: JobStore
    let selected: Bool
    /// Remove from List, and Move to Trash… (which asks first), for this job alone.
    let remove: () -> Void
    let trash: () -> Void

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
                if !status.outputs.isEmpty {
                    Button(action: showInFinder) {
                        Label("Reveal in Finder", systemImage: "folder")
                            .labelStyle(.iconOnly)
                            .font(.system(size: 12))
                    }
                    .buttonStyle(RaisedButtonStyle(height: 26))
                    .help("Reveal in Finder")
                }
                Menu {
                    Button("Remove from List", action: remove)
                    Button("Move to Trash…", action: trash)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "trash").accessibilityLabel("Remove")
                        MenuChevron()
                    }
                    .font(.system(size: 12))
                }
                .menuStyle(.button)
                .buttonStyle(RaisedButtonStyle(height: 26, horizontalPadding: 9))
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Remove the download from the list, or also move its files to the Trash")
                StateBadge(state: status.state)
            }
            HStack(spacing: 12) {
                Text("Segment \(min(status.segmentIndex + 1, status.segmentCount))/\(status.segmentCount)")
                Text(verbatim: Self.durationText(item.totalDuration))
                Text(verbatim: item.bytes.map { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) } ?? "—")
            }
            .font(.callout)
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
            if status.message != nil || !status.state.isFinished {
                HStack(spacing: 8) {
                    if let message = status.message {
                        Text(verbatim: message)
                            .font(.caption)
                            .foregroundStyle(status.state == .failed ? .red : .secondary)
                            .lineLimit(3)
                    }
                    Spacer(minLength: 8)
                    if !status.state.isFinished {
                        Button("Cancel") { store.cancel(item.id) }
                            .buttonStyle(RowTextButtonStyle())
                            .fixedSize()
                            .help("Cancel the download")
                    }
                }
            }
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
        let solid = state == .running
        Text(title)
            .font(.caption.weight(.semibold))
            // Running is solid accent with white text: the accent on its own tint was hard to read.
            .foregroundStyle(solid ? Color.white : color)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(Capsule().fill(solid ? color : color.opacity(0.15)))
    }
}

/// The confirmation before the files go to the Trash.
private struct TrashSheet: View {
    let count: Int
    let remove: () -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(count == 1 ? "Move 1 download to the Trash?" : "Move \(count) downloads to the Trash?")
                .font(.headline)
            Text("Running downloads are cancelled, the downloads leave the list and their files go to the Trash.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel", action: cancel)
                    .keyboardShortcut(.cancelAction)
                Button("Move to Trash", role: .destructive, action: remove)
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

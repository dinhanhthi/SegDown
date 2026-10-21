// The Downloads page: one card per job, newest first, with selection; remove from the list, or also move the files to
// the Trash after a confirmation. The Archived button switches between the downloads and the archived ones; Search
// filters the cards shown by title.
import AppKit
import SegDownCore
import SwiftUI

/// The jobs as cards. Click selects one, ⌘-click toggles, ⇧-click extends from the last clicked card; ⌘A (the Edit
/// menu's Select All) and ⌫ (remove from the list) work while the page has focus, which a click on a card gives it.
/// The list shows either the downloads or, with the Archived button on, the archived ones; the header, selection and
/// Remove All act on the list shown. Search grows into a field beside the title and fuzzy-filters that list by title,
/// best match first; X or Escape closes it and shows the whole list again.
struct DownloadsView: View {
    let store: JobStore
    @State private var selection: Set<String> = []
    /// The archived list instead of the downloads; the Archived button shows once a download is archived.
    @State private var showArchived = false
    @State private var anchor: String?
    @State private var confirmTrash = false
    /// The jobs the Trash sheet is about: the selection, or every job shown for Move All to Trash.
    @State private var trashIDs: Set<String> = []
    @State private var trashFailures: [JobStore.TrashFailure] = []
    /// Shown once the sheet is gone: a window shows one sheet or alert at a time.
    @State private var pendingFailures: [JobStore.TrashFailure] = []
    @FocusState private var focused: Bool
    /// The search field in place of the header; `expanded` grows it from the Search button's place to the rest of the row.
    @State private var searching = false
    @State private var expanded = false
    @State private var query = ""
    @FocusState private var searchFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The jobs of the list shown, before the search: the downloads, or the archived ones.
    private var scoped: [JobStore.Item] {
        store.items.filter { $0.archived == showArchived }
    }

    /// The jobs of the list shown, matching the search best first while there is a query.
    private var shown: [JobStore.Item] {
        query.trimmingCharacters(in: .whitespaces).isEmpty
            ? scoped
            : FuzzyMatch.rank(scoped, query: query) { $0.title }
    }

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
        // Not while typing in the search field: ⌫ and ⌘A are the field's then.
        .onCommand(#selector(NSResponder.selectAll(_:))) {
            if !searchFocused { selection = Set(shown.map(\.id)) }
        }
        .onDeleteCommand {
            if !searchFocused { removeFromList() }
        }
        // Jobs that left the list (trimmed, history cleared, removed, archived, the other list shown) are not selected.
        .onChange(of: shown.map(\.id)) { _, ids in
            selection.formIntersection(ids)
        }
        // The last archived job unarchived or removed: back to the downloads, as the Archived button is gone.
        .onChange(of: store.items.contains(where: \.archived)) { _, anyArchived in
            if !anyArchived { showArchived = false }
        }
        // Every job gone: the empty page replaces the header, so the next download is not hidden by an old search.
        .onChange(of: store.items.isEmpty) { _, empty in
            guard empty else { return }
            query = ""
            expanded = false
            searching = false
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
            // The header stays, so the Archived button can switch back.
            if shown.isEmpty {
                Text(scoped.isEmpty ? "No downloads" : "No matching downloads")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
            LazyVStack(spacing: 10) {
                ForEach(shown) { item in
                    DownloadCard(item: item, store: store, selected: selection.contains(item.id),
                                 remove: { removeFromList(ids: [item.id]) },
                                 trash: { askTrash(ids: [item.id]) },
                                 archive: { toggleArchived(item) })
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

    /// The title and count stay while searching; the search field takes the rest of the row.
    private var header: some View {
        HStack(spacing: 12) {
            Text(showArchived ? "Archived" : "Downloads")
                .font(.title2.weight(.semibold))
            Text(verbatim: String(shown.count))
                .font(.callout.weight(.semibold))
                .monospacedDigit()
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .background(Capsule().fill(Palette.inputSurface))
                .accessibilityLabel(shown.count == 1 ? "1 download" : "\(shown.count) downloads")
            if searching {
                searchBar
            } else {
                buttons
            }
        }
        // Straight on the window glass, not a card, so it does not read as one of the downloads.
        .padding(.horizontal, 4)
        .padding(.bottom, 4)
    }

    private var buttons: some View {
        HStack(spacing: 12) {
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
                .buttonStyle(RaisedButtonStyle(height: Self.controlHeight, horizontalPadding: 10))
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Remove the selected downloads from the list (⌫), or also move their files to the Trash")
            }
            if store.items.contains(where: \.archived) {
                Button {
                    showArchived.toggle()
                    selection.removeAll()
                } label: {
                    Label("Archived", systemImage: showArchived ? "archivebox.fill" : "archivebox")
                        .labelStyle(.iconOnly)
                        .foregroundStyle(showArchived ? Color.accentColor : .primary)
                }
                .buttonStyle(RaisedButtonStyle(height: Self.controlHeight))
                .help(showArchived ? "Show downloads" : "Show archived downloads")
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
            .buttonStyle(RaisedButtonStyle(height: Self.controlHeight, horizontalPadding: 10))
            .menuIndicator(.hidden)
            .fixedSize()
            .disabled(shown.isEmpty)
            .help("Remove every download from the list, or also move their files to the Trash")
            Button {
                searching = true
            } label: {
                Label("Search", systemImage: "magnifyingglass")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(RaisedButtonStyle(height: Self.controlHeight))
            .help("Search downloads")
        }
    }

    /// A capsule as wide as the Search button at its place, at the trailing edge, that grows to the rest of the row once
    /// shown; closing shrinks it back before the buttons return.
    private var searchBar: some View {
        HStack(spacing: 0) {
            Image(systemName: "magnifyingglass")
                .frame(width: Self.controlHeight, height: Self.controlHeight)
            TextField("Search downloads", text: $query)
                .textFieldStyle(.plain)
                .focused($searchFocused)
                .onExitCommand(perform: closeSearch)
                .opacity(expanded ? 1 : 0)
            Button(action: closeSearch) {
                Image(systemName: "xmark")
                    .frame(width: Self.controlHeight, height: Self.controlHeight)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Close search (Esc)")
            .opacity(expanded ? 1 : 0)
        }
        .frame(width: expanded ? nil : Self.controlHeight, height: Self.controlHeight, alignment: .leading)
        .clipped()
        .background(Capsule().fill(Palette.inputSurface))
        .overlay(Capsule().strokeBorder(Palette.surfaceBorder, lineWidth: 1).allowsHitTesting(false))
        .frame(maxWidth: .infinity, alignment: .trailing)
        .onAppear {
            withAnimation(reduceMotion ? nil : Self.searchAnimation) { expanded = true }
            // On the next pass: the field is not in the window yet, so the page would keep the keys.
            DispatchQueue.main.async { searchFocused = true }
        }
    }

    /// The header's buttons and search bar, a little taller than the cards' buttons.
    private static let controlHeight: CGFloat = 32

    /// The search bar growing and shrinking.
    private static let searchAnimation = Animation.snappy(duration: 0.3)

    /// Clears the query, so the whole list shows at once, then shrinks the bar back into the Search button. The field
    /// lets go of the keys first (nothing typed while it shrinks), and the page takes them back for ⌫ and ⌘A.
    private func closeSearch() {
        searchFocused = false
        query = ""
        guard !reduceMotion else {
            expanded = false
            searching = false
            focused = true
            return
        }
        withAnimation(Self.searchAnimation) { expanded = false } completion: {
            searching = false
            focused = true
        }
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

    /// One card's Archive button: the card leaves the list it was in.
    private func toggleArchived(_ item: JobStore.Item) {
        store.setArchived(ids: [item.id], archived: !item.archived)
        selection.remove(item.id)
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
        store.remove(ids: Set(shown.map(\.id)), trashFiles: false)
        selection.removeAll()
    }

    private func askTrashAll() {
        trashIDs = Set(shown.map(\.id))
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
        let ids = shown.map(\.id)
        guard let anchor, let from = ids.firstIndex(of: anchor), let to = ids.firstIndex(of: id) else {
            select(id)
            return
        }
        selection.formUnion(ids[min(from, to)...max(from, to)])
        focused = true
    }
}

/// One job: title and state, then segment, duration, size, progress, then the buttons: Open Page, Reveal in Finder,
/// Archive or Unarchive, and Remove, with the message and Cancel on the right. Selected adds an accent fill and stroke.
private struct DownloadCard: View {
    let item: JobStore.Item
    let store: JobStore
    let selected: Bool
    /// Remove from List, and Move to Trash… (which asks first), for this job alone.
    let remove: () -> Void
    let trash: () -> Void
    /// Archive, or Unarchive when archived, without asking.
    let archive: () -> Void

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
                    .foregroundStyle(item.bytes.flatMap(Self.sizeColor) ?? .secondary)
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            .monospacedDigit()
            if status.state == .running {
                ProgressView(value: min(max(status.fraction, 0), 1))
            }
            if item.fallbackUsed {
                Label("Switched to the captured media", systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            // An error gets its own row above the buttons; other messages sit beside them.
            if status.state == .failed, let message = status.message {
                Text(verbatim: message)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(3)
            }
            HStack(spacing: 8) {
                if let pageURL = item.pageURL {
                    Button { NSWorkspace.shared.open(pageURL) } label: {
                        Label("Open Page", systemImage: "safari")
                            .labelStyle(.iconOnly)
                            .font(.system(size: 12))
                    }
                    .buttonStyle(RaisedButtonStyle(height: 26))
                    // Page URLs are untrusted: shown as plain text only.
                    .help(Text(verbatim: pageURL.absoluteString))
                }
                if !status.outputs.isEmpty {
                    Button(action: showInFinder) {
                        Label("Reveal in Finder", systemImage: "folder")
                            .labelStyle(.iconOnly)
                            .font(.system(size: 12))
                    }
                    .buttonStyle(RaisedButtonStyle(height: 26))
                    .help("Reveal in Finder")
                }
                Button(action: archive) {
                    Group {
                        if item.archived {
                            Label("Unarchive", systemImage: "tray.and.arrow.up")
                        } else {
                            Label("Archive", systemImage: "archivebox")
                        }
                    }
                    .labelStyle(.iconOnly)
                    .font(.system(size: 12))
                }
                .buttonStyle(RaisedButtonStyle(height: 26))
                .help(item.archived ? "Unarchive" : "Archive")
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
                Spacer(minLength: 8)
                if status.state != .failed, let message = status.message {
                    Text(verbatim: message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                if !status.state.isFinished {
                    Button("Cancel") { store.cancel(item.id) }
                        .buttonStyle(RowTextButtonStyle())
                        .fixedSize()
                        .help("Cancel the download")
                }
            }
            .padding(.top, 6)
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

    /// Heavier files stand out more: plain under 100 MB, then yellow, orange from 500 MB, red from 1 GB, purple from
    /// 2 GB (decimal units, as `ByteCountFormatter` shows them).
    static func sizeColor(_ bytes: Int64) -> Color? {
        switch bytes {
        case 2_000_000_000...: .purple
        case 1_000_000_000...: .red
        case 500_000_000...: .orange
        case 100_000_000...: .yellow
        default: nil
        }
    }

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

/// The job's state as a colored capsule, as tall as the card's buttons.
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
            .font(.callout.weight(.semibold))
            // Running is solid accent with white text: the accent on its own tint was hard to read.
            .foregroundStyle(solid ? Color.white : color)
            .padding(.horizontal, 10)
            .frame(height: 26)
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

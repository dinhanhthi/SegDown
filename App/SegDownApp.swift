// Menu bar app entry point. The status item is an SF Symbol (a template image that follows light,
// dark and tinted menu bars), not the full-colour logo, which blurs at menu bar size.
import SwiftUI

@main
struct SegDownApp: App {
    @State private var settings: SettingsStore
    /// Created at launch (not on first menu open) so the IPC server can use it right away.
    @State private var store: JobStore

    init() {
        let settings = SettingsStore()
        _settings = State(initialValue: settings)
        _store = State(initialValue: JobStore(settings: settings))
    }

    var body: some Scene {
        MenuBarExtra("SegDown", systemImage: "scissors") {
            MenuBarView(store: store, settings: settings)
        }
        .menuBarExtraStyle(.window)
    }
}

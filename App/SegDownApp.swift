// Menu bar app entry point. The status item is an SF Symbol (a template image that follows light,
// dark and tinted menu bars), not the full-colour logo, which blurs at menu bar size.
import SwiftUI

@main
struct SegDownApp: App {
    /// Created at launch (not on first menu open) so the IPC server can use it right away.
    @State private var store = JobStore()

    var body: some Scene {
        MenuBarExtra("SegDown", systemImage: "scissors") {
            MenuBarView(store: store)
        }
        .menuBarExtraStyle(.window)
    }
}

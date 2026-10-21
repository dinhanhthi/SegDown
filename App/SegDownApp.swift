import AppKit
import SwiftUI

/// AppKit entry point: no SwiftUI `App`, so SwiftUI is only loaded inside the window.
@main
@MainActor
enum SegDownApp {
    // NSApplication.delegate is weak; keep the delegate alive for the app lifetime.
    private static let delegate = AppDelegate()

    static func main() {
        let app = NSApplication.shared
        app.delegate = delegate
        app.run()
    }
}

/// Owns the stores, the status item and the one main window for the app lifetime.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuItemValidation {
    let settings: SettingsStore
    /// Created at launch (not on first window open) so the IPC server can use it right away.
    let store: JobStore
    /// The main window's selected page; kept across window closes, so "Open SegDown" reopens the last page.
    let navigation = Navigation()
    let updater = Updater()

    private var statusItem: StatusItemController?
    private var window: NSWindow?

    override init() {
        // Card titles truncate; their `.help()` full text shows after 150 ms instead of the default ~1 s.
        UserDefaults.standard.register(defaults: ["NSInitialToolTipDelay": 150])
        settings = SettingsStore()
        store = JobStore(settings: settings)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Dark only.
        NSApp.appearance = NSAppearance(named: .darkAqua)
        NSApp.mainMenu = makeMainMenu()
        statusItem = StatusItemController(
            onOpen: { [weak self] in self?.showMainWindow() },
            onSettings: { [weak self] in self?.showSettings() },
            onAbout: { [weak self] in self?.showAbout() },
            updater: updater)
        observeActiveCount()
        // Also for `--background` launches, so scheduled checks run while only the menu bar item is shown.
        updater.start()
        // `segdown-host` and the Safari appex launch the app hidden with `--background`: menu bar only, no Dock
        // icon. The argument does not reach the app from the sandboxed appex, so a hidden launch (`hides = true`,
        // `open -j`) counts too; `NSApp.isHidden` is already set here (`NSRunningApplication.current.isHidden` is not).
        if !ProcessInfo.processInfo.arguments.contains("--background") && !NSApp.isHidden {
            showMainWindow()
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMainWindow()
        return true
    }

    func showMainWindow() {
        if window == nil {
            let hosting = NSHostingController(
                rootView: MainView(store: store, settings: settings, navigation: navigation))
            // The window owns its size, not the SwiftUI content.
            hosting.sizingOptions = []
            // The SwiftUI toolbar (the page tabs) becomes the window's toolbar, in the traffic-light row.
            hosting.sceneBridgingOptions = [.toolbars]
            let window = NSWindow(contentViewController: hosting)
            window.title = "SegDown"
            window.titleVisibility = .hidden
            window.toolbarStyle = .unified
            // One background for the toolbar and the content, without a line between them.
            window.titlebarAppearsTransparent = true
            window.titlebarSeparatorStyle = .none
            // Full size content: the background runs under the toolbar too.
            window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
            window.isReleasedWhenClosed = false
            window.minSize = NSSize(width: 600, height: 420)
            window.setContentSize(NSSize(width: 640, height: 560))
            // A new name since the tabs left the sidebar: the frame saved for the wider window is not restored.
            if !window.setFrameUsingName("MainWindowTabs") { window.center() }
            window.setFrameAutosaveName("MainWindowTabs")
            window.delegate = self
            self.window = window
        }
        bringToFront()
    }

    /// Shows the queued and running downloads in the Dock icon's red badge and in the menu bar menu; again after
    /// each change of the list.
    private func observeActiveCount() {
        let count = withObservationTracking {
            store.items.count { !$0.status.state.isFinished }
        } onChange: { [weak self] in
            // onChange fires before the new value is stored; read it on the next turn.
            Task { @MainActor in self?.observeActiveCount() }
        }
        NSApp.dockTile.badgeLabel = count == 0 ? nil : String(count)
        statusItem?.setActiveCount(count)
    }

    /// Opens the main window on the Settings page.
    @objc func showSettings() {
        navigation.page = .settings
        showMainWindow()
    }

    /// Opens the main window on the About page.
    @objc func showAbout() {
        navigation.page = .about
        showMainWindow()
    }

    @objc func checkForUpdates() {
        updater.checkForUpdates()
    }

    /// "Check for Updates…" stays disabled while the updater is off (no `SUPublicEDKey` yet).
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        menuItem.action == #selector(checkForUpdates) ? updater.canCheck : true
    }

    /// Shows the Dock icon and the window, then activates the app on the next turn (the `.regular` switch from
    /// LSUIElement is not effective before). On macOS 14+ a plain `activate()` is denied on a fresh launch from
    /// LSUIElement; the `ignoringOtherApps:` form is still honored. `unhide` undoes a hidden (`hides`) launch.
    private func bringToFront() {
        NSApp.setActivationPolicy(.regular)
        NSApp.unhide(nil)
        window?.makeKeyAndOrderFront(nil)
        Task { @MainActor in
            NSApp.activate(ignoringOtherApps: true)
            window?.makeKeyAndOrderFront(nil)
            window?.orderFrontRegardless()
        }
    }

    func windowWillClose(_ notification: Notification) {
        guard let closing = notification.object as? NSWindow, closing === window else { return }
        // Drop the Dock icon once the window is gone, unless another titled window is still open.
        Task { @MainActor in
            let otherWindowOpen = NSApp.windows.contains {
                $0 !== closing && $0.isVisible && $0.styleMask.contains(.titled)
            }
            if !otherWindowOpen { NSApp.setActivationPolicy(.accessory) }
        }
    }

    /// App menu (About, Check for Updates, Settings, Hide, Quit), Edit and Window menus, shown while the app has a
    /// Dock icon.
    private func makeMainMenu() -> NSMenu {
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About SegDown", action: #selector(showAbout), keyEquivalent: "").target = self
        appMenu.addItem(withTitle: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Settings…", action: #selector(showSettings), keyEquivalent: ",").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide SegDown", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit SegDown", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        NSApp.windowsMenu = windowMenu
        let mainMenu = NSMenu()
        for submenu in [appMenu, editMenu, windowMenu] {
            let item = NSMenuItem()
            item.submenu = submenu
            mainMenu.addItem(item)
        }
        return mainMenu
    }
}

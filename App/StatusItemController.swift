import AppKit

/// Menu bar item with a plain AppKit menu: the active downloads count, then its actions, closures set by the app
/// delegate.
@MainActor
final class StatusItemController: NSObject, NSMenuItemValidation {
    private let onOpen: () -> Void
    private let onSettings: () -> Void
    private let onAbout: () -> Void
    private let updater: Updater
    private let statusItem: NSStatusItem
    private let activeItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")

    init(onOpen: @escaping () -> Void, onSettings: @escaping () -> Void, onAbout: @escaping () -> Void,
         updater: Updater) {
        self.onOpen = onOpen
        self.onSettings = onSettings
        self.onAbout = onAbout
        self.updater = updater
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()
        statusItem.button?.image = Self.logo
        statusItem.button?.setAccessibilityLabel("SegDown")
        let menu = NSMenu()
        // No action: shown disabled, as information.
        menu.addItem(activeItem)
        menu.addItem(.separator())
        menu.addItem(item("Open SegDown", #selector(open)))
        menu.addItem(item("Settings…", #selector(openSettings)))
        // Title and enabled state are set in `validateMenuItem`, each time the menu opens.
        menu.addItem(item("Check for Updates…", #selector(checkForUpdates)))
        menu.addItem(item("About SegDown", #selector(about)))
        menu.addItem(.separator())
        menu.addItem(item("Quit SegDown", #selector(quit)))
        statusItem.menu = menu
        setActiveCount(0)
    }

    /// Queued and running downloads.
    func setActiveCount(_ count: Int) {
        activeItem.title = switch count {
        case 0: "No active downloads"
        case 1: "1 active download"
        default: "\(count) active downloads"
        }
    }

    /// The full-colour logo at 18×18 pt, not a template image.
    private static let logo: NSImage? = {
        guard let url = Bundle.main.url(forResource: "logo_512", withExtension: "png"),
              let image = NSImage(contentsOf: url) else { return nil }
        return NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
            image.draw(in: rect)
            return true
        }
    }()

    /// The menu auto-enables its items: "Check for Updates…" is disabled while the updater is off (no
    /// `SUPublicEDKey` yet) and reads "Update Available…" once a background check found one.
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard menuItem.action == #selector(checkForUpdates) else { return true }
        menuItem.title = updater.updateAvailable ? "Update Available…" : "Check for Updates…"
        return updater.canCheck
    }

    private func item(_ title: String, _ action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        return item
    }

    @objc private func open() { onOpen() }
    @objc private func openSettings() { onSettings() }
    @objc private func checkForUpdates() { updater.checkForUpdates() }
    @objc private func about() { onAbout() }
    @objc private func quit() { NSApp.terminate(nil) }
}

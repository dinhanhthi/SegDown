import AppKit

/// Menu bar item with a plain AppKit menu. Its actions are closures set by the app delegate.
@MainActor
final class StatusItemController: NSObject {
    private let onOpen: () -> Void
    private let onSettings: () -> Void
    private let onAbout: () -> Void
    private let statusItem: NSStatusItem

    init(onOpen: @escaping () -> Void, onSettings: @escaping () -> Void, onAbout: @escaping () -> Void) {
        self.onOpen = onOpen
        self.onSettings = onSettings
        self.onAbout = onAbout
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()
        statusItem.button?.image = Self.logo
        statusItem.button?.setAccessibilityLabel("SegDown")
        let menu = NSMenu()
        menu.addItem(item("Open SegDown", #selector(open)))
        menu.addItem(item("Settings…", #selector(openSettings)))
        menu.addItem(item("About SegDown", #selector(about)))
        menu.addItem(.separator())
        menu.addItem(item("Quit SegDown", #selector(quit)))
        statusItem.menu = menu
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

    private func item(_ title: String, _ action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        return item
    }

    @objc private func open() { onOpen() }
    @objc private func openSettings() { onSettings() }
    @objc private func about() { onAbout() }
    @objc private func quit() { NSApp.terminate(nil) }
}

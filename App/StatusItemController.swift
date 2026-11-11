import AppKit

/// Menu bar item with a plain AppKit menu: the active downloads count, then its actions, closures set by the app
/// delegate. While an update waits (`Updater.availableUpdateVersion`), the logo has a download badge.
@MainActor
final class StatusItemController: NSObject, NSMenuItemValidation {
    private let onOpen: () -> Void
    private let onSettings: () -> Void
    private let onAbout: () -> Void
    private let updater: Updater
    private let statusItem: NSStatusItem
    private let activeItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private var activeCount = 0

    init(onOpen: @escaping () -> Void, onSettings: @escaping () -> Void, onAbout: @escaping () -> Void,
         updater: Updater) {
        self.onOpen = onOpen
        self.onSettings = onSettings
        self.onAbout = onAbout
        self.updater = updater
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()
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
        updater.onAvailableUpdateChange = { [weak self] in self?.refreshImage() }
        setActiveCount(0)
    }

    /// Queued and running downloads; any of them puts a red dot on the logo.
    func setActiveCount(_ count: Int) {
        activeCount = count
        refreshImage()
        activeItem.title = switch count {
        case 0: "No active downloads"
        case 1: "1 active download"
        default: "\(count) active downloads"
        }
    }

    /// The logo with the downloads dot, plus the update badge while an update waits.
    private func refreshImage() {
        let badge = updater.availableUpdateVersion != nil
        statusItem.button?.image = switch (activeCount > 0, badge) {
        case (false, false): Self.logo
        case (true, false): Self.logoWithDot
        case (false, true): Self.logoWithBadge
        case (true, true): Self.logoWithDotAndBadge
        }
        statusItem.button?.setAccessibilityLabel(badge ? "SegDown, update available" : "SegDown")
    }

    /// The full-colour logo at 18×18 pt, not a template image.
    private static let logo = makeLogo(dot: false, badge: false)
    private static let logoWithDot = makeLogo(dot: true, badge: false)
    private static let logoWithBadge = makeLogo(dot: false, badge: true)
    private static let logoWithDotAndBadge = makeLogo(dot: true, badge: true)

    /// `dot` adds a small red dot in the bottom-right corner, `badge` a download badge there (the dot then moves to
    /// the top-right corner).
    private static func makeLogo(dot: Bool, badge: Bool) -> NSImage? {
        guard let url = Bundle.main.url(forResource: "logo_512", withExtension: "png"),
              let image = NSImage(contentsOf: url) else { return nil }
        return NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
            image.draw(in: rect)
            if dot {
                NSColor.systemRed.setFill()
                let y = badge ? rect.maxY - 6 : rect.minY
                NSBezierPath(ovalIn: NSRect(x: rect.maxX - 6, y: y, width: 6, height: 6)).fill()
            }
            if badge {
                let disc = NSRect(x: rect.maxX - 9, y: rect.minY, width: 9, height: 9)
                // A white disc, then a bold arrow in a deep green (the system green, 45 % of the way to black).
                NSColor.white.setFill()
                NSBezierPath(ovalIn: disc).fill()
                let green = NSColor.systemGreen.blended(withFraction: 0.45, of: .black) ?? .systemGreen
                let configuration = NSImage.SymbolConfiguration(pointSize: 9, weight: .black)
                    .applying(NSImage.SymbolConfiguration(paletteColors: [green]))
                if let arrow = NSImage(systemSymbolName: "arrow.down", accessibilityDescription: nil)?
                    .withSymbolConfiguration(configuration) {
                    // Aspect-fit in the disc's inner square, centred.
                    let inner = disc.insetBy(dx: 1, dy: 1)
                    let size = arrow.size
                    let scale = min(inner.width / size.width, inner.height / size.height)
                    let fitted = NSSize(width: size.width * scale, height: size.height * scale)
                    arrow.draw(in: NSRect(x: disc.midX - fitted.width / 2, y: disc.midY - fitted.height / 2,
                                          width: fitted.width, height: fitted.height))
                }
            }
            return true
        }
    }

    /// The menu auto-enables its items: "Check for Updates…" is disabled while the updater is off (no
    /// `SUPublicEDKey` yet) and takes `Updater.menuTitle` (e.g. "Update to SegDown <version>…" once a background check
    /// found one).
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard menuItem.action == #selector(checkForUpdates) else { return true }
        menuItem.title = updater.menuTitle
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

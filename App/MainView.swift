// The main window: the pages as tabs in the toolbar, the selected page under them, over the window glass.
import SwiftUI

/// A page of the toolbar's tabs. Adding one: a case, its `title`, its view in `MainView.page(_:)`.
enum Page: String, CaseIterable, Identifiable {
    case downloads, settings, dependencies, browsers, about

    var id: Self { self }

    var title: String {
        switch self {
        case .downloads: "Downloads"
        case .settings: "Settings"
        case .dependencies: "Dependencies"
        case .browsers: "Browsers"
        case .about: "About"
        }
    }
}

/// The selected page, owned by the AppDelegate so its menus can open a page before the window exists.
@MainActor
@Observable
final class Navigation {
    var page: Page = .downloads
}

struct MainView: View {
    let store: JobStore
    let settings: SettingsStore
    let navigation: Navigation

    var body: some View {
        page(navigation.page)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(WindowGlass().ignoresSafeArea())
            // A band behind the transparent title bar, so scrolled content never shows through it; the same glass as
            // the window, so the title bar and the content still read as one.
            .overlay {
                GeometryReader { proxy in
                    WindowGlass()
                        .frame(height: proxy.safeAreaInsets.top)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                        .ignoresSafeArea(.container, edges: .top)
                }
                .allowsHitTesting(false)
            }
            .modifier(HardTopScrollEdge())
            .toolbar {
                ToolbarItem(placement: .navigation) {
                    Image(nsImage: AboutView.logo)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: 44, height: 44)
                        .accessibilityLabel("SegDown")
                }
                .hiddenSharedBackground()
                // A flexible space pushes the tabs to the toolbar's trailing edge, the logo alone at the leading edge.
                ToolbarItem { Spacer() }
                ToolbarItem {
                    CapsuleTabs(
                        selection: Binding(get: { navigation.page }, set: { navigation.page = $0 }),
                        tabs: Page.allCases, title: { Text($0.title) }
                    )
                    // AppKit pads the sides less than the top and bottom.
                    .padding(.horizontal, 4)
                    .fixedSize()
                }
            }
    }

    /// The one place that maps a page to its view.
    @ViewBuilder
    private func page(_ page: Page) -> some View {
        switch page {
        case .downloads: DownloadsView(store: store)
        case .settings: SettingsView(store: store, settings: settings)
        case .dependencies: DependenciesView(store: store)
        case .browsers: BrowsersView(store: store)
        case .about: AboutView()
        }
    }
}

// The main window: a sidebar of pages on a raised card, the selected page on the right, over the window glass.
import SwiftUI

/// A sidebar page. Adding one: a case, its `title` and `symbol`, its view in `MainView.page(_:)`.
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

    var symbol: String {
        switch self {
        case .downloads: "arrow.down.circle"
        case .settings: "gearshape"
        case .dependencies: "wrench.and.screwdriver"
        case .browsers: "globe"
        case .about: "info.circle"
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
    @FocusState private var sidebarFocused: Bool

    var body: some View {
        HStack(spacing: 0) {
            List(selection: selection) {
                ForEach(Page.allCases) { page in
                    Label(page.title, systemImage: page.symbol).tag(page)
                }
            }
            .listStyle(.sidebar)
            // On the card, not a sidebar material of its own.
            .scrollContentBackground(.hidden)
            // Focused, so the selected row shows the accent color, not the inactive gray.
            .focused($sidebarFocused)
            .frame(width: 200)
            .modifier(GlassCard(cornerRadius: 20, raised: true))
            .padding(.top, 12)
            .padding([.leading, .bottom], 12)
            page(navigation.page)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(WindowGlass().ignoresSafeArea())
        // A band behind the transparent title bar, so scrolled content never shows through it; the same glass as the
        // window, so the title bar and the content still read as one.
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
        .onAppear { sidebarFocused = true }
    }

    /// Ignores deselection (a click in the empty sidebar): a page is always shown.
    private var selection: Binding<Page?> {
        Binding(get: { navigation.page }, set: { page in
            if let page { navigation.page = page }
        })
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

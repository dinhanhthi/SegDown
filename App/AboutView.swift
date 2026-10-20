// The About page: logo, name, version, copyright and the link to the README, straight on the window's glass.
import AppKit
import SwiftUI

struct AboutView: View {
    private static let readme = URL(string: "https://github.com/dinhanhthi/SegDown#readme")!

    var body: some View {
        VStack(spacing: 10) {
            Image(nsImage: Self.logo)
                .resizable()
                .interpolation(.high)
                .frame(width: 96, height: 96)
                .accessibilityHidden(true)
            Text("SegDown").font(.title2.weight(.semibold))
            Text("Version \(Self.version)")
                .foregroundStyle(.secondary)
            Link("Read me", destination: Self.readme)
            if let copyright = Self.copyright {
                Text(copyright)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// `logo_512.png` from the bundle, or the app icon.
    private static let logo: NSImage = {
        Bundle.main.url(forResource: "logo_512", withExtension: "png").flatMap(NSImage.init(contentsOf:))
            ?? NSApp.applicationIconImage
    }()

    /// "0.2.0 (1)".
    private static var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String
        return build.map { "\(short) (\($0))" } ?? short
    }

    private static var copyright: String? {
        Bundle.main.infoDictionary?["NSHumanReadableCopyright"] as? String
    }
}

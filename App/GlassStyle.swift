// The window's look, ported from EchoDiar: dark-only colors, cards, the window glass and small controls.
import AppKit
import SwiftUI

/// The single place for macOS 26 feature gates. Call sites still need `if #available(macOS 26, *)` for the
/// compiler; this adds the DEBUG `--force-fallbacks` override on top, so pre-26 paths can be checked on 26+.
enum PlatformFeatures {
    static let forceFallbacks: Bool = {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("--force-fallbacks")
        #else
        return false
        #endif
    }()

    static var liquidGlass: Bool {
        if #available(macOS 26, *) { return !forceFallbacks }
        return false
    }
}

/// The app colors. The app is dark only, so each color has one value.
enum Palette {
    static let hoverFill = Color.white.opacity(0.1)
    static let pressedFill = Color.white.opacity(0.2)
    static let switchOffFill = Color.white.opacity(0.22)
    /// Cards and panels, a step above the window. #2C2C2E
    static let surface = Color(red: 44 / 255, green: 44 / 255, blue: 46 / 255)
    /// The 1 pt edge of cards and panels.
    static let surfaceBorder = Color.white.opacity(0.08)
    /// The edge of a raised card: bright at the top, dim on the sides, a faint highlight at the bottom.
    static let raisedRim = LinearGradient(
        stops: [
            .init(color: .white.opacity(0.24), location: 0),
            .init(color: .white.opacity(0.05), location: 0.45),
            .init(color: .white.opacity(0.10), location: 1),
        ],
        startPoint: .top, endPoint: .bottom)
}

/// The icon buttons of a row: a round highlight on hover, darker and a bit smaller while pressed. The highlight
/// reaches past the label without changing the row's layout.
struct RowIconButtonStyle: ButtonStyle {
    /// A capsule highlight, for a label wider than an icon.
    var capsule = false

    func makeBody(configuration: Configuration) -> some View {
        Highlight(configuration: configuration, capsule: capsule)
    }

    private struct Highlight: View {
        let configuration: ButtonStyleConfiguration
        let capsule: Bool
        @State private var hovered = false
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            let fill = configuration.isPressed ? Palette.pressedFill : hovered ? Palette.hoverFill : .clear
            configuration.label
                .background {
                    if capsule {
                        Capsule().fill(fill).padding(-5)
                    } else {
                        Circle().fill(fill).padding(-5)
                    }
                }
                .contentShape(Rectangle())
                .scaleEffect(configuration.isPressed && !reduceMotion ? 0.88 : 1)
                .animation(reduceMotion ? nil : .snappy(duration: 0.12), value: configuration.isPressed)
                .animation(.easeOut(duration: 0.12), value: hovered)
                .onHover { hovered = $0 }
        }
    }
}

/// A small on/off switch; the system switch stays wide even at `.mini` on macOS 26.
struct CompactSwitch: ToggleStyle {
    static let height: CGFloat = 19

    func makeBody(configuration: Configuration) -> some View {
        Switch(configuration: configuration)
    }

    private struct Switch: View {
        let configuration: ToggleStyleConfiguration
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            Capsule()
                .fill(configuration.isOn ? Color.accentColor : Palette.switchOffFill)
                .frame(width: 34, height: CompactSwitch.height)
                .overlay(alignment: configuration.isOn ? .trailing : .leading) {
                    Circle()
                        .fill(.white)
                        .shadow(color: .black.opacity(0.2), radius: 0.5, y: 0.5)
                        .padding(1.5)
                }
                .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: configuration.isOn)
                .contentShape(Capsule())
                .onTapGesture { configuration.isOn.toggle() }
                .accessibilityRepresentation {
                    Toggle(isOn: configuration.$isOn) { configuration.label }
                }
        }
    }
}

/// The translucent window background, blurring what is behind the window (toolbar included), under a dark tint so
/// only a little shows through.
struct WindowGlass: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .underWindowBackground
        view.blendingMode = .behindWindow
        view.state = .followsWindowActiveState
        let tint = NSView(frame: view.bounds)
        tint.wantsLayer = true
        // #1C1C1E
        tint.layer?.backgroundColor = NSColor(srgbRed: 28 / 255, green: 28 / 255, blue: 30 / 255, alpha: 0.6).cgColor
        tint.autoresizingMask = [.width, .height]
        view.addSubview(tint)
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

/// A card or panel: solid `Palette.surface` with a 1 pt `Palette.surfaceBorder` edge, on every macOS version, so it
/// stands out from the window background. Raised (the sidebar) looks like the toolbar's capsules: a rim lit from
/// above, a faint sheen at the top and a soft shadow under it.
struct GlassCard: ViewModifier {
    var cornerRadius: CGFloat = 14
    var raised = false

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if raised {
            content
                .background {
                    shape.fill(Palette.surface)
                        .overlay(shape.fill(LinearGradient(
                            colors: [.white.opacity(0.05), .clear], startPoint: .top, endPoint: .center)))
                        .shadow(color: .black.opacity(0.35), radius: 6, y: 3)
                }
                .overlay(shape.strokeBorder(Palette.raisedRim, lineWidth: 1).allowsHitTesting(false))
        } else {
            content
                .background(shape.fill(Palette.surface))
                .overlay(shape.strokeBorder(Palette.surfaceBorder, lineWidth: 1).allowsHitTesting(false))
        }
    }
}

/// On macOS 26+ (unless `--force-fallbacks`), scrolled content stops hard at the top edge instead of fading under
/// the transparent title bar.
struct HardTopScrollEdge: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 26, *), PlatformFeatures.liquidGlass {
            content.scrollEdgeEffectStyle(.hard, for: .top)
        } else {
            content
        }
    }
}

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
    static let switchOffFill = Color.white.opacity(0.22)
    /// Cards and panels, a step above the window. #2C2C2E
    static let surface = Color(red: 44 / 255, green: 44 / 255, blue: 46 / 255)
    /// Controls on a card, a step above `surface`. #3A3A3C
    static let inputSurface = Color(red: 58 / 255, green: 58 / 255, blue: 60 / 255)
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

/// A raised button like the toolbar's: `height` tall (a circle for an icon, with no `horizontalPadding`). Liquid Glass
/// on macOS 26; before, a capsule lit from above with a soft shadow, like `GlassCard(raised:)`. Lighter on hover,
/// darker while pressed, dimmed when disabled. `tint` colors the glass (or the capsule's fill).
struct RaisedButtonStyle: ButtonStyle {
    var height: CGFloat = 28
    var horizontalPadding: CGFloat = 0
    var tint: Color?

    func makeBody(configuration: Configuration) -> some View {
        Raised(configuration: configuration, height: height, horizontalPadding: horizontalPadding, tint: tint)
    }

    private struct Raised: View {
        let configuration: ButtonStyleConfiguration
        let height: CGFloat
        let horizontalPadding: CGFloat
        let tint: Color?
        @State private var hovered = false
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            let fill = configuration.isPressed ? Color.black.opacity(0.2) : hovered && isEnabled ? Palette.hoverFill : .clear
            configuration.label
                .foregroundStyle(.primary)
                .padding(.horizontal, horizontalPadding)
                .frame(minWidth: height, minHeight: height, maxHeight: height)
                .modifier(RaisedCapsule(tint: tint))
                .overlay(Capsule().fill(fill).allowsHitTesting(false))
                .contentShape(Capsule())
                .opacity(isEnabled ? 1 : 0.45)
                .animation(.easeOut(duration: 0.12), value: hovered)
                .onHover { hovered = $0 }
        }
    }

    private struct RaisedCapsule: ViewModifier {
        let tint: Color?

        func body(content: Content) -> some View {
            if #available(macOS 26, *), PlatformFeatures.liquidGlass {
                content.glassEffect(.regular.tint(tint), in: Capsule())
            } else {
                content
                    .background {
                        Capsule().fill(tint ?? Palette.inputSurface)
                            .overlay(Capsule().fill(LinearGradient(
                                colors: [.white.opacity(0.08), .clear], startPoint: .top, endPoint: .center)))
                            .shadow(color: .black.opacity(0.35), radius: 3, y: 1.5)
                    }
                    .overlay(Capsule().strokeBorder(Palette.raisedRim, lineWidth: 1).allowsHitTesting(false))
            }
        }
    }
}

/// A small text button of a card row: a capsule of the input color, lighter on hover, darker while pressed.
/// `formRow`: as tall as a compact `CapsuleTabs`, for a form row.
struct RowTextButtonStyle: ButtonStyle {
    var formRow = false

    func makeBody(configuration: Configuration) -> some View {
        Highlight(configuration: configuration, formRow: formRow)
    }

    private struct Highlight: View {
        let configuration: ButtonStyleConfiguration
        let formRow: Bool
        @State private var hovered = false

        var body: some View {
            configuration.label
                .font(formRow ? .subheadline : .caption.weight(.medium))
                .padding(.horizontal, formRow ? 10 : 8)
                .padding(.vertical, formRow ? 0 : 3)
                .frame(height: formRow ? 22 : nil)
                .background(
                    Capsule()
                        .fill(Palette.inputSurface)
                        .overlay(Capsule().fill(
                            configuration.isPressed ? Color.black.opacity(0.2) : hovered ? Palette.hoverFill : .clear)))
                .contentShape(Capsule())
                .animation(.easeOut(duration: 0.12), value: hovered)
                .onHover { hovered = $0 }
        }
    }
}

/// The arrow of a menu button.
struct MenuChevron: View {
    var body: some View {
        Image(systemName: "chevron.down")
            .font(.system(size: 9, weight: .bold))
            .accessibilityHidden(true)
    }
}

/// Tabs for a toolbar item, as tall as its buttons' highlights, in the toolbar's capsule on macOS 26 (a surface capsule
/// before): the selected tab is an accent capsule that slides between the tabs (no slide under Reduce Motion).
/// `compact`: smaller, always on a surface capsule, for a form row.
struct CapsuleTabs<Tab: Hashable>: View {
    @Binding var selection: Tab
    let tabs: [Tab]
    let title: (Tab) -> Text
    var compact = false
    @Namespace private var namespace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 2) {
            ForEach(tabs, id: \.self) { tab in
                Item(tab: tab, title: title(tab), selected: tab == selection, compact: compact, namespace: namespace) {
                    withAnimation(animation) { selection = tab }
                }
            }
        }
        // One pill that follows the selected item's frame, so it slides instead of fading between items.
        .background {
            Capsule()
                .fill(Color.accentColor)
                .matchedGeometryEffect(id: selection, in: namespace, isSource: false)
        }
        // Also animates a selection set from code (the menus).
        .animation(animation, value: selection)
        .modifier(SurfaceTrack(compact: compact))
    }

    private var animation: Animation? { reduceMotion ? nil : .snappy(duration: 0.25) }

    /// Before macOS 26 the toolbar draws no capsule around its items; a form never does.
    private struct SurfaceTrack: ViewModifier {
        let compact: Bool

        func body(content: Content) -> some View {
            if #available(macOS 26, *), PlatformFeatures.liquidGlass, !compact {
                content
            } else {
                content
                    .padding(compact ? 2 : 3)
                    .background(Capsule().fill(Palette.surface))
                    .overlay(Capsule().strokeBorder(Palette.surfaceBorder, lineWidth: 1).allowsHitTesting(false))
            }
        }
    }

    private struct Item: View {
        let tab: Tab
        let title: Text
        let selected: Bool
        let compact: Bool
        let namespace: Namespace.ID
        let action: () -> Void
        @State private var hovered = false
        /// A toolbar button's highlight; a form row's control when compact.
        private var height: CGFloat { compact ? 22 : 28 }

        var body: some View {
            Button(action: action) {
                title
                    .font(compact ? .subheadline : .callout)
                    .lineLimit(1)
                    .foregroundStyle(selected ? Color.white : Color.secondary)
                    .padding(.horizontal, compact ? 10 : 12)
                    .frame(height: height)
                    .background {
                        if hovered && !selected { Capsule().fill(Palette.hoverFill) }
                    }
                    .matchedGeometryEffect(id: tab, in: namespace)
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .onHover { hovered = $0 }
            .accessibilityAddTraits(selected ? .isSelected : [])
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

extension ToolbarContent {
    /// On macOS 26+ (unless `--force-fallbacks`), the toolbar draws no glass behind this item, so it does not share
    /// the capsule of the items next to it.
    @ToolbarContentBuilder
    func hiddenSharedBackground() -> some ToolbarContent {
        if #available(macOS 26, *), PlatformFeatures.liquidGlass {
            sharedBackgroundVisibility(.hidden)
        } else {
            self
        }
    }
}

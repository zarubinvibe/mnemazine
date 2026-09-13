import AppKit
import SwiftUI

struct ReadablePlate: ViewModifier {
    var cornerRadius: CGFloat = 12
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: cornerRadius))
        } else {
            content.background(.regularMaterial, in: RoundedRectangle(cornerRadius: cornerRadius))
        }
    }
}

struct ClearGlassPlate: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 16))
        } else if #available(macOS 26.0, *) {
            content.glassEffect(.clear, in: .rect(cornerRadius: 16))
        } else {
            content.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        }
    }
}

struct GlassWindow: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        content
            .background {
                if reduceTransparency { Color(nsColor: .windowBackgroundColor).ignoresSafeArea() }
                else { WindowGlassSurface().ignoresSafeArea() }
            }
            .background(WindowBacking(opaque: reduceTransparency).frame(width: 0, height: 0))
    }
}

private struct WindowGlassSurface: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView()
            glass.style = .regular
            glass.cornerRadius = 16
            return glass
        }
        let blur = NSVisualEffectView()
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = 16
        blur.layer?.masksToBounds = true
        return blur
    }
    func updateNSView(_ view: NSView, context: Context) {}
}

@MainActor
func configureGlassWindow(_ window: NSWindow, opaque: Bool) {
    // Extend only the background under native traffic lights; SwiftUI keeps
    // interactive content within the window's titlebar safe area.
    window.styleMask.insert(.fullSizeContentView)
    window.isOpaque = opaque
    window.backgroundColor = opaque ? .windowBackgroundColor : .clear
    window.titlebarAppearsTransparent = true
    window.isReleasedWhenClosed = false
}

private struct WindowBacking: NSViewRepresentable {
    let opaque: Bool
    func makeNSView(context: Context) -> Anchor { Anchor(opaque: opaque) }
    func updateNSView(_ view: Anchor, context: Context) {
        view.shouldBeOpaque = opaque
        view.applyBacking()
    }
    final class Anchor: NSView {
        var shouldBeOpaque: Bool
        init(opaque: Bool) { self.shouldBeOpaque = opaque; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError("Use init(opaque:)") }
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); applyBacking() }
        func applyBacking() {
            guard let window else { return }
            configureGlassWindow(window, opaque: shouldBeOpaque)
        }
    }
}

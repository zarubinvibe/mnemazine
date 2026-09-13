import AppKit
import SwiftUI
import XCTest
@testable import Mnemazine

final class WindowSurfaceTests: XCTestCase {
    @MainActor
    func testGlassCoversNativeTitlebarAndKeepsWindowControlsAfterResize() throws {
        try XCTSkipIf(NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency,
            "Glass geometry requires transparency enabled; opaque backing is tested separately.")
        let window = makeWindow()
        defer { window.close() }
        let host = NSHostingView(rootView: VStack {
            ContentProbe().frame(height: 20)
            Spacer()
        }.modifier(GlassWindow()))
        window.contentView = host

        for size in [NSSize(width: 560, height: 370), NSSize(width: 740, height: 520)] {
            window.setContentSize(size)
            host.layoutSubtreeIfNeeded()
            let surface = try XCTUnwrap(descendants(of: host).first { view in
                if #available(macOS 26.0, *), view is NSGlassEffectView { return true }
                return view is NSVisualEffectView
            })
            let surfaceRect = surface.convert(surface.bounds, to: nil)
            let hostRect = host.convert(host.bounds, to: nil)
            XCTAssertEqual(surfaceRect.minY, hostRect.minY, accuracy: 1)
            XCTAssertEqual(surfaceRect.maxY, hostRect.maxY, accuracy: 1)
            XCTAssertEqual(surfaceRect.width, hostRect.width, accuracy: 1)
            XCTAssertGreaterThan(surfaceRect.maxY, window.contentLayoutRect.maxY)
            let close = try XCTUnwrap(window.standardWindowButton(.closeButton))
            XCTAssertTrue(surfaceRect.contains(close.convert(close.bounds, to: nil)))
            let content = try XCTUnwrap(descendants(of: host).first { $0 is ContentProbe.View })
            XCTAssertLessThanOrEqual(content.convert(content.bounds, to: nil).maxY,
                window.contentLayoutRect.maxY + 1, "Content must stay below native window controls")
            if #available(macOS 26.0, *), let glass = surface as? NSGlassEffectView {
                XCTAssertEqual(glass.cornerRadius, 16)
                XCTAssertEqual(glass.style, .regular)
            } else {
                XCTAssertEqual(surface.layer?.cornerRadius, 16)
                XCTAssertEqual(surface.layer?.masksToBounds, true)
            }
        }
        XCTAssertTrue(window.styleMask.contains([.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]))
        XCTAssertTrue(window.isMovable)
        XCTAssertNotNil(window.standardWindowButton(.miniaturizeButton))
        XCTAssertNotNil(window.standardWindowButton(.zoomButton))
    }

    @MainActor
    func testReduceTransparencyChangesBackingWithoutRemovingNativeChrome() {
        let window = makeWindow()
        defer { window.close() }
        configureGlassWindow(window, opaque: true)
        XCTAssertTrue(window.isOpaque)
        XCTAssertEqual(window.backgroundColor, .windowBackgroundColor)
        XCTAssertTrue(window.styleMask.contains(.fullSizeContentView))
        configureGlassWindow(window, opaque: false)
        XCTAssertFalse(window.isOpaque)
        XCTAssertEqual(window.backgroundColor, .clear)
        XCTAssertNotNil(window.standardWindowButton(.closeButton))
    }

    @MainActor
    private func makeWindow() -> NSWindow {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 370),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        configureGlassWindow(window, opaque: false)
        return window
    }

    @MainActor
    private func descendants(of view: NSView) -> [NSView] {
        view.subviews.flatMap { [$0] + descendants(of: $0) }
    }
}

private struct ContentProbe: NSViewRepresentable {
    final class View: NSView {}
    func makeNSView(context: Context) -> View { View() }
    func updateNSView(_ view: View, context: Context) {}
}

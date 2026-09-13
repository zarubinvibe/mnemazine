import AppKit
import SwiftUI

@MainActor
final class StatusAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let store = Store()
    private var statusItem: NSStatusItem?
    private var panel: SearchPanel?
    private var windows: [String: NSWindow] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        store.openWindow = { [weak self] id in self?.showWindow(id) }
        store.panelSizeChanged = { [weak self] size in self?.resizePanel(size) }
        let item = NSStatusBar.system.statusItem(withLength: 40)
        item.button?.image = MnemazineMark.image()
        item.button?.image?.isTemplate = true
        item.button?.target = self
        item.button?.action = #selector(togglePanel)
        item.button?.setAccessibilityLabel("Мнемозина")
        statusItem = item
        DispatchQueue.main.async { [weak self] in self?.showPanel() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPanel()
        return false
    }

    @objc private func togglePanel() {
        if panel?.isVisible == true { panel?.orderOut(nil); return }
        showPanel()
    }

    private func showPanel() {
        let panel = panel ?? makePanel()
        let screen = statusItem?.button?.window?.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
        let top = screen.maxY - min(140, screen.height * 0.18)
        let origin = NSPoint(x: screen.midX - panel.frame.width / 2,
                             y: max(screen.minY + 16, top - panel.frame.height))
        panel.setFrameOrigin(origin)
        let animate = !panel.isVisible && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        panel.alphaValue = animate ? 0 : 1
        panel.orderFrontRegardless()
        panel.makeKey()
        if animate {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                panel.animator().alphaValue = 1
            }
        }
        Task { await store.refresh() }
    }

    private func resizePanel(_ size: CGSize) {
        guard let panel, size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else { return }
        let screen = panel.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
        let width = min(size.width, max(320, screen.width - 32))
        let height = min(size.height, max(200, screen.height - 48))
        guard abs(panel.frame.width - width) > 0.5 || abs(panel.frame.height - height) > 0.5 else { return }
        let top = panel.frame.maxY
        panel.setFrame(NSRect(x: min(max(panel.frame.midX - width / 2, screen.minX + 16), screen.maxX - width - 16),
                             y: max(screen.minY + 16, top - height), width: width, height: height), display: true)
    }

    private func makePanel() -> SearchPanel {
        let view = NSHostingView(rootView: MenuPanel().environmentObject(store))
        let panel = SearchPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 160),
                                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        // Keep the drop target visible while the user grabs a file in Finder.
        // Only Escape, the status button, or explicit navigation hides it.
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = view
        panel.setContentSize(view.fittingSize)
        self.panel = panel
        return panel
    }

    private func showWindow(_ id: String) {
        panel?.orderOut(nil)
        if let window = windows[id] {
            window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return
        }
        let content: AnyView
        let title: String
        let size: NSSize
        switch id {
        case "settings":
            content = AnyView(SettingsView().environmentObject(store)); title = "Мнемозина · настройки"; size = .init(width: 560, height: 370)
        case "queue":
            content = AnyView(QueueView().environmentObject(store)); title = "Мнемозина · очередь"; size = .init(width: 560, height: 460)
        default:
            content = AnyView(ResultView().environmentObject(store)); title = "Мнемозина · результат"; size = .init(width: 760, height: 640)
        }
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = title
        configureGlassWindow(window, opaque: NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency)
        window.delegate = self
        window.contentView = NSHostingView(rootView: content)
        windows[id] = window
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow,
              let id = windows.first(where: { $0.value === window })?.key else { return }
        window.contentView = nil
        windows.removeValue(forKey: id)
    }

}

private final class SearchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { orderOut(nil) }
}

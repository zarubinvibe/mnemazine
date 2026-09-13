import Foundation
import XCTest

final class PanelPersistenceTests: XCTestCase {
    func testFinderDragDoesNotDismissPanel() throws {
        // Regression: an outside-click monitor dismissed the target before a
        // Finder drag could reach it. Guard the presentation boundary itself.
        let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: package.appendingPathComponent("Sources/Mnemazine/StatusAppDelegate.swift"), encoding: .utf8)
        XCTAssertFalse(source.contains("addGlobalMonitorForEvents"))
        XCTAssertFalse(source.contains("addLocalMonitorForEvents"))
        XCTAssertTrue(source.contains("panel.hidesOnDeactivate = false"))
        XCTAssertTrue(source.contains(".nonactivatingPanel"))
        XCTAssertTrue(source.contains("override func cancelOperation"))
    }
}

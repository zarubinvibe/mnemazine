import XCTest
@testable import Mnemazine

final class SpotlightModeTests: XCTestCase {
    func testSelectedGlassControlHasOnePosition() {
        XCTAssertEqual(SpotlightGlassLayout.externalModes(selected: .search), [.link, .files, .clipboard, .settings])
        for selected in [SpotlightMode.link, .files, .clipboard, .settings] {
            XCTAssertEqual(SpotlightGlassLayout.externalModes(selected: selected).count, 3)
            XCTAssertFalse(SpotlightGlassLayout.externalModes(selected: selected).contains(selected))
        }
    }
    func testDropPreviewReturnsToReceivedFileWithoutClipboardRead() {
        XCTAssertEqual(SpotlightHeaderContent.resolve(targeted: true, mode: .clipboard, files: []), .drop)
        XCTAssertEqual(SpotlightHeaderContent.resolve(targeted: false, mode: .files, files: ["paper.pdf"]), .received("paper.pdf"))
        XCTAssertEqual(SpotlightHeaderContent.resolve(targeted: false, mode: .files, files: ["a.md", "b.md"]), .received("a.md и ещё 1"))
        XCTAssertEqual(SpotlightHeaderContent.resolve(targeted: false, mode: .search, files: ["a.md"]), .input)
    }
    func testClipboardOnlyReadsOnExplicitSelection() {
        var reads = 0
        let read = { reads += 1; return ClipboardPreview(text: "секрет") }
        for mode in [SpotlightMode.search, .link, .files, .settings] {
            XCTAssertNil(ClipboardPreview.onSelection(mode, read: read))
        }
        XCTAssertEqual(reads, 0)
        XCTAssertEqual(ClipboardPreview.onSelection(.clipboard, read: read)?.text, "секрет")
        XCTAssertEqual(reads, 1)
    }
    func testExplicitModeDispatch() {
        XCTAssertEqual(SpotlightRequest.resolve(mode: .search, input: "Сделай справку: память")?.kind, "brief")
        XCTAssertEqual(SpotlightRequest.resolve(mode: .link, input: "https://example.com"), .init(kind: "ingest", text: "https://example.com"))
        XCTAssertEqual(SpotlightRequest.resolve(mode: .clipboard, input: "короткий текст")?.kind, "ingest")
        XCTAssertNil(SpotlightRequest.resolve(mode: .files, input: "не отправлять"))
        XCTAssertNil(SpotlightRequest.resolve(mode: .settings, input: "не отправлять"))
        XCTAssertNil(SpotlightRequest.resolve(mode: .clipboard, input: String(repeating: "я", count: 4097)))
        XCTAssertNotNil(SpotlightRequest.resolve(mode: .clipboard, input: String(repeating: "я", count: 4096)))
    }
}

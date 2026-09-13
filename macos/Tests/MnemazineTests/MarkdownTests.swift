import XCTest
@testable import Mnemazine

final class MarkdownTests: XCTestCase {
    func testReportBlocksAndUnclosedFence() {
        let blocks = MarkdownBlock.parse("# Справка\n\nАбзац **жирный**\n\n- пункт\n> цитата\n```swift\nlet x = 1")
        XCTAssertEqual(blocks.map(\.kind), [.heading(1), .paragraph, .item, .quote, .code])
        XCTAssertEqual(blocks.last?.text, "let x = 1")
    }
    func testUnsafeLinksArePlainText() {
        let text = MarkdownBlock.inline("[плохой](file:///tmp/run.command) [сайт](https://example.com)")
        XCTAssertEqual(text.runs.compactMap(\.link), [URL(string: "https://example.com")!])
    }
}

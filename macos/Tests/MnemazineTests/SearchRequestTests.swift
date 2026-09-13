import XCTest
@testable import Mnemazine

final class SearchRequestTests: XCTestCase {
    func testExplicitBriefPrefix() {
        XCTAssertEqual(SearchRequest.parse(" Сделай справку: про память "), .init(kind: "brief", query: "про память"))
        XCTAssertEqual(SearchRequest.parse("СДЕЛАЙ СПРАВКУ\nисточники"), .init(kind: "brief", query: "источники"))
        XCTAssertEqual(SearchRequest.parse("найди информацию"), .init(kind: "search", query: "найди информацию"))
        XCTAssertEqual(SearchRequest.parse("сделай справкуXYZ"), .init(kind: "search", query: "сделай справкуXYZ"))
    }
}

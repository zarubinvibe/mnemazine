import XCTest
@testable import Mnemazine

final class AccessibilityLabelTests: XCTestCase {
    func testApprovedGraphMarkIsWideAndAdaptsToMenuAppearance() {
        let image = MnemazineMark.image()
        XCTAssertEqual(image.size.width, 32)
        XCTAssertEqual(image.size.height, 18)
        XCTAssertTrue(image.isTemplate)
        XCTAssertEqual(image.accessibilityDescription, "Мнемозина: граф памяти")
    }

    func testFileActionLabelMatchesActionAndSettingsTakePrecedence() {
        XCTAssertEqual(fileActionAccessibilityLabel(configured: false, pendingCount: 0),
            "Открыть настройки Мнемозины")
        XCTAssertEqual(fileActionAccessibilityLabel(configured: false, pendingCount: 3),
            "Открыть настройки Мнемозины")
        XCTAssertEqual(fileActionAccessibilityLabel(configured: true, pendingCount: 0),
            "Добавить файлы: перенеси сюда или нажми для выбора")
        XCTAssertEqual(fileActionAccessibilityLabel(configured: true, pendingCount: 3),
            "Обработать файлы: 3")
    }
}

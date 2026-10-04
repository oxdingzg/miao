import XCTest

final class PairingUITests: XCTestCase {
    func testFreshLaunchAndInvalidInvitationLeaveHostDirectoryEmpty() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.navigationBars["miao"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.staticTexts["设备数据无法读取或保存，请解锁设备后重试"].exists)
        let connect = app.buttons["连接电脑"].firstMatch
        XCTAssertTrue(connect.waitForExistence(timeout: 5))
        connect.tap()
        XCTAssertTrue(app.navigationBars["连接电脑"].waitForExistence(timeout: 5))
        let field = app.textFields["pairingURI"].exists ? app.textFields["pairingURI"] : app.textViews["pairingURI"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText("miao://pair#invalid")
        app.buttons["开始配对"].tap()
        XCTAssertTrue(app.staticTexts["配对未完成或授权结果待核对，请在电脑上检查设备状态"].waitForExistence(timeout: 5))
        app.buttons["关闭"].tap()
        XCTAssertTrue(app.staticTexts["我的电脑"].exists)
        XCTAssertFalse(app.staticTexts["已配对"].exists)
    }
}

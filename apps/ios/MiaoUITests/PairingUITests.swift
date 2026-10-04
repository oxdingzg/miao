import XCTest

final class PairingUITests: XCTestCase {
    func testFreshLaunchAndInvalidInvitationLeaveHostDirectoryEmpty() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["连接电脑"].firstMatch.waitForExistence(timeout: 15))
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
        XCTAssertTrue(app.buttons["连接电脑"].firstMatch.exists)
        XCTAssertFalse(app.staticTexts["已配对"].exists)
    }
    func testRealRuntimeRenameAndDraftRecovery() throws {
        guard let path = ProcessInfo.processInfo.environment["MIAO_UI_TEST_FIXTURE"], !path.isEmpty,
              !path.hasPrefix("$(") else { throw XCTSkip("Live Runtime fixture is supplied by check-app.ts") }
        struct Fixture: Decodable { let runID: String; let invitation: String; let title: String }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let app = XCUIApplication()
        app.launchEnvironment["MIAO_UI_TEST_RUN"] = fixture.runID
        app.launchEnvironment["MIAO_UI_TEST_INVITATION"] = fixture.invitation
        app.launch()
        XCTAssertTrue(app.buttons["开始配对"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["开始配对"].isEnabled)
        app.buttons["开始配对"].tap()
        XCTAssertTrue(app.staticTexts["已连接"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons[fixture.title].waitForExistence(timeout: 10))
        app.buttons[fixture.title].tap()
        XCTAssertTrue(app.navigationBars[fixture.title].waitForExistence(timeout: 10))
        let draft = app.textFields["messageDraft"].exists ? app.textFields["messageDraft"] : app.textViews["messageDraft"]
        XCTAssertTrue(draft.waitForExistence(timeout: 10))
        draft.tap(); draft.typeText("retained phone draft")
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertEqual(draft.value as? String, "retained phone draft")
        app.buttons["会话菜单"].tap()
        app.buttons["重命名"].tap()
        let title = app.alerts.textFields.firstMatch
        title.tap()
        if let current = title.value as? String { title.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count)) }
        title.typeText("Native phone rename")
        app.alerts.buttons["保存"].tap()
        XCTAssertTrue(app.navigationBars["Native phone rename"].waitForExistence(timeout: 15))
        XCTAssertEqual(draft.value as? String, "retained phone draft")
        app.terminate()
        app.launchEnvironment.removeValue(forKey: "MIAO_UI_TEST_INVITATION")
        app.launch()
        XCTAssertTrue(app.staticTexts["已连接"].waitForExistence(timeout: 30))
        app.buttons["Native phone rename"].tap()
        XCTAssertTrue(draft.waitForExistence(timeout: 10))
        XCTAssertEqual(draft.value as? String, "retained phone draft")
        app.descendants(matching: .any).matching(identifier: "queueInput").firstMatch.tap()
        app.buttons["sendMessage"].tap()
        let cleared = NSPredicate(format: "value != %@", "retained phone draft")
        expectation(for: cleared, evaluatedWith: draft)
        waitForExpectations(timeout: 15)
    }

}

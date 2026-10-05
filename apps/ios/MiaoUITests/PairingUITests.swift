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
        struct Account: Decodable { let origin: String; let email: String; let password: String }
        struct Fixture: Decodable { let runID: String; let invitation: String; let title: String; let account: Account? }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let app = XCUIApplication()
        app.launchEnvironment["MIAO_UI_TEST_RUN"] = fixture.runID
        app.launchEnvironment["MIAO_UI_TEST_INVITATION"] = fixture.invitation
        if fixture.account != nil { app.launchEnvironment["MIAO_UI_TEST_HUB_ACCOUNT"] = "1" }
        app.launch()
        if let account = fixture.account {
            XCTAssertTrue(app.textFields["hubOrigin"].waitForExistence(timeout: 15))
            app.textFields["hubOrigin"].tap(); app.textFields["hubOrigin"].typeText(account.origin)
            app.textFields["hubEmail"].tap(); app.textFields["hubEmail"].typeText(account.email)
            app.secureTextFields["hubPassword"].tap(); app.secureTextFields["hubPassword"].typeText(account.password)
            app.buttons["hubSignIn"].tap()
            XCTAssertTrue(app.staticTexts["已登录"].waitForExistence(timeout: 30))
            app.buttons["关闭"].tap()
        }
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
        if app.keyboards.count > 0 {
            XCTAssertTrue(app.buttons["dismissKeyboard"].waitForExistence(timeout: 10))
            app.buttons["dismissKeyboard"].tap()
        }
        let menu = app.buttons["sessionMenu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 15))
        expectation(for: NSPredicate { element, _ in
            guard let button = element as? XCUIElement else { return false }
            return button.isEnabled && button.isHittable
        }, evaluatedWith: menu)
        waitForExpectations(timeout: 30)
        guard menu.isEnabled && menu.isHittable else {
            let states = ["已连接": "ready", "正在连接…": "connecting", "正在同步会话…": "syncing",
                "授权需要重新核对": "authorizationBlocked", "请更新电脑和 App 的版本": "protocolBlocked",
                "离线，回到前台后会重新连接": "offline", "正在断开连接…": "draining", "等待连接": "quiescent",
                "授权已过期，请在电脑上重新配对": "expired"]
            let state = states[menu.value as? String ?? ""] ?? "unknown"
            print("Native menu recovery enabled=\(menu.isEnabled) hittable=\(menu.isHittable) state=\(state)")
            let frame = menu.frame
            print("Native menu geometry x=\(Int(frame.minX)) y=\(Int(frame.minY)) width=\(Int(frame.width)) height=\(Int(frame.height)) keyboard=\(app.keyboards.count) bars=\(app.navigationBars.count)")
            return
        }
        menu.tap()
        app.buttons["重命名"].tap()
        let title = app.alerts.textFields.firstMatch
        title.tap()
        // A tap may put the caret in the middle on iOS 17. Select the entire old name before replacing it.
        title.press(forDuration: 1.2)
        // iOS can expose a stale menu item while the actual editing action is a button.
        // Existence alone does not mean the action can be tapped.
        let selectionButton = app.buttons["Select All"].firstMatch
        let selectionMenu = app.menuItems["Select All"].firstMatch
        let selectionDeadline = Date().addingTimeInterval(4)
        while Date() < selectionDeadline &&
            !(selectionButton.exists && selectionButton.isHittable) &&
            !(selectionMenu.exists && selectionMenu.isHittable) {
            Thread.sleep(forTimeInterval: 0.1)
        }
        if selectionButton.exists && selectionButton.isHittable {
            print("Native rename selection action=button")
            selectionButton.tap()
        } else if selectionMenu.exists && selectionMenu.isHittable {
            print("Native rename selection action=menu")
            selectionMenu.tap()
        } else {
            print("Native rename selection action=caret")
            title.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
            if let current = title.value as? String { title.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count)) }
        }
        title.typeText("Native phone rename")
        print("Native rename input expected=\((title.value as? String) == "Native phone rename")")
        XCTAssertEqual(title.value as? String, "Native phone rename")
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

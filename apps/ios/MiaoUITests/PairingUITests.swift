import XCTest
import Darwin

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
    private final class ApprovalBox: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: String?
        var value: String? {
            get { lock.withLock { stored } }
            set { lock.withLock { stored = newValue } }
        }
    }
    private func stage(_ name: String) {
        print("NativeUIStage:\(name)")
        fflush(stdout)
    }

    func testRealRuntimeRenameAndDraftRecovery() throws {
        guard let path = ProcessInfo.processInfo.environment["MIAO_UI_TEST_FIXTURE"], !path.isEmpty,
              !path.hasPrefix("$(") else { throw XCTSkip("Live Runtime fixture is supplied by check-app.ts") }
        struct Account: Decodable { let origin: String; let email: String; let password: String }
        struct Enrollment: Decodable { let approveURL: URL; let approvalToken: String; let rootKey: String }
        struct Fixture: Decodable { let runID: String; let invitation: String; let title: String; let account: Account?; let finishURL: String; let enrollment: Enrollment? }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        stage("launch")
        let app = XCUIApplication()
        app.launchEnvironment["MIAO_UI_TEST_RUN"] = fixture.runID
        if !fixture.invitation.isEmpty { app.launchEnvironment["MIAO_UI_TEST_INVITATION"] = fixture.invitation }
        if fixture.account != nil { app.launchEnvironment["MIAO_UI_TEST_HUB_ACCOUNT"] = "1" }
        app.launch()
        if let account = fixture.account {
            stage("account")
            if fixture.enrollment != nil {
                XCTAssertTrue(app.buttons["hubAccount"].waitForExistence(timeout: 15))
                app.buttons["hubAccount"].tap()
            }
            XCTAssertTrue(app.textFields["hubOrigin"].waitForExistence(timeout: 15))
            app.textFields["hubOrigin"].tap(); app.textFields["hubOrigin"].typeText(account.origin)
            app.textFields["hubEmail"].tap(); app.textFields["hubEmail"].typeText(account.email)
            app.secureTextFields["hubPassword"].tap(); app.secureTextFields["hubPassword"].typeText(account.password)
            app.buttons["hubSignIn"].tap()
            // A successful sign-in closes the account sheet on its own, and the
            // invitation this run launched with pulls pairing up in its place —
            // nothing taps 关闭 to get out of the sign-in flow.
            if let enrollment = fixture.enrollment {
                stage("pairing")
                XCTAssertTrue(app.buttons["hubAccount"].waitForExistence(timeout: 30))
                app.buttons["hubAccount"].tap()
                XCTAssertTrue(app.buttons["同账号设备注册"].waitForExistence(timeout: 10))
                app.buttons["同账号设备注册"].tap()
                XCTAssertTrue(app.buttons["enrollmentBegin"].waitForExistence(timeout: 10))
                app.buttons["enrollmentBegin"].tap()
                let code = app.staticTexts["enrollmentRequest"]
                XCTAssertTrue(code.waitForExistence(timeout: 15))
                var request = URLRequest(url: enrollment.approveURL)
                request.httpMethod = "POST"; request.httpBody = Data(code.label.utf8)
                request.setValue("Bearer " + enrollment.approvalToken, forHTTPHeaderField: "Authorization")
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                let completed = expectation(description: "Independent signer approves native request")
                let result = ApprovalBox()
                URLSession.shared.dataTask(with: request) { data, response, error in
                    if let data, (response as? HTTPURLResponse)?.statusCode == 200, error == nil {
                        result.value = String(decoding: data, as: UTF8.self)
                    }
                    completed.fulfill()
                }.resume()
                waitForExpectations(timeout: 15)
                let approved = try XCTUnwrap(result.value)
                app.swipeUp()
                let field = app.textFields["enrollmentApproved"].exists ? app.textFields["enrollmentApproved"] : app.textViews["enrollmentApproved"]
                XCTAssertTrue(field.waitForExistence(timeout: 10))
                field.tap(); field.typeText(approved)
                XCTAssertEqual(field.value as? String, approved, "The complete signed approval is entered")
                app.swipeUp()
                let pin = app.textFields["enrollmentPin"]
                XCTAssertTrue(pin.waitForExistence(timeout: 10))
                pin.tap(); pin.typeText(enrollment.rootKey)
                XCTAssertEqual(pin.value as? String, enrollment.rootKey)
                let independent = app.switches["enrollmentIndependentPin"]
                XCTAssertTrue(independent.waitForExistence(timeout: 10))
                print("Native independent pin before=" + (independent.value as? String ?? "unknown"))
                if (independent.value as? String) != "1" { independent.tap() }
                expectation(for: NSPredicate(format: "value == %@", "1"), evaluatedWith: independent)
                waitForExpectations(timeout: 5)
                print("Native independent pin after=" + (independent.value as? String ?? "unknown"))
                XCTAssertTrue(app.buttons["enrollmentReceive"].isEnabled)
                app.buttons["enrollmentReceive"].tap()
                let completedRegistration = app.staticTexts["enrollmentComplete"]
                let failedRegistration = app.staticTexts["enrollmentError"]
                expectation(for: NSPredicate { _, _ in completedRegistration.exists || failedRegistration.exists }, evaluatedWith: app)
                waitForExpectations(timeout: 20)
                if failedRegistration.exists { print("Native enrollment failure: " + failedRegistration.label) }
                XCTAssertTrue(completedRegistration.exists, "Signed registration succeeds before leaving its sheet")
                // Runtime sessions prove the UI obtained an encrypted member grant rather than trusting a directory row.
                app.buttons["关闭"].tap()
            } else {
            XCTAssertTrue(app.buttons["开始配对"].waitForExistence(timeout: 30))
            // That sheet is gone, so notification enrolment is reached by
            // reopening it rather than by lingering on the sign-in path.
            app.buttons["关闭"].tap()
            XCTAssertTrue(app.buttons["hubAccount"].waitForExistence(timeout: 15))
            app.buttons["hubAccount"].tap()
            XCTAssertTrue(app.buttons["enableNotifications"].waitForExistence(timeout: 15))
            app.buttons["enableNotifications"].tap()
            XCTAssertTrue(app.staticTexts["此连接暂不支持通知"].waitForExistence(timeout: 10))
            app.buttons["关闭"].tap()
            XCTAssertTrue(app.buttons["连接电脑"].firstMatch.waitForExistence(timeout: 15))
            app.buttons["连接电脑"].firstMatch.tap()
            // Dismissing pairing clears the one-use link. Supply it again when
            // returning from the separate notification enrolment flow.
            let link = app.textFields["pairingURI"].exists ? app.textFields["pairingURI"] : app.textViews["pairingURI"]
            XCTAssertTrue(link.waitForExistence(timeout: 5))
            link.tap(); link.typeText(fixture.invitation)
            XCTAssertTrue(link.value as? String == fixture.invitation, "The complete pairing link is entered")

            }
        }
        if fixture.enrollment == nil {
            XCTAssertTrue(app.buttons["开始配对"].waitForExistence(timeout: 15))
            XCTAssertTrue(app.buttons["开始配对"].isEnabled)
            stage("pairing")
            app.buttons["开始配对"].tap()
        }
        XCTAssertTrue(app.staticTexts["已连接"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons[fixture.title].waitForExistence(timeout: 10))
        app.buttons[fixture.title].tap()
        XCTAssertTrue(app.navigationBars[fixture.title].waitForExistence(timeout: 10))
        let draft = app.textFields["messageDraft"].exists ? app.textFields["messageDraft"] : app.textViews["messageDraft"]
        XCTAssertTrue(draft.waitForExistence(timeout: 10))
        stage("draft")
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
        stage("rename")
        menu.tap()
        app.buttons["重命名"].tap()
        let title = app.textFields["renameTitle"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        app.buttons["clearRenameTitle"].tap()
        expectation(for: NSPredicate(format: "value == %@", "会话名称"), evaluatedWith: title)
        waitForExpectations(timeout: 5)
        title.tap()
        title.typeText("Native phone rename")
        print("Native rename input expected=\((title.value as? String) == "Native phone rename")")
        XCTAssertEqual(title.value as? String, "Native phone rename")
        app.buttons["保存"].tap()
        XCTAssertTrue(app.navigationBars["Native phone rename"].waitForExistence(timeout: 15))
        XCTAssertEqual(draft.value as? String, "retained phone draft")
        menu.tap()
        app.buttons["Agent / 模型"].tap()
        stage("agent")
        let agentPicker = app.descendants(matching: .any).matching(identifier: "agentChoice").firstMatch
        XCTAssertTrue(agentPicker.waitForExistence(timeout: 15))
        agentPicker.tap()
        app.buttons["plan"].tap()
        app.buttons["保存 Agent"].tap()
        XCTAssertTrue(app.navigationBars["Native phone rename"].waitForExistence(timeout: 15))
        menu.tap()
        app.buttons["Agent / 模型"].tap()
        stage("model")
        let modelPicker = app.descendants(matching: .any).matching(identifier: "modelChoice").firstMatch
        XCTAssertTrue(modelPicker.waitForExistence(timeout: 15))
        modelPicker.tap()
        app.buttons["fixture / Remote selection fixture"].tap()
        let variantPicker = app.descendants(matching: .any).matching(identifier: "variantChoice").firstMatch
        XCTAssertTrue(variantPicker.waitForExistence(timeout: 10))
        variantPicker.tap()
        app.buttons["reasoning"].tap()
        app.buttons["保存模型"].tap()
        XCTAssertTrue(app.navigationBars["Native phone rename"].waitForExistence(timeout: 15))
        stage("relaunch")
        app.terminate()
        app.launchEnvironment.removeValue(forKey: "MIAO_UI_TEST_INVITATION")
        app.launch()
        XCTAssertTrue(app.staticTexts["已连接"].waitForExistence(timeout: 30))
        app.buttons["Native phone rename"].tap()
        XCTAssertTrue(draft.waitForExistence(timeout: 10))
        XCTAssertEqual(draft.value as? String, "retained phone draft")
        stage("prompt")
        app.descendants(matching: .any).matching(identifier: "queueInput").firstMatch.tap()
        app.buttons["sendMessage"].tap()
        let cleared = NSPredicate(format: "value != %@", "retained phone draft")
        expectation(for: cleared, evaluatedWith: draft)
        waitForExpectations(timeout: 15)
        if app.keyboards.count > 0 { app.buttons["dismissKeyboard"].tap() }
        stage("live")
        app.swipeUp()
        XCTAssertTrue(app.staticTexts["Native live partial"].waitForExistence(timeout: 30))
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.staticTexts["Native live partial"].waitForExistence(timeout: 30))
        stage("settlement")
        _ = try Data(contentsOf: URL(string: fixture.finishURL)!)
        XCTAssertTrue(app.staticTexts["Native live partial completed"].waitForExistence(timeout: 30))
        stage("restart")
        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts["已连接"].waitForExistence(timeout: 30))
        app.buttons["Native phone rename"].tap()
        app.swipeUp()
        XCTAssertTrue(app.staticTexts["Native live partial completed"].waitForExistence(timeout: 30))
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "Native live partial completed")).count, 1)
        stage("done")
    }

}

import XCTest
import Darwin
import UIKit

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

    /// The enrollment section is a long disclosure whose later rows are only
    /// materialized once scrolled near, so a plain wait never sees them. Scroll
    /// until the control enters the tree; hittability is handled by the caller,
    /// since the keyboard can cover a materialized field.
    private func scrollIntoView(_ app: XCUIApplication, _ element: XCUIElement, swipes: Int = 10) {
        for _ in 0..<swipes where !element.exists { app.swipeUp() }
    }

    /// Resign the software keyboard through the form's 完成 toolbar button; the
    /// rows it covers are unloaded, and a swipe that starts on the focused field
    /// scrolls its text instead of the form, so it never reloads them.
    private func dismissKeyboard(_ app: XCUIApplication) {
        let done = app.buttons["dismissAccountKeyboard"]
        if done.waitForExistence(timeout: 2) { done.tap() }
    }

    @MainActor
    private func paste(_ text: String, into field: XCUIElement, app: XCUIApplication) {
        // Signed enrollment envelopes are pasted by users; synthesizing every
        // keystroke can lose characters while a multiline SwiftUI field updates.
        UIPasteboard.general.string = text
        defer { UIPasteboard.general.string = nil }
        field.tap()
        // Focusing a multiline field moves the keyboard toolbar over its old
        // position. Scroll the form margin so the long press reaches the field.
        for _ in 0..<3 {
            let keyboard = app.keyboards.firstMatch
            if !keyboard.exists || field.frame.maxY < keyboard.frame.minY - 60 { break }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.45))
                .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.2)))
        }
        field.press(forDuration: 1)
        let label = NSPredicate(format: "label IN %@", ["Paste", "粘贴"])
        let inApp = app.descendants(matching: .any).matching(label).firstMatch
        if !inApp.waitForExistence(timeout: 2) { field.doubleTap() }
        let inSystem = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            .descendants(matching: .any).matching(label).firstMatch
        let paste = inApp.exists ? inApp : inSystem
        print("NativePasteState:clipboard=\(UIPasteboard.general.hasStrings) available=\(paste.exists)")
        XCTAssertTrue(paste.waitForExistence(timeout: 5))
        paste.tap()
        expectation(for: NSPredicate(format: "value == %@", text), evaluatedWith: field)
        waitForExpectations(timeout: 5)
        XCTAssertEqual(field.value as? String, text, "The complete signed input is entered")
    }

    @MainActor
    private func openDrawer(_ app: XCUIApplication) {
        // Account enrollment can dismiss its sheet back to an already-open drawer.
        let close = app.buttons["关闭侧栏"].firstMatch
        if !close.exists {
            // Pairing can take seconds to replace the empty screen.
            let toggles = app.buttons.matching(identifier: "sessionSidebar")
            let toggle = toggles.firstMatch
            XCTAssertTrue(toggle.waitForExistence(timeout: 30))
            XCTAssertEqual(toggles.count, 1, "The navigation bar owns the only sidebar toggle")
            expectation(for: NSPredicate { _, _ in toggle.isHittable }, evaluatedWith: toggle)
            waitForExpectations(timeout: 30)
            if toggle.isHittable { toggle.tap() }
        }
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons.matching(identifier: "hubAccount").count, 1,
                       "The sidebar account entry has an unambiguous identifier")
    }

    @MainActor
    func testRealRuntimeRenameAndDraftRecovery() throws {
        guard let path = ProcessInfo.processInfo.environment["MIAO_UI_TEST_FIXTURE"], !path.isEmpty,
              !path.hasPrefix("$(") else { throw XCTSkip("Live Runtime fixture is supplied by check-app.ts") }
        struct Account: Decodable { let origin: String; let email: String; let password: String }
        struct Enrollment: Decodable { let approveURL: URL; let approvalToken: String; let rootKey: String }
        struct Fixture: Decodable { let runID: String; let invitation: String; let title: String; let account: Account?; let finishURL: String; let enrollment: Enrollment?; let accountAccess: Bool? }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        stage("launch")
        let app = XCUIApplication()
        app.launchEnvironment["MIAO_UI_TEST_RUN"] = fixture.runID
        if !fixture.invitation.isEmpty { app.launchEnvironment["MIAO_UI_TEST_INVITATION"] = fixture.invitation }
        if fixture.account != nil { app.launchEnvironment["MIAO_UI_TEST_HUB_ACCOUNT"] = "1" }
        if fixture.enrollment != nil { app.launchEnvironment["MIAO_UI_TEST_ENROLLMENT"] = "1" }
        app.launch()
        if let account = fixture.account {
            stage("account")
            if fixture.enrollment != nil || fixture.accountAccess == true {
                let toggles = app.buttons.matching(identifier: "sessionSidebar")
                XCTAssertTrue(toggles.firstMatch.waitForExistence(timeout: 15))
                XCTAssertEqual(toggles.count, 1, "The empty screen exposes the sidebar toggle")
                let accountEntry = app.buttons["emptyHubAccount"]
                XCTAssertTrue(accountEntry.waitForExistence(timeout: 15))
                accountEntry.tap()
            }
            // Both account paths authenticate against this run's isolated Hub.
            XCTAssertTrue(app.textFields["hubOrigin"].waitForExistence(timeout: 15))
            app.textFields["hubOrigin"].tap(); app.textFields["hubOrigin"].typeText(account.origin)
            app.textFields["hubEmail"].tap(); app.textFields["hubEmail"].typeText(account.email)
            app.secureTextFields["hubPassword"].tap(); app.secureTextFields["hubPassword"].typeText(account.password)
            app.buttons["hubSignIn"].tap()
            // A successful sign-in closes the account sheet on its own, and the
            // invitation this run launched with pulls pairing up in its place —
            // nothing taps 关闭 to get out of the sign-in flow.
            if fixture.accountAccess == true {
                XCTAssertTrue(fixture.invitation.isEmpty, "Same-account access must start without any pairing invitation")
                XCTAssertNil(fixture.enrollment, "Same-account access must not bootstrap a roster signing device")
                // Sign-in dismisses the account sheet. The directory and encrypted
                // account handshake must discover the published Session on their own.
            } else if let enrollment = fixture.enrollment {
                stage("pairing")
                openDrawer(app)
                // Sign-in dismisses the account sheet on its own, so reopening it
                // can race that dismissal; retry until the signed-in sheet shows
                // the enrollment controls. The enrollment section is a lazy Form
                // row, so scroll it into the tree before waiting.
                let enrollmentBegin = app.buttons["enrollmentBegin"]
                for _ in 0..<10 where !enrollmentBegin.exists {
                    if app.buttons["hubAccount"].isHittable { app.buttons["hubAccount"].tap() }
                    scrollIntoView(app, enrollmentBegin, swipes: 3)
                }
                XCTAssertTrue(enrollmentBegin.waitForExistence(timeout: 10))
                enrollmentBegin.tap()
                let code = app.staticTexts["enrollmentRequest"]
                scrollIntoView(app, code)
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
                scrollIntoView(app, field)
                XCTAssertTrue(field.waitForExistence(timeout: 10))
                paste(approved, into: field, app: app)
                dismissKeyboard(app)
                let pin = app.textFields["enrollmentPin"]
                scrollIntoView(app, pin)
                print("Native enrollment fields approved=\(field.exists) pin=\(pin.exists) independent=\(app.switches["enrollmentIndependentPin"].exists) textFields=\(app.textFields.count) keyboards=\(app.keyboards.count)")
                XCTAssertTrue(pin.waitForExistence(timeout: 10))
                paste(enrollment.rootKey, into: pin, app: app)
                dismissKeyboard(app)
                let independent = app.switches["enrollmentIndependentPin"]
                scrollIntoView(app, independent)
                XCTAssertTrue(independent.waitForExistence(timeout: 10))
                // SwiftUI toggles inside disclosure rows often swallow element taps on
                // iOS 18; hit the switch knob by coordinate and fall back to the row.
                if (independent.value as? String) != "1" {
                    independent.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
                }
                if (independent.value as? String) != "1" { independent.tap() }
                expectation(for: NSPredicate(format: "value == %@", "1"), evaluatedWith: independent)
                waitForExpectations(timeout: 5)
                XCTAssertEqual(independent.value as? String, "1", "Independent source confirmation is on")
                let receive = app.buttons["enrollmentReceive"]
                scrollIntoView(app, receive)
                XCTAssertTrue(receive.isEnabled)
                receive.tap()
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
            XCTAssertTrue(app.buttons["emptyHubAccount"].waitForExistence(timeout: 15))
            app.buttons["emptyHubAccount"].tap()
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
        if fixture.enrollment == nil && fixture.accountAccess != true {
            XCTAssertTrue(app.buttons["开始配对"].waitForExistence(timeout: 15))
            XCTAssertTrue(app.buttons["开始配对"].isEnabled)
            stage("pairing")
            app.buttons["开始配对"].tap()
        }
        openDrawer(app)
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
        let plan = app.descendants(matching: .any).matching(identifier: "plan").firstMatch
        let hasPlan = plan.waitForExistence(timeout: 10)
        let planButton = app.buttons["plan"].exists
        let planText = app.staticTexts["plan"].exists
        print("NativeAgentChoice plan=\(hasPlan) button=\(planButton) staticText=\(planText) picker=\(agentPicker.exists) hittable=\(agentPicker.isHittable)")
        XCTAssertTrue(hasPlan, "The Agent picker must offer the real Runtime's plan agent")
        expectation(for: NSPredicate { _, _ in plan.isHittable }, evaluatedWith: plan)
        waitForExpectations(timeout: 10)
        plan.tap()
        expectation(for: NSPredicate(format: "value == %@", "plan"), evaluatedWith: agentPicker)
        waitForExpectations(timeout: 10)
        let saveAgent = app.buttons["保存 Agent"]
        XCTAssertTrue(saveAgent.waitForExistence(timeout: 10))
        expectation(for: NSPredicate { _, _ in saveAgent.isHittable && saveAgent.isEnabled }, evaluatedWith: saveAgent)
        waitForExpectations(timeout: 10)
        saveAgent.tap()
        XCTAssertTrue(app.navigationBars["Native phone rename"].waitForExistence(timeout: 15))
        menu.tap()
        app.buttons["Agent / 模型"].tap()
        stage("model")
        let modelPicker = app.descendants(matching: .any).matching(identifier: "modelChoice").firstMatch
        XCTAssertTrue(modelPicker.waitForExistence(timeout: 15))
        modelPicker.tap()
        let selectedModel = app.descendants(matching: .any).matching(identifier: "fixture / Remote selection fixture").firstMatch
        XCTAssertTrue(selectedModel.waitForExistence(timeout: 10))
        expectation(for: NSPredicate { _, _ in selectedModel.isHittable }, evaluatedWith: selectedModel)
        waitForExpectations(timeout: 10)
        selectedModel.tap()
        expectation(for: NSPredicate(format: "value == %@", "fixture / Remote selection fixture"), evaluatedWith: modelPicker)
        waitForExpectations(timeout: 10)
        let variantPicker = app.descendants(matching: .any).matching(identifier: "variantChoice").firstMatch
        XCTAssertTrue(variantPicker.waitForExistence(timeout: 10))
        variantPicker.tap()
        let reasoning = app.descendants(matching: .any).matching(identifier: "reasoning").firstMatch
        XCTAssertTrue(reasoning.waitForExistence(timeout: 5))
        expectation(for: NSPredicate { _, _ in reasoning.isHittable }, evaluatedWith: reasoning)
        waitForExpectations(timeout: 5)
        reasoning.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        expectation(for: NSPredicate(format: "value == %@", "reasoning"), evaluatedWith: variantPicker)
        waitForExpectations(timeout: 5)
        // The expanded registration disclosure pushes the save action off-screen.
        let saveModel = app.buttons["保存模型"]
        for _ in 0..<6 where saveModel.exists && !saveModel.isHittable { app.swipeUp() }
        XCTAssertTrue(saveModel.waitForExistence(timeout: 10))
        saveModel.tap()
        XCTAssertTrue(app.navigationBars["Native phone rename"].waitForExistence(timeout: 15))
        stage("relaunch")
        app.terminate()
        app.launchEnvironment.removeValue(forKey: "MIAO_UI_TEST_INVITATION")
        app.launch()
        openDrawer(app)
        let restored = app.staticTexts["已连接"].waitForExistence(timeout: 30)
        if !restored {
            let states = ["正在连接…", "正在同步会话…", "授权需要重新核对", "请更新电脑和 App 的版本", "离线，回到前台后会重新连接", "正在断开连接…", "等待连接", "账号远控接入被拒绝，请确认电脑与中继支持账号接入，且两端登录的是同一账号", "请更新电脑和 App 后重试账号远控", "暂时无法连接中继，请检查网络后重试", "中继登录未恢复，请重新登录"]
            let visibleStates = states.filter { app.staticTexts[$0].exists }.joined(separator: ",")
            let toggle = app.buttons["sessionSidebar"].firstMatch
            print("NativeAccountRestore status=\(toggle.value as? String ?? "unknown") states=\(visibleStates) login=\(app.buttons["登录中继"].exists) blocked=\(app.staticTexts["登录已失效，请重新登录中继"].exists)")
        }
        XCTAssertTrue(restored)
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
        openDrawer(app)
        XCTAssertTrue(app.staticTexts["已连接"].waitForExistence(timeout: 30))
        app.buttons["Native phone rename"].tap()
        app.swipeUp()
        XCTAssertTrue(app.staticTexts["Native live partial completed"].waitForExistence(timeout: 30))
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "Native live partial completed")).count, 1)
        stage("remove-host")
        openDrawer(app)
        let remove = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "removeHost-")).firstMatch
        XCTAssertTrue(remove.waitForExistence(timeout: 5))
        remove.tap()
        XCTAssertTrue(app.buttons["取消"].waitForExistence(timeout: 5))
        app.buttons["取消"].tap()
        XCTAssertTrue(remove.exists, "Cancelling must keep the selected computer")
        remove.tap()
        app.buttons["移除"].tap()
        expectation(for: NSPredicate { _, _ in !remove.exists }, evaluatedWith: app)
        waitForExpectations(timeout: 15)
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["连接电脑"].firstMatch.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "removeHost-")).firstMatch.exists)
        stage("done")
    }

}

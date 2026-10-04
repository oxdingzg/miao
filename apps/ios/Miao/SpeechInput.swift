import SwiftUI
import Speech
import AVFoundation
import Observation

@MainActor @Observable
final class SpeechInput {
    var recording = false
    var requesting = false
    var error: String?
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var generation = 0
    private var tapped = false
    private var expectedDraft = ""

    /// Recognition only edits the draft. It never submits a prompt or approval.
    func start(text: String, accept: @escaping @MainActor (String, String) -> Bool) async {
        guard !recording, !requesting else { return }
        generation += 1; let current = generation
        requesting = true; error = nil
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        let microphone = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard generation == current else { return }
        requesting = false
        guard speech == .authorized, microphone else { error = "请在系统设置中允许麦克风和语音识别"; return }
        guard let recognizer = SFSpeechRecognizer(locale: .autoupdatingCurrent), recognizer.isAvailable,
              recognizer.supportsOnDeviceRecognition else {
            error = "当前无法使用离线语音识别，也可以使用系统键盘的听写功能"; return
        }
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audio.setActive(true, options: .notifyOthersOnDeactivation)
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true; request.requiresOnDeviceRecognition = true
            self.request = request
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { throw CocoaError(.featureUnsupported) }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
            tapped = true
            engine.prepare(); try engine.start(); recording = true
            expectedDraft = text
            task = recognizer.recognitionTask(with: request) { [weak self] result, failure in
                let words = result?.bestTranscription.formattedString
                let finished = result?.isFinal == true || failure != nil
                Task { @MainActor in
                    guard let self, self.generation == current else { return }
                    if let words {
                        let value = text + (text.isEmpty || text.hasSuffix(" ") || text.hasSuffix("\n") ? "" : " ") + words
                        guard accept(self.expectedDraft, value) else { self.stop(); self.error = "输入已更改，语音已停止"; return }
                        self.expectedDraft = value
                    }
                    if finished { self.stop() }
                }
            }
        } catch { stop(); self.error = "语音输入暂时不可用" }
    }

    func stop() {
        generation += 1; requesting = false; recording = false
        engine.stop()
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        request?.endAudio(); task?.cancel(); task = nil; request = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

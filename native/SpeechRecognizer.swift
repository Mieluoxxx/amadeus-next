import AVFoundation
import Foundation
import Speech

final class SpeechService: NSObject {
    private var recognizer: SFSpeechRecognizer?
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var running = false
    private var finishing = false
    private var generation = 0
    private var starting = false
    private var recognitionId = 0

    private func emit(_ value: [String: Any]) {
        var payload = value
        payload["recognition_id"] = recognitionId
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let line = String(data: data, encoding: .utf8) else { return }
        if let data = "\(line)\n".data(using: .utf8) {
            FileHandle.standardOutput.write(data)
        }
    }

    func start(locale: String, recognitionId: Int) {
        if running || starting { return }
        self.recognitionId = recognitionId
        generation += 1
        let currentGeneration = generation
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable else {
            emit(["type": "error", "error": "Apple Speech is unavailable"])
            return
        }
        self.recognizer = recognizer
        starting = true
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self, self.generation == currentGeneration else { return }
                self.starting = false
                guard status == .authorized else {
                    self.emit(["type": "error", "error": "Speech recognition authorization was denied"])
                    return
                }
                self.begin(recognizer: recognizer, generation: currentGeneration)
            }
        }
    }

    private func begin(recognizer: SFSpeechRecognizer, generation currentGeneration: Int) {
        task?.cancel()
        task = nil
        request = SFSpeechAudioBufferRecognitionRequest()
        guard let request else { return }
        request.shouldReportPartialResults = true
        let input = audioEngine.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
            request.append(buffer)
        }
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            emit(["type": "error", "error": "Microphone could not start: \(error.localizedDescription)"])
            input.removeTap(onBus: 0)
            self.request = nil
            return
        }
        running = true
        emit(["type": "status", "status": "listening"])
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
          DispatchQueue.main.async {
            guard let self, self.generation == currentGeneration, self.running else { return }
            if let result {
                self.emit([
                    "type": "recognized",
                    "text": result.bestTranscription.formattedString,
                    "is_final": result.isFinal,
                ])
                if result.isFinal { self.stop(); return }
            }
            if let error {
                let failure = error as NSError
                self.emit(["type": "error", "error": failure.localizedDescription, "domain": failure.domain, "code": failure.code])
                self.stop()
            }
          }
        }
    }

    func finish() {
        if starting { stop(); return }
        guard running, !finishing else { return }
        finishing = true
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
        task?.finish()
        emit(["type": "status", "status": "processing"])
    }

    func stop() {
        generation += 1
        starting = false
        running = false
        finishing = false
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        task?.cancel()
        task = nil
        request = nil
        recognizer = nil
        emit(["type": "status", "status": "idle"])
    }
}

let service = SpeechService()

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let name = command["command"] as? String else { continue }
        DispatchQueue.main.async {
            switch name {
            case "start":
                service.start(locale: (command["locale"] as? String) ?? "zh-CN", recognitionId: (command["recognition_id"] as? Int) ?? 0)
            case "stop":
                service.stop()
            case "finish":
                service.finish()
            default:
                break
            }
        }
    }
    DispatchQueue.main.async { service.stop(); exit(0) }
}

RunLoop.main.run()

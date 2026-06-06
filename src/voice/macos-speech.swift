import AVFoundation
import Foundation
import Speech

struct SpeechEvent: Encodable {
  let type: String
  let text: String?
  let is_final: Bool?
  let message: String?
}

func emit(_ event: SpeechEvent) {
  let encoder = JSONEncoder()
  guard let data = try? encoder.encode(event), let line = String(data: data, encoding: .utf8) else {
    return
  }
  print(line)
  fflush(stdout)
}

func fail(_ message: String) -> Never {
  emit(SpeechEvent(type: "error", text: nil, is_final: nil, message: message))
  exit(1)
}

func argValue(_ name: String, fallback: String) -> String {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else {
    return fallback
  }
  return args[index + 1]
}

func requestSpeechAuthorization() {
  let semaphore = DispatchSemaphore(value: 0)
  var status: SFSpeechRecognizerAuthorizationStatus = .notDetermined
  SFSpeechRecognizer.requestAuthorization { nextStatus in
    status = nextStatus
    semaphore.signal()
  }
  semaphore.wait()

  switch status {
  case .authorized:
    return
  case .denied:
    fail("macOS speech recognition permission was denied")
  case .restricted:
    fail("macOS speech recognition is restricted on this Mac")
  case .notDetermined:
    fail("macOS speech recognition permission was not granted")
  @unknown default:
    fail("macOS speech recognition authorization failed")
  }
}

func requestMicrophoneAuthorization() {
  let semaphore = DispatchSemaphore(value: 0)
  var granted = false
  AVCaptureDevice.requestAccess(for: .audio) { ok in
    granted = ok
    semaphore.signal()
  }
  semaphore.wait()
  if !granted {
    fail("microphone permission was denied")
  }
}

let localeId = argValue("--lang", fallback: "zh-CN")
let recognitionMode = argValue("--mode", fallback: "auto")
let inputMode = argValue("--input", fallback: "stdin")
guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
  fail("macOS speech recognizer is unavailable for locale \(localeId)")
}

if !recognizer.isAvailable {
  fail("macOS speech recognizer is currently unavailable")
}

requestSpeechAuthorization()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
request.taskHint = .dictation
request.contextualStrings = [
  "API", "ASR", "TTS", "Mac", "macOS", "OpenAI", "DeepSeek", "MiniMax",
  "Claude", "Gemini", "ChatGPT", "GPT", "Agent", "Bailongma", "Longma",
  "GitHub", "Electron", "JavaScript", "TypeScript", "Python", "Swift",
  "WebSocket", "HTTP", "localhost", "prompt", "token", "model",
]

if #available(macOS 10.15, *) {
  if recognitionMode == "online" {
    request.requiresOnDeviceRecognition = false
  } else if recognizer.supportsOnDeviceRecognition {
    request.requiresOnDeviceRecognition = true
  } else if recognitionMode == "local" || recognitionMode == "on-device" {
    fail("on-device speech recognition is not available for locale \(localeId)")
  } else {
    request.requiresOnDeviceRecognition = false
  }
}

var lastFinalText = ""
let task = recognizer.recognitionTask(with: request) { result, error in
  if let result = result {
    let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty && text != lastFinalText {
      emit(SpeechEvent(type: "transcript", text: text, is_final: result.isFinal, message: nil))
      if result.isFinal {
        lastFinalText = text
      }
    }
  }

  if let error = error {
    emit(SpeechEvent(type: "error", text: nil, is_final: nil, message: error.localizedDescription))
    exit(1)
  }
}

let modeLabel: String
if #available(macOS 10.15, *) {
  modeLabel = request.requiresOnDeviceRecognition ? "on-device" : "system"
} else {
  modeLabel = "system"
}
emit(SpeechEvent(type: "ready", text: nil, is_final: nil, message: "macOS \(modeLabel) speech recognition ready"))

if inputMode == "microphone" {
  requestMicrophoneAuthorization()

  let audioEngine = AVAudioEngine()
  let inputNode = audioEngine.inputNode
  let format = inputNode.outputFormat(forBus: 0)

  inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    request.append(buffer)
  }

  do {
    audioEngine.prepare()
    try audioEngine.start()
  } catch {
    task.cancel()
    fail("failed to start microphone capture: \(error.localizedDescription)")
  }
} else {
  guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: false) else {
    fail("failed to create PCM input format")
  }
  var pendingBytes = Data()

  func appendPCM(_ data: Data) {
    pendingBytes.append(data)
    let usableBytes = pendingBytes.count - (pendingBytes.count % MemoryLayout<Int16>.size)
    if usableBytes <= 0 { return }
    let chunk = pendingBytes.prefix(usableBytes)
    pendingBytes.removeFirst(usableBytes)
    let frameCount = AVAudioFrameCount(chunk.count / MemoryLayout<Int16>.size)
    if frameCount == 0 { return }
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return }
    buffer.frameLength = frameCount
    chunk.withUnsafeBytes { rawBuffer in
      guard let src = rawBuffer.bindMemory(to: Int16.self).baseAddress,
            let dst = buffer.int16ChannelData?[0] else { return }
      dst.update(from: src, count: Int(frameCount))
    }
    request.append(buffer)
  }

  FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty {
      FileHandle.standardInput.readabilityHandler = nil
      request.endAudio()
      return
    }
    appendPCM(data)
  }
}

RunLoop.main.run()

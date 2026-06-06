import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const source = path.join(root, 'src', 'voice', 'macos-speech.swift')
const output = path.join(root, 'build', 'native-speech-recognizer')
const plist = path.join(root, 'build', 'native-speech-recognizer-Info.plist')

if (process.platform !== 'darwin') {
  console.log('[macos-speech] skipping native speech build on non-macOS')
  process.exit(0)
}

if (!fs.existsSync(source)) {
  console.error(`[macos-speech] source not found: ${source}`)
  process.exit(1)
}

fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.xiaoyuanda.bailongma.native-speech-recognizer</string>
  <key>CFBundleName</key>
  <string>Bailongma Speech Recognizer</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>Bailongma uses macOS Speech Recognition for local voice input when available.</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>Bailongma uses the microphone for voice input when you enable voice features.</string>
</dict>
</plist>
`, 'utf8')

const result = spawnSync('swiftc', [
  source,
  '-framework', 'Speech',
  '-framework', 'AVFoundation',
  '-Xlinker', '-sectcreate',
  '-Xlinker', '__TEXT',
  '-Xlinker', '__info_plist',
  '-Xlinker', plist,
  '-o', output,
], { stdio: 'inherit' })

if (result.status !== 0) {
  console.error('[macos-speech] swiftc failed; macOS local speech recognition helper was not built')
  process.exit(result.status || 1)
}

fs.chmodSync(output, 0o755)
console.log(`[macos-speech] built ${output}`)

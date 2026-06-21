import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-voice-provider-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()

try {
  const configFile = path.join(tmp, 'config.json')
  fs.writeFileSync(configFile, JSON.stringify({
    voice: {
      provider: 'local',
    },
  }, null, 2))

  const {
    getVoiceConfig,
    normalizeVoiceProvider,
    setVoiceConfig,
  } = await import('./config.js')

  assert.equal(normalizeVoiceProvider('macos'), 'local', 'macos alias maps to local ASR')
  assert.equal(normalizeVoiceProvider('macos-local'), 'local', 'legacy macos-local alias maps to local ASR')
  assert.equal(normalizeVoiceProvider('doubao'), 'volcengine', 'doubao alias maps to volcengine ASR')
  assert.equal(normalizeVoiceProvider('iflytek'), 'xunfei', 'iflytek alias maps to xunfei ASR')
  assert.equal(normalizeVoiceProvider('unknown-provider'), 'aliyun', 'unknown ASR provider falls back to aliyun')

  assert.equal(getVoiceConfig().voiceProvider, 'local', 'legacy voice.provider is used when voiceProvider is absent')

  setVoiceConfig({ voiceProvider: 'macos' })
  assert.equal(getVoiceConfig().voiceProvider, 'local', 'saved ASR provider aliases are normalized')

  setVoiceConfig({ voiceProvider: 'unknown-provider' })
  assert.equal(getVoiceConfig().voiceProvider, 'local', 'invalid ASR provider keeps previous valid provider')

  console.log('PASS voice provider aliases and legacy provider field')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

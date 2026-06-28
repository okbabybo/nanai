import { emitEvent } from './events.js'

const MAX_CHUNKS = 800
const MAX_TOTAL_CHARS = 120_000
const DEFAULT_TITLE = 'Bailongma Terminal Stream'
const sessions = new Map()

function nowIso() {
  return new Date().toISOString()
}

function normalizeStreamId(value = '') {
  const id = String(value || 'default').trim()
  return id.replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 80) || 'default'
}

function normalizeLevel(value = '') {
  const level = String(value || 'info').trim().toLowerCase()
  return ['info', 'success', 'warning', 'error', 'muted'].includes(level) ? level : 'info'
}

function normalizeFormat(value = '') {
  const format = String(value || '').trim().toLowerCase()
  return ['plain', 'markdown', 'code'].includes(format) ? format : ''
}

function normalizeOptionalBoolean(value) {
  if (value === undefined) return undefined
  if (value === true || value === false) return value
  const text = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(text)) return true
  if (['false', '0', 'no', 'off', ''].includes(text)) return false
  return !!value
}

function getSession(streamId = 'default') {
  const id = normalizeStreamId(streamId)
  if (!sessions.has(id)) {
    sessions.set(id, {
      stream_id: id,
      title: DEFAULT_TITLE,
      format: 'plain',
      artifact_kind: '',
      artifact_path: '',
      hold_open: false,
      chunks: [],
      closed: false,
      updated_at: nowIso(),
    })
  }
  return sessions.get(id)
}

function trimSession(session) {
  while (session.chunks.length > MAX_CHUNKS) session.chunks.shift()

  let total = session.chunks.reduce((sum, chunk) => sum + String(chunk.text || '').length + 1, 0)
  while (total > MAX_TOTAL_CHARS && session.chunks.length > 1) {
    const removed = session.chunks.shift()
    total -= String(removed?.text || '').length + 1
  }
}

export function getTerminalStreamSnapshot(streamId = 'default') {
  const session = getSession(streamId)
  return {
    stream_id: session.stream_id,
    title: session.title,
    format: session.format,
    artifact_kind: session.artifact_kind,
    artifact_path: session.artifact_path,
    hold_open: !!session.hold_open,
    closed: session.closed,
    updated_at: session.updated_at,
    chunks: session.chunks.map(chunk => ({ ...chunk })),
  }
}

export function recordTerminalStreamEvent({
  action = 'write',
  stream_id = 'default',
  title = '',
  text = '',
  newline = true,
  level = 'info',
  format = '',
  artifact_kind = '',
  artifact_path = '',
  hold_open,
  force = false,
} = {}) {
  let normalizedAction = String(action || 'write').trim().toLowerCase()
  const session = getSession(stream_id)
  const ts = nowIso()

  if (title !== undefined && String(title || '').trim()) {
    session.title = String(title).trim().slice(0, 120)
  }
  const normalizedFormat = normalizeFormat(format)
  if (normalizedFormat) session.format = normalizedFormat
  if (artifact_kind !== undefined && String(artifact_kind || '').trim()) {
    session.artifact_kind = String(artifact_kind).trim().slice(0, 80)
  }
  if (artifact_path !== undefined && String(artifact_path || '').trim()) {
    session.artifact_path = String(artifact_path).trim().slice(0, 260)
  }
  const normalizedHoldOpen = normalizeOptionalBoolean(hold_open)
  const forceClose = normalizeOptionalBoolean(force) === true
  if (normalizedHoldOpen !== undefined) session.hold_open = normalizedHoldOpen

  if (normalizedAction === 'clear') {
    if (!normalizedFormat) session.format = 'plain'
    if (!String(artifact_kind || '').trim()) session.artifact_kind = ''
    if (!String(artifact_path || '').trim()) session.artifact_path = ''
    if (normalizedHoldOpen === undefined) session.hold_open = false
    session.chunks = []
    session.closed = false
  } else if (normalizedAction === 'write') {
    const body = String(text ?? '')
    if (body) {
      session.chunks.push({
        text: body,
        newline: newline !== false,
        level: normalizeLevel(level),
        ts,
      })
    }
    session.closed = false
  } else if (normalizedAction === 'open') {
    session.closed = false
  } else if (normalizedAction === 'close') {
    if (session.hold_open && !forceClose) {
      normalizedAction = 'open'
      session.closed = false
    } else {
      session.closed = true
    }
  }

  session.updated_at = ts
  trimSession(session)

  const data = {
    action: normalizedAction,
    stream_id: session.stream_id,
    title: session.title,
    format: session.format,
    artifact_kind: session.artifact_kind,
    artifact_path: session.artifact_path,
    hold_open: !!session.hold_open,
    text: normalizedAction === 'write' ? String(text ?? '') : '',
    newline: newline !== false,
    level: normalizeLevel(level),
    closed: session.closed,
  }

  emitEvent('terminal_stream', data)
  return getTerminalStreamSnapshot(session.stream_id)
}

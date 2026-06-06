import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { nowTimestamp } from '../../time.js'
import {
  upsertMusicTrack,
  getMusicTrack,
  searchMusicLibrary,
  listMusicLibrary,
  updateMusicLrc,
  deleteMusicTrack as dbDeleteMusicTrack,
} from '../../db.js'
import { emitEvent } from '../../events.js'
import { pushMessage } from '../../queue.js'
import { callCapability } from '../../providers/registry.js'
import { isDailyLimitReached } from '../../quota.js'
import { getTTSCredentials, getSeedanceConfig } from '../../config.js'
import { streamTTS } from '../../voice/tts-providers.js'
import { paths } from '../../paths.js'
import { SANDBOX_ROOT } from '../sandbox.js'

const IS_WIN = process.platform === 'win32'

// speak：将文字转为语音，保存为音频文件
// 有效的 MiniMax 声音 ID
const VALID_VOICE_IDS = new Set([
  'male-qn-qingse', 'male-qn-jingying', 'male-qn-badao', 'male-qn-daxuesheng',
  'female-shaonv', 'female-yujie', 'female-chengshu', 'female-tianmei',
  'presenter_male', 'presenter_female', 'audiobook_male_1', 'audiobook_female_1',
])
const DEFAULT_VOICE = 'male-qn-qingse'

export async function execSpeak(args) {
  const text = args.text || args.content || args.words || args.speech
  const { filename } = args
  console.log(`[speak] args:`, JSON.stringify(args))
  if (!text) return '错误：未提供要朗读的文字'
  if (isDailyLimitReached('tts')) return '错误：今日 TTS 配额已用完'
  if (text.length > 1000) return `错误：文字过长（${text.length} 字），请控制在 1000 字以内`

  const creds = getTTSCredentials()
  const voiceId = (args.voice_id || args.voice) || creds.voiceId

  const nodeStream = await streamTTS({ text, provider: creds.provider, voiceId, keys: creds })
  const chunks = []
  for await (const chunk of nodeStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const buffer = Buffer.concat(chunks)

  const ts = nowTimestamp().replace(/[:.+]/g, '-').slice(0, 19)
  const fname = filename ? filename.replace(/[^a-zA-Z0-9_一-龥-]/g, '') + '.mp3' : `speech_${ts}.mp3`
  const resolved = path.resolve(SANDBOX_ROOT, 'audio', fname)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, buffer)

  const relPath = `audio/${fname}`
  emitEvent('audio_created', { path: relPath, text: text.slice(0, 60), autoPlay: true })
  console.log(`[speak] 已生成: ${relPath}`)
  return `语音已生成：${relPath}`
}

// 语音消息自动回复 TTS：检测到用户用语音输入时，通知前端播放语音
// 由 index.js 调用，前端收到 tts_reply 事件后调用 /tts/stream 完成实际合成
export function autoSpeakForVoiceReply(text) {
  if (!text) return
  const plain = text.trim()
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^\)]+\)/g, '')
    .replace(/\n+/g, ' ')
    .trim()
  if (!plain) return
  emitEvent('tts_reply', { text: plain })
}

// generate_lyrics：生成歌词
export async function execGenerateLyrics({ prompt, mode }) {
  if (!prompt) return '错误：未提供创作方向'
  if (isDailyLimitReached('lyrics')) return '错误：今日歌词生成配额已用完'

  const result = await callCapability('lyrics', { prompt, mode })

  // 自动保存歌词到 sandbox
  const ts = nowTimestamp().replace(/[:.+]/g, '-').slice(0, 19)
  const fname = `lyrics_${ts}.txt`
  const content = `# ${result.title}\n风格：${result.style}\n\n${result.lyrics}`
  const resolved = path.resolve(SANDBOX_ROOT, 'lyrics', fname)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, content, 'utf-8')

  emitEvent('lyrics_created', { path: `lyrics/${fname}`, title: result.title })
  return `歌词已生成并保存至 lyrics/${fname}\n\n标题：${result.title}\n风格：${result.style}\n\n${result.lyrics}`
}

// generate_music：生成音乐
export async function execGenerateMusic({ prompt, lyrics, instrumental }) {
  if (!prompt) return '错误：未提供音乐描述'
  if (isDailyLimitReached('music')) return '错误：今日音乐生成配额已用完'

  const result = await callCapability('music', { prompt, lyrics, instrumental })

  const ts = nowTimestamp().replace(/[:.+]/g, '-').slice(0, 19)
  const fname = `music_${ts}.mp3`
  const resolved = path.resolve(SANDBOX_ROOT, 'music', fname)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, result.buffer)

  const relPath = `music/${fname}`
  emitEvent('music_created', { path: relPath, prompt: prompt.slice(0, 60) })
  console.log(`[music] 已生成: ${relPath}`)
  return `音乐已生成：${relPath}（时长约 ${result.duration ?? '?'} 秒）`
}

// generate_image：生成图片
export async function execGenerateImage({ prompt, aspect_ratio = '1:1', n = 1 }) {
  if (!prompt) return '错误：未提供图片描述'
  if (isDailyLimitReached('image')) return '错误：今日图片生成配额已用完（50 次/天）'
  const validRatios = new Set(['1:1', '16:9', '4:3', '3:4', '9:16'])
  const ratio = validRatios.has(aspect_ratio) ? aspect_ratio : '1:1'
  const count = Math.min(Math.max(Math.floor(n) || 1, 1), 4)

  const result = await callCapability('image', { prompt, aspect_ratio: ratio, n: count })

  emitEvent('image_created', { urls: result.urls, prompt: prompt.slice(0, 60) })
  console.log(`[image] 已生成 ${result.urls.length} 张图片`)
  return `图片已生成（${result.urls.length} 张）：\n${result.urls.join('\n')}`
}

export function execMediaMode(args = {}) {
  const mode = String(args.mode || args.kind || '').trim()
  const action = String(args.action || 'show').trim()
  if (!['video', 'camera', 'image', 'music'].includes(mode)) {
    return JSON.stringify({ ok: false, tool: 'media_mode', error: 'mode must be video, camera, image, or music' })
  }
  if (!['show', 'hide', 'close', 'play', 'pause', 'seek', 'set_volume', 'update'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'media_mode', error: 'unsupported action' })
  }

  const payload = {
    mode,
    action,
    url: typeof args.url === 'string' ? args.url : undefined,
    src: typeof args.src === 'string' ? args.src : undefined,
    title: typeof args.title === 'string' ? args.title : undefined,
    artist: typeof args.artist === 'string' ? args.artist : undefined,
    lrc: typeof args.lrc === 'string' ? args.lrc : undefined,
    cover: typeof args.cover === 'string' ? args.cover : undefined,
    alt: typeof args.alt === 'string' ? args.alt : undefined,
    autoplay: typeof args.autoplay === 'boolean' ? args.autoplay : (mode === 'music' ? true : undefined),
    muted: typeof args.muted === 'boolean' ? args.muted : undefined,
    camera: mode === 'camera' || args.camera === true,
  }

  if (Number.isFinite(Number(args.volume))) {
    payload.volume = Math.max(0, Math.min(1, Number(args.volume)))
  }
  if (Number.isFinite(Number(args.currentTime ?? args.time ?? args.seek))) {
    payload.currentTime = Math.max(0, Number(args.currentTime ?? args.time ?? args.seek))
  }

  emitEvent('media_mode', payload)
  emitEvent('action', { tool: 'media_mode', summary: `${mode}:${action}`, detail: payload.title || payload.url || '' })
  return JSON.stringify({ ok: true, tool: 'media_mode', ...payload })
}

// ─────────────────────────────────────────────────────────────────────────────
// AI 视频生成（Seedance 2.0 / 火山方舟 Ark）
//
// 异步任务式：创建任务 → 后台轮询 → 下载 mp4 到 sandbox → 推给前端面板自动播放。
// 设计要点：
//   1) 未配置 key → 返回结构化引导文案（不做硬拦截，由模型转述指引用户粘贴 key）。
//   2) 创建任务同步 await，失败立刻回传给模型（典型：model ID 不对 / 余额不足）。
//   3) 轮询在后台进行（不阻塞当前 turn），全程只 emit 面板事件，完成/失败都体现在面板上。
// ─────────────────────────────────────────────────────────────────────────────

const SEEDANCE_POLL_INTERVAL_MS = 5000
const SEEDANCE_MAX_POLL_MS = 8 * 60 * 1000   // 8 分钟兜底超时
const SEEDANCE_VIDEO_DIR = path.resolve(SANDBOX_ROOT, 'videos')

const SEEDANCE_VIDEO_KEEP = 20                          // sandbox/videos 只保留最近 N 条
const SEEDANCE_PENDING_FILE = path.join(paths.userDir, 'aivideo-pending.json')
const SEEDANCE_PENDING_TTL_MS = 48 * 60 * 60 * 1000     // 火山任务约 48h 内可查，过期不再恢复

function newVideoJobId() {
  return `vid_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

// 统一向前端面板广播 AI 视频生成状态
function emitAIVideo(action, payload = {}) {
  emitEvent('aivideo_mode', { action, ...payload })
}

// 视频生成进入终态后，给 agent 推一条 SYSTEM 通知，让它"知道"结果（成功/失败）。
// 走后台队列（background 优先级），不打断用户当前对话；agent 空闲时自然处理这条通知。
// 这是 emitAIVideo（只通知前端面板）之外的另一条通道——前者给眼睛，这条给 agent 的认知。
function notifyAgentVideoDone({ prompt = '', mode = 'text', ok = true, reason = '' } = {}) {
  const modeLabel = seedanceModeLabel(mode)
  const p = String(prompt || '').trim()
  const promptPart = p ? `，提示词：「${p}」` : ''
  const content = ok
    ? `[系统通知] 你之前提交的 AI 视频已经生成完成（${modeLabel}${promptPart}）。视频已自动在右侧面板播放。如果用户在等这个视频，简短地告诉他生成好了即可，不必复述提示词或描述画面。`
    : `[系统通知] 你之前提交的 AI 视频生成失败了（${modeLabel}${promptPart}）。原因：${reason || '未知'}。可以简短地把失败情况告诉用户，必要时建议换个提示词或稍后重试。`
  try { pushMessage('SYSTEM', content, 'SYSTEM', { queue: 'background' }) }
  catch (e) { console.warn(`[aivideo] 通知 agent 失败：${e.message}`) }
}

// ── AI 视频面板「感知」状态 ──
// 前端面板实时同步 { open, prompt } 到后端（POST /aivideo/draft）。注入器每轮把它贴进
// agent 上下文，让 agent 直接看到「面板开/关」「用户正在框里编辑的提示词草稿」。
// 这样用户说「帮我优化提示词」时，agent 无需追问内容，直接基于草稿改写。
let aivideoPanelState = { open: false, prompt: '', updatedAt: 0 }
export function setAIVideoPanelState({ open, prompt } = {}) {
  if (typeof open === 'boolean') aivideoPanelState.open = open
  if (typeof prompt === 'string') aivideoPanelState.prompt = prompt
  aivideoPanelState.updatedAt = Date.now()
}
export function getAIVideoPanelState() { return { ...aivideoPanelState } }

// ── 进行中任务持久化（断点续查）：app/后端重启后能恢复轮询，面板不会卡在“生成中” ──
function readPending() {
  try { const v = JSON.parse(fs.readFileSync(SEEDANCE_PENDING_FILE, 'utf-8')); return Array.isArray(v) ? v : [] }
  catch { return [] }
}
function writePending(list) {
  try {
    const tmp = SEEDANCE_PENDING_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf-8')
    fs.renameSync(tmp, SEEDANCE_PENDING_FILE)
  } catch {}
}
function addPending(entry) { writePending([...readPending().filter(e => e.taskId !== entry.taskId), entry]) }
function removePending(taskId) { writePending(readPending().filter(e => e.taskId !== taskId)) }

// 保留最近 N 条生成视频，删更旧的，防止 sandbox/videos 无限膨胀
function pruneVideoDir() {
  try {
    const files = fs.readdirSync(SEEDANCE_VIDEO_DIR)
      .filter(f => f.toLowerCase().endsWith('.mp4'))
      .map(f => ({ f, mt: fs.statSync(path.join(SEEDANCE_VIDEO_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mt - a.mt)
    for (const { f } of files.slice(SEEDANCE_VIDEO_KEEP)) {
      try { fs.rmSync(path.join(SEEDANCE_VIDEO_DIR, f), { force: true }) } catch {}
    }
  } catch {}
}

// 把 Ark 返回的 video_url 下载到 sandbox/videos，返回可直接播放的本地 HTTP 路径
async function downloadGeneratedVideo(videoUrl, jobId) {
  const res = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) })
  if (!res.ok) throw new Error(`下载生成视频失败：HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.mkdirSync(SEEDANCE_VIDEO_DIR, { recursive: true })
  const fname = `${jobId}.mp4`
  fs.writeFileSync(path.join(SEEDANCE_VIDEO_DIR, fname), buf)
  pruneVideoDir()
  return `/media/video/${encodeURIComponent(fname)}`
}

// 后台轮询任务直到终态，全程 emit 面板事件；不返回给模型
async function seedancePollLoop({ taskId, jobId, baseURL, apiKey, prompt = '', mode = 'text' }) {
  const deadline = Date.now() + SEEDANCE_MAX_POLL_MS
  const headers = { Authorization: `Bearer ${apiKey}` }
  try {
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, SEEDANCE_POLL_INTERVAL_MS))
      let data
      try {
        const res = await fetch(`${baseURL}/contents/generations/tasks/${taskId}`, {
          headers, signal: AbortSignal.timeout(20000),
        })
        data = await res.json()
        if (!res.ok) {
          const m = data?.error?.message || `HTTP ${res.status}`
          emitAIVideo('error', { jobId, message: `查询任务失败：${m}` })
          return
        }
      } catch (e) {
        // 单次网络抖动不算失败，继续轮询直到超时
        continue
      }

      const status = String(data.status || '').toLowerCase()
      if (status === 'succeeded') {
        const videoUrl = data?.content?.video_url
        if (!videoUrl) {
          emitAIVideo('error', { jobId, message: '生成完成但未返回视频地址' })
          return
        }
        try {
          const localUrl = await downloadGeneratedVideo(videoUrl, jobId)
          emitAIVideo('ready', { jobId, videoUrl: localUrl })
          emitEvent('action', { tool: 'generate_video', summary: 'AI 视频生成完成', detail: jobId })
        } catch (e) {
          // 下载失败时退而求其次：直接播远端 URL（临时链接，可能数小时后过期）
          emitAIVideo('ready', { jobId, videoUrl })
        }
        notifyAgentVideoDone({ prompt, mode, ok: true })
        return
      }
      if (status === 'failed' || status === 'cancelled' || status === 'expired') {
        const m = data?.error?.message || status
        emitAIVideo('error', { jobId, message: `生成失败：${m}` })
        notifyAgentVideoDone({ prompt, mode, ok: false, reason: m })
        return
      }
      // queued / running → 推进度
      emitAIVideo('progress', { jobId, status: status || 'running' })
    }
    emitAIVideo('error', { jobId, message: '生成超时（超过 8 分钟未完成）' })
    notifyAgentVideoDone({ prompt, mode, ok: false, reason: '生成超时（超过 8 分钟未完成）' })
  } finally {
    // 无论成功/失败/超时/异常，都从待恢复列表移除该任务
    removePending(taskId)
  }
}

const SEEDANCE_RATIOS = new Set(['adaptive', '16:9', '9:16', '4:3', '3:4', '1:1', '21:9'])
const SEEDANCE_RESOLUTIONS = new Set(['480p', '720p', '1080p'])
function seedanceModeLabel(mode) { return mode === 'flf' ? '首尾帧' : mode === 'image' ? '图生视频' : '文生视频' }
const SEEDANCE_NOT_CONFIGURED_GUIDE = 'AI 视频生成需要先配置火山方舟（Volcengine Ark）的 Seedance API Key。请引导用户：①登录火山方舟控制台开通 Seedance 2.0；②把 API Key 直接发给你即可自动配置，例如发送「火山视频 你的APIKey」；③如果账号用的是推理接入点或特定模型版本，可一并发模型ID/ep编号，例如「火山视频 你的APIKey 模型 ep-2024xxxx」。配置成功后再让用户重述生成需求。'

// generate_video：调用 Seedance 生成视频（文生视频 / 图+提示词生视频）
// action=open  → 只打开空白输入面板，用户在面板里自己填提示词/拖图片再点生成
// action=generate（默认）→ 直接提交生成
export async function execGenerateVideo(args = {}) {
  const action = String(args.action || 'generate').trim()
  const { apiKey, model, baseURL, configured } = getSeedanceConfig()

  // 只打开空白面板：无论是否已配置都打开（未配置时面板内会提示去配 key）。
  // 用户在面板里自助填写并点“生成”（前端直连 /aivideo/generate）。
  if (action === 'open') {
    emitAIVideo('open', { configured })
    emitEvent('action', { tool: 'generate_video', summary: '打开 AI 视频生成面板', detail: configured ? '' : '未配置 key' })
    return JSON.stringify({
      ok: true, tool: 'generate_video', action: 'open', configured,
      message: configured
        ? 'AI 视频生成面板已打开（空白输入态）。用户可以在面板里直接填写提示词、可选地拖入一张参考图，然后点“生成”。你不需要替用户编写提示词或自动开始生成，简短确认一句即可。'
        : 'AI 视频生成面板已打开，但尚未配置火山方舟（Seedance）key。请引导用户发送「火山视频 你的APIKey」完成配置；面板里也已经显示了同样的提示。',
    })
  }

  // 写回提示词到面板输入框：只在用户「明确表示采用」优化结果后才调用。
  // 默认（用户刚说"帮我优化"）不要调用它——先在对话里给出改写版让用户确认。
  if (action === 'set_prompt') {
    const p = String(args.prompt || args.text || '').trim()
    if (!p) return JSON.stringify({ ok: false, tool: 'generate_video', error: 'set_prompt 需要 prompt（要写入面板输入框的提示词）' })
    emitAIVideo('set_prompt', { prompt: p })
    setAIVideoPanelState({ prompt: p })
    emitEvent('action', { tool: 'generate_video', summary: '写入优化后的提示词到视频面板', detail: p.slice(0, 40) })
    return JSON.stringify({ ok: true, tool: 'generate_video', action: 'set_prompt', message: '已把这段提示词填入 AI 视频生成面板的输入框（覆盖原草稿）。提醒用户检查后自行点「生成」。' })
  }

  // 生成：未配置则返回引导（不硬拦截，交给模型/面板转述）
  if (!configured) {
    return JSON.stringify({ ok: false, tool: 'generate_video', error: 'not_configured', guide: SEEDANCE_NOT_CONFIGURED_GUIDE })
  }

  const prompt = String(args.prompt || args.text || '').trim()
  // 图片：支持 images:[url1, url2?]（2 张=首尾帧），或兼容单个 image_url
  let images = Array.isArray(args.images) ? args.images.map(s => String(s || '').trim()).filter(Boolean) : []
  if (!images.length) {
    const single = String(args.image_url || args.image || '').trim()
    if (single) images = [single]
  }
  images = images.slice(0, 2)
  if (!prompt && !images.length) {
    return JSON.stringify({ ok: false, tool: 'generate_video', error: '至少提供 prompt（文生视频）或图片（图生/首尾帧）；或用 action="open" 仅打开输入面板。' })
  }

  let ratio = SEEDANCE_RATIOS.has(args.ratio) ? args.ratio : '16:9'
  // adaptive=按参考图比例输出，仅图生/首尾帧有意义；文生视频无图可适配，回退 16:9
  if (ratio === 'adaptive' && !images.length) ratio = '16:9'
  const resolution = SEEDANCE_RESOLUTIONS.has(args.resolution) ? args.resolution : '720p'
  let duration = Number(args.duration)
  if (!Number.isFinite(duration)) duration = 5
  duration = Math.max(1, Math.min(15, Math.round(duration)))

  const content = []
  if (prompt) content.push({ type: 'text', text: prompt })
  if (images.length >= 2) {
    // 首尾帧：第一张=首帧，第二张=尾帧
    content.push({ type: 'image_url', image_url: { url: images[0] }, role: 'first_frame' })
    content.push({ type: 'image_url', image_url: { url: images[1] }, role: 'last_frame' })
  } else if (images.length === 1) {
    content.push({ type: 'image_url', image_url: { url: images[0] } })
  }

  const body = { model, content, ratio, resolution, duration }
  const mode = images.length >= 2 ? 'flf' : images.length === 1 ? 'image' : 'text'

  let createData
  try {
    const res = await fetch(`${baseURL}/contents/generations/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    createData = await res.json().catch(() => ({}))
    if (!res.ok) {
      const m = createData?.error?.message || `HTTP ${res.status}`
      return JSON.stringify({
        ok: false, tool: 'generate_video', error: `创建任务失败：${m}`,
        hint: '若提示模型不存在/无权限，多半是 model ID 不对：请让用户在火山方舟确认 Seedance 模型 ID 或推理接入点（ep-xxx），重新发送「火山视频 你的APIKey 模型 正确的模型ID」即可更新。',
      })
    }
  } catch (e) {
    return JSON.stringify({ ok: false, tool: 'generate_video', error: `创建任务异常：${e.message}` })
  }

  const taskId = createData.id || createData.task_id
  if (!taskId) {
    return JSON.stringify({ ok: false, tool: 'generate_video', error: '创建任务返回缺少任务 ID', raw: createData })
  }

  const jobId = newVideoJobId()
  const modeLabel = seedanceModeLabel(mode)
  // 在生成栏新增一个“生成中”瓦片
  emitAIVideo('show', {
    jobId, mode, prompt: prompt.slice(0, 120),
    ratio, resolution, duration, status: 'queued',
  })
  emitEvent('action', { tool: 'generate_video', summary: `提交 AI 视频生成（${modeLabel}）`, detail: prompt.slice(0, 60) })

  // 记入待恢复列表（不存 apiKey，恢复时用当前配置的 key）
  addPending({ taskId, jobId, mode, prompt: prompt.slice(0, 120), ratio, resolution, duration, baseURL, createdAt: Date.now() })

  // 后台轮询（不阻塞当前 turn）
  seedancePollLoop({ taskId, jobId, baseURL, apiKey, prompt: prompt.slice(0, 120), mode }).catch(err => {
    emitAIVideo('error', { jobId, message: `轮询异常：${err.message}` })
    removePending(taskId)
  })

  return JSON.stringify({
    ok: true, tool: 'generate_video', task_id: taskId, jobId, mode,
    message: `视频生成任务已提交（${modeLabel}），正在右侧面板生成中，完成后会自动播放，通常需要 1–5 分钟。无需反复查询，回复用户一句简短确认即可。`,
  })
}

// 用户点“下载”：把生成的视频从 sandbox 缓存复制到「下载\AI视频生成保存的视频\日期\」永久保存。
export function saveGeneratedVideo(jobId) {
  const safe = String(jobId || '').replace(/[^a-zA-Z0-9_\-]/g, '')
  if (!safe) return { ok: false, error: 'invalid jobId' }
  const src = path.join(SEEDANCE_VIDEO_DIR, `${safe}.mp4`)
  if (!fs.existsSync(src)) return { ok: false, error: '视频文件不存在（可能已被清理或尚未生成完成）' }
  const d = new Date()
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const dir = path.join(os.homedir(), 'Downloads', 'AI视频生成保存的视频', date)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const dst = path.join(dir, `${safe}.mp4`)
    fs.copyFileSync(src, dst)
    return { ok: true, path: dst }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// 启动时恢复上次未完成的生成任务：重新发 show 事件并继续轮询，
// 让重启前正在生成的视频仍能自动落盘 / 在面板播放（而不是永远卡“生成中”）。
// 由 index.js 在后端启动后调用一次。
export function resumePendingVideoJobs() {
  let list = readPending()
  if (!list.length) return
  // 丢弃过期（>48h，火山已不可查）的条目
  const fresh = list.filter(e => e && e.taskId && (Date.now() - (e.createdAt || 0) < SEEDANCE_PENDING_TTL_MS))
  if (fresh.length !== list.length) writePending(fresh)
  if (!fresh.length) return

  const { apiKey, baseURL, configured } = getSeedanceConfig()
  if (!configured) { writePending([]); return }  // 没 key 无法恢复，清空避免无限残留

  // 延迟几秒，等前端 SSE 连上后再发事件，避免恢复太快前端收不到
  setTimeout(() => {
    for (const e of fresh) {
      emitAIVideo('show', {
        jobId: e.jobId, mode: e.mode, prompt: e.prompt,
        ratio: e.ratio, resolution: e.resolution, duration: e.duration, status: 'running',
      })
      seedancePollLoop({ taskId: e.taskId, jobId: e.jobId, baseURL: e.baseURL || baseURL, apiKey, prompt: e.prompt, mode: e.mode })
        .catch(() => removePending(e.taskId))
    }
    console.log(`[aivideo] 已恢复 ${fresh.length} 个未完成的视频生成任务`)
  }, 4000)
}

const MUSIC_AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.opus'])

async function fetchLrcFromNet(title, artist) {
  const headers = { 'User-Agent': 'BaiLongma/1.0' }
  // 策略1：精确匹配（title + artist）
  try {
    const params = new URLSearchParams({ track_name: title })
    if (artist) params.set('artist_name', artist)
    const res = await fetch(`https://lrclib.net/api/get?${params}`, {
      signal: AbortSignal.timeout(8000), headers,
    })
    if (res.ok) {
      const data = await res.json()
      const lrc = data.syncedLyrics || data.plainLyrics || null
      if (lrc) return lrc
    }
  } catch {}
  // 策略2：仅 title 关键词搜索，取第一条结果
  try {
    const params = new URLSearchParams({ q: title })
    const res = await fetch(`https://lrclib.net/api/search?${params}`, {
      signal: AbortSignal.timeout(8000), headers,
    })
    if (res.ok) {
      const list = await res.json()
      if (Array.isArray(list) && list.length > 0) {
        const hit = list[0]
        return hit.syncedLyrics || hit.plainLyrics || null
      }
    }
  } catch {}
  return null
}

function decodeProcessOutput(chunks) {
  const buffer = Buffer.concat(chunks)
  if (buffer.length === 0) return ''

  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  if (!utf8.includes('\uFFFD') || !IS_WIN) return utf8

  try {
    return new TextDecoder('gb18030', { fatal: false }).decode(buffer)
  } catch {
    return utf8
  }
}

function runProcess(file, args = [], cwd) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    }
    if (!IS_WIN) {
      const parts = String(env.PATH || '').split(':').filter(Boolean)
      for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
        if (!parts.includes(dir)) parts.push(dir)
      }
      env.PATH = parts.join(':')
    }
    const child = spawn(file, args, {
      cwd: cwd || paths.musicDir,
      windowsHide: true,
      env,
    })
    const stdoutChunks = []
    const stderrChunks = []
    child.stdout?.on('data', d => { stdoutChunks.push(Buffer.from(d)) })
    child.stderr?.on('data', d => { stderrChunks.push(Buffer.from(d)) })
    child.on('close', code => resolve({
      code,
      stdout: decodeProcessOutput(stdoutChunks),
      stderr: decodeProcessOutput(stderrChunks),
    }))
    child.on('error', err => resolve({
      code: -1,
      stdout: decodeProcessOutput(stdoutChunks),
      stderr: err.message,
    }))
  })
}

const YTDLP_LOCAL = path.join(paths.musicDir, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp')
const YTDLP_URL = IS_WIN
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'

async function resolveYtDlp() {
  // 1. 系统 PATH 里有就直接用
  const sys = await runProcess('yt-dlp', ['--version'], paths.musicDir)
  if (sys.code === 0) return 'yt-dlp'

  // 2. music 目录里有本地副本就用它
  if (fs.existsSync(YTDLP_LOCAL)) {
    const local = await runProcess(YTDLP_LOCAL, ['--version'], paths.musicDir)
    if (local.code === 0) return YTDLP_LOCAL
  }

  // 3. 自动下载 yt-dlp 到 music 目录
  emitEvent('action', { tool: 'music', summary: 'yt-dlp 未安装，正在自动下载…', detail: YTDLP_URL })
  const res = await fetch(YTDLP_URL, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) return null
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(YTDLP_LOCAL, buf)
  fs.chmodSync(YTDLP_LOCAL, 0o755)
  return YTDLP_LOCAL
}

export async function execMusic(args = {}) {
  const action = String(args.action || 'list').trim()
  const musicDir = paths.musicDir

  // ── list ──────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const rows = listMusicLibrary(Number(args.limit) || 50)
    return JSON.stringify({ ok: true, count: rows.length, tracks: rows })
  }

  // ── search ────────────────────────────────────────────────────────────────
  if (action === 'search') {
    const q = String(args.query || '').trim()
    if (!q) return JSON.stringify({ ok: false, error: 'query required' })
    const rows = searchMusicLibrary(q, Number(args.limit) || 20)
    return JSON.stringify({ ok: true, count: rows.length, tracks: rows })
  }

  // ── scan ──────────────────────────────────────────────────────────────────
  if (action === 'scan') {
    const entries = fs.readdirSync(musicDir, { withFileTypes: true })
    const added = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!MUSIC_AUDIO_EXTS.has(ext)) continue
      const filePath = path.join(musicDir, entry.name)
      const baseName = path.basename(entry.name, ext)
      const track = upsertMusicTrack({ title: baseName, filePath })
      added.push({ id: track.id, title: track.title, file_path: track.file_path })
    }
    return JSON.stringify({ ok: true, scanned: added.length, tracks: added })
  }

  // ── add ───────────────────────────────────────────────────────────────────
  if (action === 'add') {
    const filePath = String(args.path || '').trim()
    if (!filePath) return JSON.stringify({ ok: false, error: 'path required' })
    if (!fs.existsSync(filePath)) return JSON.stringify({ ok: false, error: `file not found: ${filePath}` })
    const ext = path.extname(filePath).toLowerCase()
    if (!MUSIC_AUDIO_EXTS.has(ext)) return JSON.stringify({ ok: false, error: `unsupported format: ${ext}` })
    const baseName = path.basename(filePath, ext)
    const track = upsertMusicTrack({
      title: String(args.title || baseName),
      artist: String(args.artist || ''),
      album: String(args.album || ''),
      filePath,
    })
    return JSON.stringify({ ok: true, track })
  }

  // ── download ──────────────────────────────────────────────────────────────
  if (action === 'download') {
    const url = String(args.url || '').trim()
    if (!url) return JSON.stringify({ ok: false, error: 'url required' })

    // 自动解析 yt-dlp 路径（没有则自动下载）
    const ytdlp = await resolveYtDlp()
    if (!ytdlp) return JSON.stringify({ ok: false, error: 'yt-dlp 自动下载失败，请检查网络连接' })

    // Download: print final filepath after conversion
    const outTemplate = path.join(musicDir, '%(title)s.%(ext)s').replace(/\\/g, '/')
    const dlArgs = ['-x', '--audio-format', 'mp3', '--audio-quality', '192K', '--no-playlist', '--print', 'after_move:filepath', '-o', outTemplate]
    let result = await runProcess(ytdlp, [...dlArgs, url])

    // SSL 握手失败时降级：加 --no-check-certificates 重试一次
    if (result.code !== 0 && /ssl|EOF occurred in violation of protocol/i.test(result.stderr)) {
      result = await runProcess(ytdlp, [...dlArgs, '--no-check-certificates', url])
    }

    if (result.code !== 0) {
      return JSON.stringify({ ok: false, error: `yt-dlp failed: ${result.stderr.slice(0, 400)}` })
    }

    // Parse output filepath (last non-empty line)
    const lines = result.stdout.trim().split('\n').map(l => l.trim()).filter(Boolean)
    let filePath = lines[lines.length - 1] || ''

    // Fallback: scan for newest mp3 in musicDir
    if (!filePath || !fs.existsSync(filePath)) {
      const files = fs.readdirSync(musicDir)
        .filter(f => f.endsWith('.mp3'))
        .map(f => ({ f, mt: fs.statSync(path.join(musicDir, f)).mtimeMs }))
        .sort((a, b) => b.mt - a.mt)
      if (files.length) filePath = path.join(musicDir, files[0].f)
    }

    if (!filePath || !fs.existsSync(filePath)) {
      return JSON.stringify({ ok: false, error: 'Download completed but could not locate output file' })
    }

    const baseName = path.basename(filePath, '.mp3')
    const title  = String(args.title  || baseName)
    const artist = String(args.artist || '')

    // Auto-fetch lyrics
    let lrc = ''
    if (title) {
      lrc = await fetchLrcFromNet(title, artist) || ''
    }

    const track = upsertMusicTrack({ title, artist, album: String(args.album || ''), filePath, lrc, sourceUrl: url })
    return JSON.stringify({ ok: true, track, lrc_fetched: Boolean(lrc) })
  }

  // ── get_lyrics ────────────────────────────────────────────────────────────
  if (action === 'get_lyrics') {
    const id = Number(args.id)
    let title  = String(args.title  || '').trim()
    let artist = String(args.artist || '').trim()

    if (id) {
      const track = getMusicTrack(id)
      if (!track) return JSON.stringify({ ok: false, error: `track id=${id} not found` })
      if (!title)  title  = track.title
      if (!artist) artist = track.artist
    }
    if (!title) return JSON.stringify({ ok: false, error: 'title required' })

    const lrc = await fetchLrcFromNet(title, artist)
    if (!lrc) return JSON.stringify({ ok: true, id: id || null, title, artist, lrc: null, hint: 'lyrics not found on lrclib.net' })

    if (id) updateMusicLrc(id, lrc)
    return JSON.stringify({ ok: true, id: id || null, title, artist, lrc_length: lrc.length, lrc })
  }

  // ── delete ────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const id = Number(args.id)
    if (!id) return JSON.stringify({ ok: false, error: 'id required' })
    const track = getMusicTrack(id)
    if (!track) return JSON.stringify({ ok: false, error: `track id=${id} not found` })
    dbDeleteMusicTrack(id)
    return JSON.stringify({ ok: true, deleted: { id, title: track.title } })
  }

  return JSON.stringify({ ok: false, error: `unknown action: ${action}` })
}

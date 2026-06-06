// Windows: 把控制台代码页切到 UTF-8，避免中文 stdout 显示为乱码
if (process.platform === 'win32') {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore', windowsHide: true })
  } catch (_) {}
}

const { app, BrowserWindow, shell, dialog, Menu, ipcMain, Tray, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const net = require('net')
const http = require('http')
const { EventEmitter } = require('events')
const { pathToFileURL, fileURLToPath } = require('url')
const { autoUpdater } = require('electron-updater')

const IS_DEV = !app.isPackaged
const WINDOWS_APP_USER_MODEL_ID = 'com.xiaoyuanda.bailongma'
const USER_DIR = app.getPath('userData')
const CODE_ROOT = app.getAppPath()
const RESOURCE_ROOT = CODE_ROOT
const BACKEND_ENTRY = path.join(CODE_ROOT, 'src', 'index.js')
const APP_ICON = path.join(RESOURCE_ROOT, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png')

// 持久化日志：把 console.* 镜像到 USER_DIR/logs/bailongma.log，
// 安装版没有 stdout 的情况下，卡死/崩溃后还能 tail 这个文件复盘。
// 简易 rotate：> 5MB 时把当前文件改名 .old（覆盖上一份 .old），下次写入重开。
const LOG_DIR = path.join(USER_DIR, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'bailongma.log')
const LOG_FILE_OLD = path.join(LOG_DIR, 'bailongma.old.log')
const LOG_MAX_BYTES = 5 * 1024 * 1024
try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch {}
function rotateLogIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE)
    if (stat.size > LOG_MAX_BYTES) {
      try { fs.rmSync(LOG_FILE_OLD, { force: true }) } catch {}
      try { fs.renameSync(LOG_FILE, LOG_FILE_OLD) } catch {}
    }
  } catch {}
}
function writeLog(level, args) {
  let line
  try {
    line = args.map(a => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.stack || a.message
      try { return JSON.stringify(a) } catch { return String(a) }
    }).join(' ')
  } catch { line = '[log-serialize-failed]' }
  const ts = new Date().toISOString()
  const out = `${ts} [${level}] ${line}\n`
  try { fs.appendFileSync(LOG_FILE, out) } catch {}
}
// Hijack 一次就够；后端 import 在同一进程，console.* 引用的是同一个 console 对象。
// 把原始方法存起来，appendFile 失败时仍能输出到 stdout/stderr（开发模式可见）。
;(function installLogHijack() {
  const levels = ['log', 'info', 'warn', 'error', 'debug']
  for (const level of levels) {
    const original = console[level]?.bind(console) || (() => {})
    console[level] = (...args) => {
      try { original(...args) } catch {}
      try {
        rotateLogIfNeeded()
        writeLog(level, args)
      } catch {}
    }
  }
})()
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? (reason.stack || reason.message) : String(reason))
})
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err?.message || String(err))
})
console.log(`[main] Bailongma ${app.getVersion()} starting, logs → ${LOG_FILE}`)

let mainWindow = null
let backendPort = 0
let tray = null
let focusBannerWindow = null
let backendHandle = null
let shuttingDown = false

// 后端通过 global.focusBannerBridge 控制横幅窗口
const focusBannerBridge = new EventEmitter()
global.focusBannerBridge = focusBannerBridge
global.bailongmaAppControl = {
  async restart() {
    console.log('[main] restart requested')
    await shutdownApp('restart', { relaunch: true })
  },
}

async function shutdownApp(reason = 'quit', { relaunch = false, exit = true } = {}) {
  if (shuttingDown) return
  shuttingDown = true
  app.isQuiting = true
  console.log(`[main] shutdown requested: ${reason}`)
  try {
    await Promise.race([
      backendHandle?.shutdownBackend?.(reason),
      new Promise(resolve => setTimeout(resolve, 3500)),
    ])
  } catch (err) {
    console.warn('[main] backend shutdown failed:', err.message)
  }
  try { focusBannerWindow?.close?.() } catch {}
  try { mainWindow?.close?.() } catch {}
  try { tray?.destroy?.() } catch {}
  tray = null
  if (relaunch) app.relaunch()
  if (exit) app.exit(0)
}

if (process.platform === 'win32') {
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)
}

function sendUpdaterStatus(payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('updater:status', {
    currentVersion: app.getVersion(),
    ...payload,
  })
}

function isTrustedLocalAppUrl(rawUrl = '') {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol === 'file:') {
      return path.normalize(fileURLToPath(parsed)) === path.normalize(path.join(RESOURCE_ROOT, 'focus-banner.html'))
    }
    return ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
      && Number(parsed.port) === Number(backendPort)
  } catch {
    return false
  }
}

function installMediaPermissionHandler(session) {
  session.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    if (permission !== 'media') return callback(false)
    const url = details.requestingUrl || webContents.getURL()
    callback(isTrustedLocalAppUrl(url))
  })
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (permission !== 'media') return false
    return isTrustedLocalAppUrl(requestingOrigin || webContents.getURL())
  })
}

function setupApplicationMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: 'Quit Bailongma',
          accelerator: 'Command+Q',
          click: () => {
            shutdownApp('menu quit').catch(() => app.exit(0))
          },
        },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function bootstrapBackend(port) {
  process.env.BAILONGMA_USER_DIR ||= USER_DIR
  process.env.BAILONGMA_RESOURCES_DIR ||= RESOURCE_ROOT
  process.env.BAILONGMA_PORT = String(port)
  backendHandle = await import(pathToFileURL(BACKEND_ENTRY).href)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

async function findFreePort(preferred = 3721) {
  for (const port of [preferred, 0]) {
    try {
      const actual = await new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          const address = server.address()
          server.close(() => resolve(address.port))
        })
      })
      return actual
    } catch {}
  }
  throw new Error('Unable to find a free local port')
}

function waitForBackend(port, timeoutMs = 30000) {
  const startedAt = Date.now()
  const url = `http://127.0.0.1:${port}/activation-status`

  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('Backend startup timed out'))
        return
      }

      const req = http.get(url, res => {
        res.resume()
        resolve()
      })
      req.on('error', () => setTimeout(tick, 300))
      req.setTimeout(1500, () => {
        req.destroy()
        setTimeout(tick, 300)
      })
    }

    tick()
  })
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0b0e',
    title: 'Bailongma',
    icon: APP_ICON,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  installMediaPermissionHandler(mainWindow.webContents.session)

  // 窗口级快捷键（不用 globalShortcut，避免劫持其他应用的 F11/Ctrl+R 等）
  //   F12      → 切换 DevTools
  //   F11      → 切换全屏
  //   Ctrl+R   → reload（仅 dev）
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools()
      event.preventDefault()
      return
    }
    if (input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen())
      event.preventDefault()
      return
    }
    if (IS_DEV && (input.control || input.meta) && input.key.toLowerCase() === 'r') {
      mainWindow.webContents.reload()
      event.preventDefault()
      return
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  await mainWindow.loadURL(`http://127.0.0.1:${backendPort}/`)
  // Windows/Linux 关闭主窗口时最小化到托盘；macOS 关闭红灯则销毁窗口，
  // Dock/Menu Bar 再次激活时重建，避免隐藏窗口残留黑屏。
  mainWindow.on('close', (e) => {
    if (!app.isQuiting && process.platform !== 'darwin') {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function setupTray() {
  const trayImage = nativeImage.createFromPath(APP_ICON)
  if (process.platform === 'darwin') trayImage.setTemplateImage(true)
  tray = new Tray(trayImage)
  tray.setToolTip('Bailongma')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主界面',
      click: () => { showMainWindow().catch(() => {}) },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        shutdownApp('tray quit').catch(() => app.exit(0))
      },
    },
  ])

  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => { showMainWindow().catch(() => {}) })
  if (process.platform === 'darwin') tray.on('click', () => { showMainWindow().catch(() => {}) })
}

async function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    await createWindow()
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function createFocusBannerWindow({ task = '', current_step = '', tasks = [] } = {}) {
  if (focusBannerWindow && !focusBannerWindow.isDestroyed()) {
    focusBannerWindow.webContents.send('focus-banner:update', { task, current_step, tasks })
    return
  }

  const { width: screenW } = require('electron').screen.getPrimaryDisplay().workAreaSize

  focusBannerWindow = new BrowserWindow({
    width: 280,
    height: 60,
    x: Math.round(screenW / 2 - 140),
    y: 48,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    focusable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'focus-banner-preload.cjs'),
    },
  })

  installMediaPermissionHandler(focusBannerWindow.webContents.session)

  focusBannerWindow.loadURL(`http://127.0.0.1:${backendPort}/focus-banner.html`)

  focusBannerWindow.webContents.once('did-finish-load', () => {
    if (!focusBannerWindow || focusBannerWindow.isDestroyed()) return
    // 先发端口配置，让语音识别结果能发回后端
    focusBannerWindow.webContents.send('focus-banner:config', { port: backendPort })
    focusBannerWindow.webContents.send('focus-banner:update', { task, current_step, tasks })
    autoResizeBannerWindow()
  })

  focusBannerWindow.on('closed', () => {
    focusBannerWindow = null
  })
}

function autoResizeBannerWindow() {
  if (!focusBannerWindow || focusBannerWindow.isDestroyed()) return
  focusBannerWindow.webContents.executeJavaScript(`
    (() => {
      const b = document.getElementById('banner')
      return b ? { w: b.offsetWidth, h: b.offsetHeight } : null
    })()
  `).then(size => {
    if (!size || !focusBannerWindow || focusBannerWindow.isDestroyed()) return
    const padW = 0
    const padH = 0
    focusBannerWindow.setSize(Math.max(160, size.w + padW), Math.max(40, size.h + padH))
  }).catch(() => {})
}

// Focus Banner IPC handlers
ipcMain.on('focus-banner:close', () => {
  if (focusBannerWindow && !focusBannerWindow.isDestroyed()) {
    focusBannerWindow.close()
    focusBannerWindow = null
  }
})

ipcMain.on('focus-banner:set-expanded', (_e, { expanded }) => {
  if (!focusBannerWindow || focusBannerWindow.isDestroyed()) return
  setTimeout(() => autoResizeBannerWindow(), 50)
})

ipcMain.on('focus-banner:request-resize', () => {
  setTimeout(() => autoResizeBannerWindow(), 30)
})

ipcMain.on('focus-banner:toggle-task', (_e, { idx, done }) => {
  // 任务勾选状态更改，横幅已在前端自行更新，无需额外操作
})

// 后端 bridge 事件监听
focusBannerBridge.on('command', ({ action, task, current_step, tasks }) => {
  if (action === 'show' || action === 'update') {
    createFocusBannerWindow({ task, current_step, tasks })
  }
})

focusBannerBridge.on('hide', () => {
  if (focusBannerWindow && !focusBannerWindow.isDestroyed()) {
    focusBannerWindow.close()
    focusBannerWindow = null
  }
})

function setupAutoUpdater() {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    sendUpdaterStatus({ stage: 'checking' })
  })

  autoUpdater.on('update-available', info => {
    console.log('[updater] update available', info?.version)
    sendUpdaterStatus({ stage: 'available', version: info?.version })
  })

  autoUpdater.on('download-progress', progress => {
    sendUpdaterStatus({
      stage: 'downloading',
      percent: Number(progress?.percent || 0),
      transferred: progress?.transferred || 0,
      total: progress?.total || 0,
    })
  })

  autoUpdater.on('update-downloaded', info => {
    console.log('[updater] update downloaded', info?.version)
    sendUpdaterStatus({ stage: 'downloaded', version: info?.version })
  })

  autoUpdater.on('update-not-available', info => {
    sendUpdaterStatus({
      stage: 'up-to-date',
      version: info?.version || app.getVersion(),
    })
  })

  autoUpdater.on('error', err => {
    const message = err?.message || String(err || 'Update failed')
    console.warn('[updater] update failed', message)
    sendUpdaterStatus({ stage: 'error', message })
  })

  if (!IS_DEV) {
    autoUpdater.checkForUpdates().catch(() => {})
  }
}

ipcMain.handle('app:get-version', () => app.getVersion())

ipcMain.handle('updater:check-for-updates', async () => {
  if (IS_DEV) {
    sendUpdaterStatus({ stage: 'dev' })
    return { ok: false, skipped: true, reason: 'dev' }
  }
  try {
    sendUpdaterStatus({ stage: 'checking' })
    const result = await autoUpdater.checkForUpdates()
    return { ok: true, updateInfo: result?.updateInfo || null }
  } catch (error) {
    const message = error?.message || String(error || 'Update check failed')
    sendUpdaterStatus({ stage: 'error', message })
    return { ok: false, message }
  }
})

ipcMain.handle('updater:start-download', async () => {
  try {
    await autoUpdater.downloadUpdate()
    return { ok: true }
  } catch (error) {
    const message = error?.message || String(error || 'Download failed')
    sendUpdaterStatus({ stage: 'error', message })
    return { ok: false, message }
  }
})

ipcMain.handle('updater:quit-and-install', async () => {
  await shutdownApp('quit and install', { exit: false })
  autoUpdater.quitAndInstall()
})

app.on('second-instance', () => {
  if (!backendPort) return
  showMainWindow().catch(() => {})
})

app.on('activate', () => {
  if (!backendPort) return
  showMainWindow().catch(() => {})
})

app.on('before-quit', (event) => {
  if (app.isQuiting) return
  event.preventDefault()
  app.isQuiting = true
  shutdownApp('before-quit').catch(() => app.exit(0))
})

app.on('window-all-closed', () => {
  // 主窗口关闭后保持后台运行（Focus Banner 等桌面功能继续工作）
  // 只有托盘菜单「退出」才真正退出
})

app.whenReady().then(async () => {
  setupApplicationMenu()

  try {
    backendPort = await findFreePort(3721)
    await bootstrapBackend(backendPort)
    await waitForBackend(backendPort)
  } catch (err) {
    dialog.showErrorBox('Startup failed', `Unable to start the Bailongma backend:\n${err.message}`)
    app.quit()
    return
  }

  await createWindow()
  setupTray()
  setupAutoUpdater()
  // 不再注册任何系统级 globalShortcut；F11 / F12 / Ctrl+R 已由 mainWindow
  // 的 before-input-event 处理（见 createWindow），只在窗口获焦时生效，
  // 不会劫持浏览器/IDE 等其他应用的同键操作。
})

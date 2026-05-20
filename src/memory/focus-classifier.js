// Focus event 分类器 —— 动态上下文记忆池架构第 5b 步（v1 LLM 语义判断）
//
// 角色：v0 启发式（ngram + 字面交集）跑在前面，本模块只在「栈结构会变化」时被叫起来
// （pushed / returned），用 LLM 仲裁校验 + 重写 topic 关键词。
//
// 设计要点：
//   - 800ms 硬超时（参考 injector.js embedding 兜底），LLM 慢一拍就回退 v0
//   - 失败必须降级 —— 解析失败、超时、abort、配额限流，都返回 null 让上层用 v0
//   - 不依赖 SQLite / 上游状态 / 当前 process —— 纯函数，可单元测试（callLLM 可 stub）
//   - 不修改 state，不发事件，不写 db；返回值由上层 focus.js 应用
//
// 来自 DynamicMemoryPool.md 7.4「对话动作类型」：
//   kept / pushed / returned / leaf 是对话级动作；本模块按这四类输出 action。
//   leaf = 一次性短问，不动栈；映射到 v0 的 noop（不创建新帧也不深化栈顶）。

const CLASSIFIER_TIMEOUT_MS = 800
const CLASSIFIER_MAX_TOKENS = 120
const CLASSIFIER_TEMPERATURE = 0.2

const SYSTEM_PROMPT = `你是对话焦点分类器。判断这条新消息相对当前栈的关系：
- kept     ：跟栈顶主题深化（同主题细化、追问、补充）
- pushed   ：开新认知线程，跟栈中所有帧都不同
- returned ：回到栈中某个旧帧的主题（说明 returns_to_depth 是栈中索引，栈顶=length-1）
- leaf     ：一次性短问，不动栈
另外把 topic 重写成 2-3 个真正反映主题的词。不要 ngram，要语义关键词。
只输出 JSON，不要解释。`

// 把当前栈渲染成简短字符串：[栈底"a, b" → "c, d" → 栈顶"e, f"]
function describeStack(stack) {
  if (!Array.isArray(stack) || stack.length === 0) return '[空栈]'
  const parts = stack.map((f, i) => {
    const topic = Array.isArray(f?.topic) ? f.topic.join(', ') : String(f?.topic || '')
    const conclusions = Array.isArray(f?.conclusions) && f.conclusions.length > 0
      ? `（结论: ${f.conclusions[f.conclusions.length - 1]}）`
      : ''
    const tag = i === 0 ? '栈底' : (i === stack.length - 1 ? '栈顶' : `第${i}层`)
    return `${tag}"${topic}"${conclusions}`
  })
  return '[' + parts.join(' → ') + ']'
}

// 构造用户输入文本
function buildUserPrompt({ newMessage, v0Event, v0Topic, currentStack }) {
  const v0TopicStr = Array.isArray(v0Topic) ? v0Topic.join(', ') : String(v0Topic || '')
  const stackStr = describeStack(currentStack)
  const lengthHint = currentStack?.length ? `栈深=${currentStack.length}，栈顶索引=${currentStack.length - 1}` : '栈深=0'
  // newMessage 截断到 400 字，省 token 也减少打架风险
  const msg = String(newMessage || '').slice(0, 400)
  return [
    `v0 判定 = ${v0Event}，候选 topic = [${v0TopicStr}]`,
    `当前栈（${lengthHint}） = ${stackStr}`,
    `新消息 = "${msg}"`,
    '',
    '请输出 JSON：{"action": "kept|pushed|returned|leaf", "topic_refined": ["词1","词2","词3"], "returns_to_depth": 0}',
    '（returns_to_depth 仅 returned 时有值；其他动作填 -1 或省略）',
  ].join('\n')
}

// 提取 LLM 文本中的 JSON 对象。容忍 ```json 包裹、前后多余文字。
function parseClassifierJson(text) {
  if (!text || typeof text !== 'string') return null
  // 去掉 <think> 块（如果模型把思考也输出了）
  let body = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  // 去掉 ```json ... ``` 围栏
  const fenceMatch = body.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) body = fenceMatch[1].trim()
  // 找第一个 { 到最后一个 }
  const first = body.indexOf('{')
  const last = body.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  const jsonStr = body.slice(first, last + 1)
  try {
    return JSON.parse(jsonStr)
  } catch {
    return null
  }
}

// 校验 + 规范化 LLM 返回的 JSON
function normalizeClassifierResult(raw, currentStack) {
  if (!raw || typeof raw !== 'object') return null
  const action = String(raw.action || '').toLowerCase().trim()
  if (!['kept', 'pushed', 'returned', 'leaf'].includes(action)) return null

  let topic = []
  if (Array.isArray(raw.topic_refined)) {
    topic = raw.topic_refined
      .map(t => String(t || '').trim())
      .filter(t => t.length > 0 && t.length <= 32)
      .slice(0, 3)
  }

  let returnsToDepth = -1
  if (action === 'returned') {
    const d = Number.isInteger(raw.returns_to_depth) ? raw.returns_to_depth : -1
    const stackLen = Array.isArray(currentStack) ? currentStack.length : 0
    if (d < 0 || d >= stackLen) {
      // returned 但深度非法 → 视为不合理，拒掉
      return null
    }
    returnsToDepth = d
  }

  return { action, topic, returnsToDepth }
}

/**
 * 调 LLM 仲裁 focus 事件。
 *
 * @param {object} args
 * @param {string} args.newMessage   - 当前用户消息正文
 * @param {string} args.v0Event      - v0 启发式判定的 event（pushed / returned）
 * @param {string[]} args.v0Topic    - v0 抽出的候选 topic 关键词
 * @param {object[]} args.currentStack - 当前 focus 栈快照（不会被修改）
 * @param {AbortSignal} [args.signal] - 上层 abort 信号
 * @returns {Promise<{action:'kept'|'pushed'|'returned'|'leaf', topic:string[], returnsToDepth:number} | null>}
 *   返回 null 表示「失败 / 超时 / 解析不出来」，让上层回退到 v0。
 */
export async function classifyFocusEvent({
  newMessage,
  v0Event,
  v0Topic,
  currentStack,
  signal,
} = {}) {
  // 边界保护
  if (!newMessage || typeof newMessage !== 'string') return null
  if (signal?.aborted) return null

  // 动态 import callLLM —— 跟 injector.js 同款，避免在测试环境/早期模块加载时拉起一切
  let callLLM
  try {
    const llm = await import('../llm.js')
    callLLM = llm.callLLM
  } catch {
    return null
  }
  if (typeof callLLM !== 'function') return null

  const userPrompt = buildUserPrompt({ newMessage, v0Event, v0Topic, currentStack })

  // 800ms 硬超时 + LLM 调用赛跑
  let timeoutHandle = null
  const timeoutPromise = new Promise(resolve => {
    timeoutHandle = setTimeout(() => resolve({ __timeout: true }), CLASSIFIER_TIMEOUT_MS)
  })

  let result
  try {
    result = await Promise.race([
      callLLM({
        systemPrompt: SYSTEM_PROMPT,
        message: userPrompt,
        temperature: CLASSIFIER_TEMPERATURE,
        thinking: false,
        tools: [],
        maxTokens: CLASSIFIER_MAX_TOKENS,
        mustReply: false,
        signal,
      }),
      timeoutPromise,
    ])
  } catch {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    return null
  }
  if (timeoutHandle) clearTimeout(timeoutHandle)

  if (!result || result.__timeout) return null
  if (result.aborted) return null

  const content = typeof result === 'string' ? result : (result.content || '')
  const raw = parseClassifierJson(content)
  if (!raw) return null

  return normalizeClassifierResult(raw, currentStack)
}

// 暴露内部辅助函数，便于测试
export const __internal = {
  describeStack,
  buildUserPrompt,
  parseClassifierJson,
  normalizeClassifierResult,
  SYSTEM_PROMPT,
  CLASSIFIER_TIMEOUT_MS,
}

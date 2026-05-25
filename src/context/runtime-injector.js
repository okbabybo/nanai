import { gatherContext, formatExtraContext } from './gatherer.js'
import { buildKeywordRuntimeContext } from './keyword-context.js'
import { buildHotspotRuntimeContext, buildHotspotPanelStateContext } from '../hotspots.js'
import { buildPersonCardRuntimeContext, buildPersonCardPanelStateContext } from '../person-cards.js'
import { buildWeatherRuntimeContext, getWeatherCardProps } from '../weather.js'
import { buildDocRuntimeContext, buildDocPanelStateContext, detectDocTopic } from '../docs.js'

export async function runRuntimeInjector({
  message = '',
  task = null,
  taskKnowledge = '',
  memories = '',
  fastUserPath = false,
  signal = null,
} = {}) {
  const text = String(message || '')

  const keywordContextText = await buildKeywordRuntimeContext(text)
  const hotspotStateText = buildHotspotPanelStateContext()
  const hotspotContextText = buildHotspotRuntimeContext(text)
  const personCardStateText = buildPersonCardPanelStateContext()
  const personCardContextText = buildPersonCardRuntimeContext(text)
  const weatherContextText = await buildWeatherRuntimeContext(text)
  const weatherCardProps = weatherContextText ? await getWeatherCardProps(text) : null
  const detectedDocTopic = detectDocTopic(text)
  const docStateText = buildDocPanelStateContext(detectedDocTopic)
  const docContextText = buildDocRuntimeContext(text)

  let taskExtraContextText = ''
  let taskExtraContextItems = []
  if (task && !fastUserPath) {
    taskExtraContextItems = await gatherContext({
      task,
      taskKnowledge,
      memories,
      message: text,
      signal,
    })
    taskExtraContextText = formatExtraContext(taskExtraContextItems)
  }

  const contextParts = [
    keywordContextText,
    hotspotStateText,
    hotspotContextText,
    personCardStateText,
    personCardContextText,
    weatherContextText,
    docStateText,
    docContextText,
    taskExtraContextText,
  ].filter(Boolean)

  return {
    keywordContextText,
    hotspotStateText,
    hotspotContextText,
    personCardStateText,
    personCardContextText,
    weatherContextText,
    weatherCardProps,
    detectedDocTopic,
    docStateText,
    docContextText,
    taskExtraContextText,
    taskExtraContextItems,
    contextText: contextParts.join('\n\n'),
  }
}

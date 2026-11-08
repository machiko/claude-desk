// 外部驗收（dispatch.json 的 review.agent）：派給外部 Agent 的一般驗收怎麼算結束、結論怎麼讀回卡片。純函式；I/O 在 dispatch-runner、run-notes 與 auto-chain。
import type { ReviewVerdict } from '../types'
import type { AgentBeacon } from './agents'
import type { ExternalEnd } from './dispatch'
import { MEDIUM_ASK_FORM, parseExternalVerdict } from './prompts/review'
import { mediumDecideLines } from './extras'
import { saysNone, withHistory } from './card'

/** 執行器名稱（信標的 agent、動態與關卡寫的名字）：review.agent 的第一個字去掉路徑，例如 `/opt/bin/agy --fast` → `agy`。 */
export function runnerOf(agent: string): string {
  const first = agent.trim().split(/\s+/)[0] ?? ''
  return first.split('/').filter(Boolean).pop() ?? first
}

/**
 * 信標說的外部驗收結束方式：只認這次派工之後寫的信標（startedAt 不早於派工時間）；blocked 是回報失敗，done／idle 是完成。
 * 信標還是 working、或還不是這次寫的，回 null（還在跑，或行程已經不在、要另外看 pid，見 probes 的 externalEnd）。
 */
export function externalEndOf(beacon: AgentBeacon | null, startedAt: number): ExternalEnd | null {
  const own = beacon && (beacon.startedAt ?? 0) >= startedAt ? beacon : null
  if (!own || own.state === 'working') return null
  return own.state === 'blocked' ? 'blocked' : 'done'
}

export const EXTERNAL_BLOCKED = '外部 Agent 回報失敗'
export const EXTERNAL_GONE = '外部 Agent 已結束卻沒回報完成'
export const EXTERNAL_STALE = '審查檔沒有在派工後更新'
export const EXTERNAL_UNREADABLE = '審查檔第一行讀不到四個數字'

/** 外部驗收沒有結果時，動態與提示的那句（原因是上面幾個常數之一）。 */
export const externalFallbackText = (why: string) => `外部驗收沒有結果（${why}），改派 Claude 驗收`

export type ExternalOutcome = { verdict: ReviewVerdict } | { why: string }

/**
 * 外部驗收的結論：信標回報失敗或行程不見算沒有結果；審查檔要在派工之後改過（修改時間不早於派工時間），第一行要讀得出四個數字。
 * `mtime`：審查檔的修改時間，讀不到是 undefined。
 */
export function externalOutcome(end: ExternalEnd, text: string | null, mtime: number | undefined, startedAt: number): ExternalOutcome {
  if (end === 'blocked') return { why: EXTERNAL_BLOCKED }
  if (end === 'gone') return { why: EXTERNAL_GONE }
  if (text === null || mtime === undefined || mtime < startedAt) return { why: EXTERNAL_STALE }
  const verdict = parseExternalVerdict(text)
  return verdict ? { verdict } : { why: EXTERNAL_UNREADABLE }
}

/** 寫回卡片的關卡：跟 Claude 驗收同一個格式，結論那句寫是哪個外部 Agent 驗的。 */
export const externalGate = (v: ReviewVerdict, agent: string) =>
  `review：CRITICAL ${v.critical}、HIGH ${v.high}、MEDIUM ${v.medium}、LOW ${v.low}；外部驗收（${agent}）`

/** 摘要最多列幾條、每條最多幾個字。 */
const SUMMARY_ITEMS = 3
const SUMMARY_CHARS = 16

/** 一條 MEDIUM 的說明：去掉開頭的「- [MEDIUM][類別] 檔案:行 —」與結尾的註記括號；括號字元拿掉（題目本身已在括號裡）。 */
function mediumGist(line: string): string {
  const body = line.replace(/^\s*[-*]\s*(?:\[[^\]]*\])+\s*/, '').replace(/[（(][^（）()]*等你決定[）)][。.]?\s*$/, '')
  const said = body.includes('—') ? body.slice(body.indexOf('—') + 1) : body
  const plainText = said.replace(/[（）()；]/g, '').trim()
  return [...plainText].length > SUMMARY_CHARS ? `${[...plainText].slice(0, SUMMARY_CHARS).join('')}…` : plainText
}

/**
 * 外部驗收的 MEDIUM 題：跟 Claude 驗收寫進「等你」的同一種（MEDIUM_ASK_FORM）；條數與摘要照審查檔標「（等你決定）」的那幾條。
 * 沒有要決定的 MEDIUM 回空字串。
 */
export function mediumAskOf(text: string | null): string {
  const lines = mediumDecideLines(text)
  if (!lines.length) return ''
  const gists = lines.slice(0, SUMMARY_ITEMS).map(mediumGist).filter(Boolean)
  const summary = `${gists.join('、')}${lines.length > SUMMARY_ITEMS ? ' 等' : ''}` || '見審查檔'
  return MEDIUM_ASK_FORM.replace('MEDIUM n 條（摘要）', `MEDIUM ${lines.length} 條（${summary}）`)
}

/** 卡片「等你」加上 MEDIUM 題：原本是「無」就換成這題；已有一題審查 MEDIUM 就換掉那題；有別的題目就接在後面。 */
export function askWithMedium(ask: string, question: string): string {
  if (saysNone(ask)) return question
  const old = /審查 MEDIUM \d+ 條[\s\S]*?D\) 改規格/
  return old.test(ask) ? ask.replace(old, () => question) : `${ask}；${question}`
}

/**
 * 把外部驗收的結論寫進卡片：DESK（或舊的 CARD）區塊的關卡換成 gate；ask 不是 null 就換掉「等你」（舊卡叫「等使用者」）；History 加一筆。
 * 認不到卡片區塊回 null（不寫）。
 */
export function withExternalResult(text: string, gate: string, ask: string | null, entry: string): string | null {
  const m = text.match(/<!-- (DESK|CARD)\b[^>]*-->\n([\s\S]*?)<!-- \/\1 -->/)
  if (!m || m.index === undefined || !/^- 關卡：/m.test(m[2]!)) return null
  let body = m[2]!.replace(/^- 關卡：.*$/m, () => `- 關卡：${gate}`)
  if (ask !== null) body = body.replace(/^- (等你|等使用者)：.*$/m, (_l, label: string) => `- ${label}：${ask}`)
  const start = m.index + m[0].indexOf(m[2]!)
  return withHistory(text.slice(0, start) + body + text.slice(start + m[2]!.length), entry)
}

/** 處理過的外部信標改寫成 idle：回報失敗（blocked）的信標留著，面板會一直當成外部 Agent 在等你。 */
export const idleBeacon = (agent: string, now: number) => `${JSON.stringify({ state: 'idle', agent, updatedAt: now }, null, 2)}\n`

// 卡片與登錄表的解析：純函式，不碰磁碟。
// DESK 卡只有五個欄位：狀態、檢查、等你、下一步、關卡；舊版 CARD 的「等使用者」一併接受。
import type { Decision, Gate } from '../types'

export type RegistryRow = { name: string; statusPath: string; manual?: boolean }

const lf = (text: string) => text.replace(/\r\n?/g, '\n')

/** `~` 開頭換成家目錄，反斜線換成斜線。 */
export const expandHome = (path: string, home: string) => path.replace(/^~(?=\/|$)/, home).replace(/\\/g, '/')

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim().replace(/`/g, ''))

/** 登錄表：任何一列 `| 案名 | \`路徑\` |` 都算；標題列有 Executor 欄時，該欄寫 manual 的案子不派工。 */
export function parseRegistry(text: string, home: string): RegistryRow[] {
  const rows: RegistryRow[] = []
  let executorCol = -1
  for (const line of lf(text).split('\n')) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*`([^`]+)`/)
    if (!m) {
      if (/^\s*\|/.test(line) && !/^\s*\|[\s|:-]*$/.test(line)) { const i = cells(line).findIndex(c => /^executor$/i.test(c)); if (i >= 0) executorCol = i }
      continue
    }
    const manual = executorCol >= 0 && /^manual$/i.test(cells(line)[executorCol] ?? '')
    rows.push({ name: m[1]!, statusPath: expandHome(m[2]!.trim(), home), ...(manual ? { manual: true } : {}) })
  }
  return rows
}

const FIELD_ALIAS: Record<string, string> = { 等使用者: '等你', 檢查: '驗證' }

/** 卡片區塊：`<!-- DESK -->`（或舊的 `<!-- CARD -->`）到結尾標記之間的 `- 欄：值` 行。 */
export function parseCard(text: string): Record<string, string> | null {
  const body = lf(text)
  const m = body.match(/<!--\s*(DESK|CARD)[^>]*-->([\s\S]*?)<!--\s*\/\1\s*-->/)
  if (!m) return null
  const card: Record<string, string> = {}
  for (const line of m[2]!.split('\n')) {
    const f = line.match(/^\s*-\s*([^：:]+?)\s*[：:]\s*(.*)$/)
    if (!f) continue
    const key = FIELD_ALIAS[f[1]!] ?? f[1]!
    card[key] = f[2]!.trim()
  }
  return card
}

/** 「沒有」的各種寫法：無、沒有、none、-，單獨或在標點前。 */
export const saysNone = (value: string) => value.trim() === '' || /^(?:無|沒有|none|n\/a|-)(?:$|[；;，,。\s(（])/i.test(value.trim())

export function parseGate(value: string | undefined): Gate | null {
  const raw = (value ?? '').trim()
  if (!raw || saysNone(raw)) return null
  const m = raw.match(/^(spec|review|release)\s*[：:]\s*(.*)$/i)
  return m ? { kind: m[1]!.toLowerCase() as Gate['kind'], detail: m[2]!.trim() } : { kind: 'unknown', detail: raw }
}

export const GATE_LABEL: Record<Gate['kind'], string> = { spec: '規格', review: '審查', release: '上線', unknown: '關卡' }

/** 驗證欄裡反引號內的那一條指令；沒有反引號就整行。 */
export function verifyCommand(value: string | undefined): string {
  const raw = (value ?? '').trim()
  if (!raw || saysNone(raw)) return ''
  const m = raw.match(/`([^`]+)`/)
  return (m ? m[1]! : raw).trim()
}

/** 以 `；` 切子句，括號內的 `；` 不切。 */
export function splitClauses(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if (ch === '(' || ch === '（') depth++
    if (ch === ')' || ch === '）') depth = Math.max(0, depth - 1)
    if ((ch === '；' || ch === ';') && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out.map(s => s.trim()).filter(Boolean)
}

const OPTION = /(?<![A-Za-z0-9.])([A-Za-z]|\d{1,2})[)）]\s*/g

/** 等你欄：每個子句一個決策，`題目：A) … B) …` 的選項各自成列；沒選項就是一句話。 */
export function parseDecisions(ask: string): Decision[] {
  if (saysNone(ask)) return []
  return splitClauses(ask).map(clause => {
    const marks = [...clause.matchAll(OPTION)]
    if (marks.length < 2) return { title: clause, options: [] }
    const first = marks[0]!
    const title = clause.slice(0, first.index!).replace(/[：:]\s*$/, '').trim()
    const options = marks.map((mark, i) => {
      const start = mark.index! + mark[0].length
      const end = i + 1 < marks.length ? marks[i + 1]!.index! : clause.length
      return { key: mark[1]!.toUpperCase(), text: clause.slice(start, end).trim() }
    })
    return { title, options }
  })
}

/** 有選項可選的決策數；沒有選項的那句話只顯示，不能選、也不填入。 */
export const choiceCount = (decisions: Decision[]) => decisions.filter(d => d.options.length > 0).length

/** 數字鍵依序作答：第一個還沒選的決策選第 n 個選項；null 表示沒有可選。 */
export function pickByDigit(decisions: Decision[], picks: Record<string, string>, digit: number): Record<string, string> | null {
  const index = decisions.findIndex((d, i) => d.options.length > 0 && !picks[String(i)])
  if (index < 0) return null
  const option = decisions[index]!.options[digit - 1]
  return option ? { ...picks, [String(index)]: option.key } : null
}

/** 退回上一個選擇。 */
export function unpick(decisions: Decision[], picks: Record<string, string>): Record<string, string> {
  const answered = decisions.map((_, i) => String(i)).filter(i => picks[i])
  if (!answered.length) return picks
  const last = answered[answered.length - 1]!
  return Object.fromEntries(Object.entries(picks).filter(([k]) => k !== last))
}

/** 已選的答案，`1A 2B`；只有一個可選的決策時只寫 `A`。 */
export function decisionAnswer(decisions: Decision[], picks: Record<string, string>): string {
  const parts = decisions.map((d, i) => {
    const key = picks[String(i)]
    if (!key) return ''
    return choiceCount(decisions) > 1 ? `${i + 1}${/^\d/.test(key) ? '-' : ''}${key}` : key
  }).filter(Boolean)
  return parts.join(' ')
}

export const allPicked = (decisions: Decision[], picks: Record<string, string>) =>
  decisions.length > 0 && decisions.every((d, i) => d.options.length === 0 || !!picks[String(i)])

/** 案子根目錄：卡片所在資料夾；資料夾名以 `.` 開頭（.desk、.console）就再上一層。 */
export function projectRoot(statusPath: string): string {
  const parts = statusPath.replace(/\\/g, '/').split('/')
  parts.pop()
  while (parts.length > 1 && parts[parts.length - 1]!.startsWith('.')) parts.pop()
  return parts.join('/') || '/'
}

/**
 * 上線確認：只在卡片區塊的關卡是 `release：…` 時，把關卡清成「無」、狀態寫已上線、下一步換成 nextStep，並在 History 記一筆；舊卡（CARD）的「更新」rev 加 1。
 * 關卡不是 release（別人已經改過）就回 null，不寫卡。
 */
/** 開卡、規格、歸檔的指令（plugin 內附的 skill，名稱帶 plugin 前綴）。 */
export const CARD_CMD = '/desk:card'
/** 上線確認寫進卡片的字：狀態「<tag> 已上線（工作桌確認）」、下一步「可歸檔：…」；六段也靠它們認得已確認上線。 */
export const SHIPPED_WORD = '已上線'
export const ARCHIVE_WORD = '可歸檔'

/** 人名放進中文句子：英文名前後加空格（「要 Alex 決定」），中文不加（「要使用者決定」）。 */
export const named = (user: string) => /^[\x00-\x7F]+$/.test(user) ? ` ${user} ` : user

export function confirmShip(text: string, date: string, time: string, tag: string, nextStep: string, user = '使用者'): string | null {
  const m = text.match(/<!-- (DESK|CARD)\b[^>]*-->\n([\s\S]*?)<!-- \/\1 -->/)
  if (!m || m.index === undefined) return null
  const gate = m[2]!.match(/^- 關卡：(.*)$/m)
  if (!gate || parseGate(gate[1])?.kind !== 'release') return null
  let body = m[2]!.replace(/^- 關卡：.*$/m, '- 關卡：無')
    .replace(/^- 狀態：.*$/m, () => `- 狀態：${tag || '這一版'} ${SHIPPED_WORD}（工作桌確認）`)
    .replace(/^- 下一步：.*$/m, () => `- 下一步：${nextStep}`)
  if (m[1] === 'CARD') body = body.replace(/^- 更新：.*?rev (\d+).*$/m, (_l, rev) => `- 更新：${date} ${time} · rev ${Number(rev) + 1} · desk 上線確認`)
  const start = m.index + m[0].indexOf(m[2]!)
  const next = text.slice(0, start) + body + text.slice(start + m[2]!.length)
  const entry = `- ${date}：${named(user).trimStart()}在工作桌確認 ${tag || '這一版'} 已上線，release 關卡清為無`
  const lines = next.replace(/\s+$/, '').split('\n')
  const at = lines.findIndex(l => /^## History\b/.test(l))
  if (at < 0) return `${lines.join('\n')}\n\n## History\n\n${entry}\n`
  let end = at + 1
  while (end < lines.length && !/^## /.test(lines[end]!)) end++
  let insert = end
  while (insert > at + 1 && lines[insert - 1]!.trim() === '') insert--
  return [...lines.slice(0, insert), entry, ...lines.slice(insert)].join('\n') + '\n'
}

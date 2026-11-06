// 卡片規則段守門：對話或 Agent 寫入 DESK 卡、這次寫入改到「## 卡片規則」段（或卡片是新開的）時，拿那一段跟模板比，被誤蓋、少行時說出是哪幾行。
// 純函式；prompt-sync.ts 在工具呼叫前讀一次卡片、結束後讀卡片與模板、呼叫這裡，再把提示附在工具結果、跳 toast、記動態。

/** 段落標題：行首錨定，卡片其他段落（例如規則段裡的說明句）出現同字串不算。 */
const RULES_HEADING = /^## 卡片規則[ \t]*$/m
/** 下一段的標題。 */
const NEXT_HEADING = /^## /m
/** card.py new 會把模板裡的卡名佔位換成卡名：比對前模板也換掉（舊模板用 <案名>）。 */
const NAME_SLOTS = ['<任務名>', '<案名>'] as const
/** 提示裡每一行最多幾個字。 */
export const RULES_LINE_MAX = 80
/** 卡片標題「# <任務名> DESK」。 */
const CARD_TITLE = /^# (.+?) DESK[ \t]*$/m

/**
 * 「## 卡片規則」段的內容（不含標題）：從行首的標題到下一個行首 `## `，沒有下一段就到檔尾。沒有這一段回 null。
 * 換行統一成 \n。
 */
export function rulesSection(text: string): string | null {
  const body = text.replace(/\r\n?/g, '\n')
  const head = RULES_HEADING.exec(body)
  if (!head) return null
  const rest = body.slice(head.index + head[0].length).replace(/^\n/, '')
  const next = NEXT_HEADING.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

/** 段落裡要比的行：去掉行尾空白，空白行不算。 */
const meaningful = (section: string): string[] => section.split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '')

/** 卡片規則段跟模板差在哪：缺幾行（模板有、卡片沒有）、多幾行（卡片有、模板沒有），與第一個不一致的行（沒有那行是 null）。 */
export type RulesDiff = { missing: number; extra: number; first: { template: string | null; card: string | null } }

/**
 * 卡片與模板的「## 卡片規則」段比對（照行比最長共同子序列）：空白行與行尾空白不算差異。
 * 一致、或任一邊沒有這一段（模板沒有就不檢查；舊格式的卡沒有）回 null。
 */
export function rulesDiff(card: string, template: string): RulesDiff | null {
  const own = rulesSection(card)
  const want = rulesSection(template)
  if (own === null || want === null) return null
  const a = meaningful(want)
  const b = meaningful(own)
  const common = lcsLength(a, b)
  if (common === a.length && common === b.length) return null
  const at = a.findIndex((line, i) => line !== b[i])
  const i = at === -1 ? a.length : at
  return { missing: a.length - common, extra: b.length - common, first: { template: a[i] ?? null, card: b[i] ?? null } }
}

/**
 * 這次寫入有沒有改到「## 卡片規則」段：寫入前後兩邊的段落照行比（行首錨定，空白行與行尾空白不算）。
 * 一邊有這一段、另一邊沒有算改到；兩邊都沒有不算。模板改版前開的舊卡只改其他段時回 false，守門就不拿新模板比它。
 */
export function rulesTouched(before: string, after: string): boolean {
  const was = rulesSection(before)
  const now = rulesSection(after)
  if (was === null || now === null) return was !== now
  const a = meaningful(was)
  const b = meaningful(now)
  return a.length !== b.length || a.some((line, i) => line !== b[i])
}

/** 兩串行的最長共同子序列長度（段落只有十幾行，O(n·m) 夠用）。 */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0)
  for (const x of a) {
    const row = [0]
    for (let j = 0; j < b.length; j++) row.push(x === b[j] ? prev[j]! + 1 : Math.max(prev[j + 1]!, row[j]!))
    prev = row
  }
  return prev[b.length]!
}

/** 模板裡的卡名佔位換成卡名（跟 card.py new 一樣），規則段寫了佔位的自訂模板才比得對。 */
export function fillNameSlots(template: string, name: string): string {
  return NAME_SLOTS.reduce((t, slot) => t.split(slot).join(name), template)
}

/** 卡片標題的任務名；沒有標題回空字串。 */
export function cardTitle(text: string): string {
  return CARD_TITLE.exec(text.replace(/\r\n?/g, '\n'))?.[1]?.trim() ?? ''
}

const clip = (line: string | null): string => {
  if (line === null) return '（沒有這行）'
  const chars = [...line.trim()]
  return chars.length > RULES_LINE_MAX ? `${chars.slice(0, RULES_LINE_MAX - 1).join('')}…` : chars.join('')
}

/** 「缺 n 行」「多 n 行」：是 0 的不寫，兩個都有用「、」接。 */
const countWords = (d: RulesDiff): string => [d.missing ? `缺 ${d.missing} 行` : '', d.extra ? `多 ${d.extra} 行` : ''].filter(Boolean).join('、')

/** toast 與動態用的一句：「<卡名> 的卡片規則段跟模板不一致：缺 n 行」。 */
export function rulesHeadline(name: string, d: RulesDiff): string {
  return `${name} 的卡片規則段跟模板不一致：${countWords(d)}`
}

/** 附在工具結果給模型看的提示：一句結論、第一個不一致的行（模板那行與卡片那行各 80 字內）、要它照模板補回。 */
export function rulesNotice(name: string, d: RulesDiff): string {
  return [
    rulesHeadline(name, d),
    '第一個不一致的行：',
    `  模板：${clip(d.first.template)}`,
    `  卡片：${clip(d.first.card)}`,
    '照模板補回後再繼續。',
  ].join('\n')
}

/** 動態用的一句（Agent 寫壞時記成錯誤）。 */
export function rulesFeedText(name: string): string {
  return `${name} 卡片規則段跟模板不一致`
}

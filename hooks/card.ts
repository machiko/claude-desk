// 卡片與登錄表的解析：純函式，不碰磁碟。
// DESK 卡的五個欄位：狀態、檢查、等你、下一步、關卡；開卡時另記「基準」（舊卡沒有）。舊版 CARD 的「等使用者」一併接受。
import type { Case, Decision, Gate } from '../types'

export type RegistryRow = { name: string; statusPath: string; manual?: boolean }

const lf = (text: string) => text.replace(/\r\n?/g, '\n')

/** `~` 開頭換成家目錄，反斜線換成斜線。 */
export const expandHome = (path: string, home: string) => path.replace(/^~(?=\/|$)/, home).replace(/\\/g, '/')

/** 空的登錄表（只有表頭）：面板的「建立空的登錄表」寫這份，與 skills/card/scripts/card.py 的 REGISTRY_TEMPLATE 同一份。 */
export const REGISTRY_TEMPLATE = '# 任務登錄表\n\n| Project | 卡片路徑 | Scope | Out of scope | Executor |\n| --- | --- | --- | --- | --- |\n'

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim().replace(/`/g, ''))

/** 登錄表：任何一列 `| 任務名 | \`路徑\` |` 都算；標題列有 Executor 欄時，該欄寫 manual 的任務不派工。 */
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
  const gate = readGate(value)
  return gate && isUnreviewed(gate) ? null : gate
}

/** 依審查修完的關卡結論：修正提示叫 Agent 在 review 關卡的分級後面寫這句。 */
export const UNREVIEWED_GATE = '已依審查修正、未複審（發版時整版審查）'
/** 認「依審查修完、還沒人審過」只看這三個字：結論是 Agent 照提示抄的，可能少括號、換標點或插字。card.py 的 UNREVIEWED_MARK 同一個字。 */
export const UNREVIEWED_MARK = '未複審'

function readGate(value: string | undefined): Gate | null {
  const raw = (value ?? '').trim()
  if (!raw || saysNone(raw)) return null
  const m = raw.match(/^(spec|review|release)\s*[：:]\s*(.*)$/i)
  return m ? { kind: m[1]!.toLowerCase() as Gate['kind'], detail: m[2]!.trim() } : { kind: 'unknown', detail: raw }
}

const isUnreviewed = (g: Gate) => g.kind === 'review' && g.detail.includes(UNREVIEWED_MARK)

/**
 * 依審查修完寫的「review：…；已依審查修正、未複審」：不是審查結論（沒有人審過修完的程式），parseGate 當成沒有關卡，
 * 跟以前叫 Agent「改回 無」一樣判斷（停下的流程照舊未通過、按 g 派修正，檢查沒跑、沒過關前六段不跳到合併段）。
 * 卡片的關卡欄（c.gate）照原文保留，面板的關卡列用這個函式照樣顯示；是不是未複審過關看流程紀錄（chain.unreviewed）。
 */
export function unreviewedGate(value: string | undefined): Gate | null {
  const gate = readGate(value)
  return gate && isUnreviewed(gate) ? gate : null
}

export const GATE_LABEL: Record<Gate['kind'], string> = { spec: '規格', review: '驗收', release: '上線', unknown: '關卡' }

/** 整段被 `<` `>` 包住的是範本佔位（例如 `<可以直接派給 Agent 的一件事>`）；規則與 card.py 的 is_placeholder 相同。 */
export const isPlaceholder = (text: string) => { const t = text.trim(); return t.startsWith('<') && t.endsWith('>') }

/** 下一步還是佔位時交給 Agent 的那句（派工的 continue 與回覆的「照卡片的下一步繼續」共用）。 */
export const PLAN_STEP = '依卡片的規格與實作計畫實作'

/**
 * 這段文字像不像一條可執行指令：整段被 `<` `>` 包住的是範本佔位；第一個 token 含中文或全形標點（非 ASCII 可見字元）的是說明句。
 * 用黑名單而不是白名單：`FOO="a b" cmd`、`[ -f x ] && …`、`( … )`、`"/path with space/x"`、`! cmd` 這些 ASCII 開頭的都是合法 shell，不能誤殺。
 * 只看第一個 token，後面的參數可以有中文（例如 `--grep "訂單匯出"`）。
 */
export function looksLikeCommand(text: string): boolean {
  const raw = text.trim()
  if (!raw || isPlaceholder(raw)) return false
  return !/[^\x21-\x7E]/.test(raw.split(/\s+/)[0]!)
}

/**
 * 檢查欄（舊卡「驗證」欄）裡反引號內的那一條指令。沒有反引號、`<…>` 範本佔位、反引號裡是說明句時回空字串：
 * 工作桌把空字串當「缺完成檢查」，不派實作也不執行。所有讀 verify 的地方都只看這個結果，不另外判斷。
 */
export function verifyCommand(value: string | undefined): string {
  const raw = (value ?? '').trim()
  if (!raw || saysNone(raw)) return ''
  const m = raw.match(/`([^`]+)`/)
  if (!m) return ''
  const cmd = m[1]!.trim()
  return looksLikeCommand(cmd) ? cmd : ''
}

/** 卡片「## 規格」段的內文（含 ### 小節）；沒有這段就 null。規則與 card.py 的 spec_section 相同。 */
function specSection(text: string): string | null {
  const lines = lf(text).split('\n')
  const start = lines.findIndex(l => /^## 規格\s*$/.test(l))
  if (start < 0) return null
  const end = lines.findIndex((l, i) => i > start && /^## (?!#)/.test(l))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

export const hasSpec = (text: string) => specSection(text) !== null

/** 有內容的驗收情境（「則」欄不是空白也不是 `<…>` 佔位）；規則與 card.py 的 filled_ac 相同。 */
export function filledAc(text: string): string[] {
  return (specSection(text) ?? '').split('\n').flatMap(line => {
    const cols = line.trim().replace(/^\|+|\|+$/g, '').split('|').map(c => c.trim())
    return cols.length >= 4 && /^AC-\d+$/.test(cols[0]!) && cols[3] && !cols[3].startsWith('<') ? [cols[0]!] : []
  })
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

/** 選項標記 `A)`、`1）`；前面是英數、`.`、`#` 的不算（`v0.1)`、「PR #13）」）。 */
const OPTION = /(?<![A-Za-z0-9.#])([A-Za-z]|\d{1,2})[)）]\s*/g

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

/** 答案 `A`（只有一題可選）或 `1A 2B`／`1-12` 各選了哪一題的哪個選項（題目序號從 0 起算，跟 picks 同一種寫法）。 */
export function picksOf(decisions: Decision[], answer: string): Record<string, string> {
  const tokens = answer.trim().split(/\s+/).filter(Boolean)
  if (choiceCount(decisions) === 1) {
    const index = decisions.findIndex(d => d.options.length > 0)
    return tokens[0] ? { [String(index)]: tokens[0].toUpperCase() } : {}
  }
  return Object.fromEntries(tokens.map(t => t.match(/^(\d+)-?([A-Za-z]|\d{1,2})$/)).filter((m): m is RegExpMatchArray => !!m).map(m => [String(Number(m[1]) - 1), m[2]!.toUpperCase()]))
}

/** 審查寫進「等你」的 MEDIUM 題：寫法見 prompts/review.ts 的 MEDIUM_ASK_FORM（A 不修／B 另開卡修／C 修掉／D 改規格）。 */
const REVIEW_MEDIUM_ASK = /^審查 MEDIUM \d+ 條/

/** 這次送出的答案裡，審查 MEDIUM 那題選的選項文字以 `prefix` 開頭：照文字認，不照字母（舊卡的題目可能還是舊的字母順序）。 */
function picksMediumOption(ask: string, answer: string, prefix: string): boolean {
  const decisions = parseDecisions(ask)
  const picks = picksOf(decisions, answer)
  return decisions.some((d, i) => REVIEW_MEDIUM_ASK.test(d.title) && !!d.options.find(o => o.key === picks[String(i)])?.text.startsWith(prefix))
}

/** 這次送出的答案裡，審查 MEDIUM 那題選的是「修掉」：工作桌要在你清掉「等你」後自動派修正。 */
export const picksMediumFix = (ask: string, answer: string): boolean => picksMediumOption(ask, answer, '修掉')

/** 這次送出的答案裡，審查 MEDIUM 那題選的是「另開卡修」：對話開一張疊在這條分支上的後續卡，工作桌不派修正、原卡照常往開 PR 走。 */
export const picksMediumFollowUp = (ask: string, answer: string): boolean => picksMediumOption(ask, answer, '另開卡')

/** 「填入決策」預填進輸入框的那句；送出時工作桌靠開頭認出是哪件任務的決策。 */
export const decisionPrompt = (name: string, answer: string) => `「${name}」決策：${answer}`

/** 有 release 關卡的卡部署後按 u 確認上線才歸檔，不在發版清理裡。 */
const releaseGated = (c: Pick<Case, 'gate'>) => parseGate(c.gate)?.kind === 'release'

/**
 * 「⚑ 發版」填進輸入框的那行：`/desk:release` 接所有已合併待發版的卡（有 PR 的附 PR 編號），括號裡是 releaseCleanup。
 * confirmed（面板按兩次 z）時括號最後多一段 RELEASE_CONFIRMED，用「；」接在清理段之後；手打的路徑預設不帶。
 * 規則與確認方式在 skills/release/SKILL.md，送出後由對話載入照做；這裡只列要發什麼。
 */
export function releasePrompt(cases: readonly Pick<Case, 'name' | 'pr' | 'root' | 'git' | 'gate'>[], opts: { confirmed?: boolean } = {}): string {
  const list = cases.map(c => `「${c.name}」${c.pr ? `PR #${c.pr.id}` : ''}`).join('、')
  const notes = [releaseCleanup(cases), opts.confirmed ? RELEASE_CONFIRMED : ''].filter(Boolean).join('；')
  return `${RELEASE_CMD} ${list}${notes ? `（${notes}）` : ''}`
}

/**
 * 發版請求括號裡的清理對象：沒有 release 關卡的卡列「slug 分支」，發版後歸檔並移除 worktree 與分支；
 * 有 release 關卡的卡不在這次清理，部署後按 u。全部都有 release 關卡時只寫一句、不列 slug 與分支。
 */
export function releaseCleanup(cases: readonly Pick<Case, 'name' | 'root' | 'git' | 'gate'>[]): string {
  const slug = (c: Pick<Case, 'root'>) => c.root.split('/').filter(Boolean).pop() ?? ''
  const clean = cases.filter(c => !releaseGated(c))
  const gated = cases.filter(releaseGated)
  if (!clean.length && gated.length > 1) return '都有 release 關卡，不清理，部署後按 u'
  const parts = clean.length ? [`歸檔並移除 worktree 與分支：${clean.map(c => [slug(c), c.git?.branch].filter(Boolean).join(' ')).join('、')}`] : []
  return [...parts, ...gated.map(c => `「${c.name}」有 release 關卡，部署後按 u`)].join('；')
}

const DECISION_LINE = /^[ \t]*「(.+?)」決策：/

/**
 * 送出的提示裡是哪幾件任務的決策：每一行以「「任務名」決策：」開頭的都算（填入時輸入框有草稿，決策接在草稿後面；
 * 兩件先後按 f 就是兩行）。依出現順序、不重複；沒有就是空陣列。
 */
/** 送出的提示裡這件任務那一行決策的答案（「「任務名」決策：」後面的字）；沒有這一行回空字串。 */
export function decisionAnswerOf(text: string, name: string): string {
  const line = String(text ?? '').split(/\r?\n/).find(l => l.match(DECISION_LINE)?.[1] === name)
  return line ? line.replace(DECISION_LINE, '').trim() : ''
}

export function decisionNames(text: string): string[] {
  const names = String(text ?? '').split(/\r?\n/).map(line => line.match(DECISION_LINE)?.[1]).filter((n): n is string => !!n)
  return [...new Set(names)]
}

/**
 * 把一件任務的決策放進輸入框的草稿：草稿裡已有這件的決策行（還沒送出又改選、或多按了一次 f）就換成新的那一行、只留一行；
 * 沒有就另起一行接在後面。其他字（含別件任務的決策）原樣保留。
 */
export function withDecision(draft: string, name: string, line: string): string {
  const lines = draft.split(/\r?\n/)
  const isMine = (l: string) => l.match(DECISION_LINE)?.[1] === name
  const at = lines.findIndex(isMine)
  if (at < 0) return draft.endsWith('\n') ? `${draft}${line}` : `${draft}\n${line}`
  return lines.flatMap((l, i) => i === at ? [line] : isMine(l) ? [] : [l]).join('\n')
}

/** 任務根目錄：卡片所在資料夾；資料夾名以 `.` 開頭（.desk、.console）就再上一層。 */
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
/** 發版請求的指令：skills/release/SKILL.md。 */
export const RELEASE_CMD = '/desk:release'
/** 面板按兩次 z 填入的發版請求括號最後一段：使用者已在面板確認、同意照慣例版號，對話不再出題（skills/release/SKILL.md 與 tests/release-sample.mjs 對照同一字串）。 */
export const RELEASE_CONFIRMED = '已在面板確認：版號照慣例直接做'
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
  return withHistory(next, `- ${date} ${time}：${named(user).trimStart()}在工作桌確認 ${tag || '這一版'} 已上線，release 關卡清為無`)
}

/** History 行開頭的本機時間「YYYY-MM-DD HH:MM」（跟 card.py 的 stamp 同一種寫法）。 */
export function historyStamp(at: number): string {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** 在卡片「## History」段尾（段內最後一筆之後）加一行；沒有那段就在檔尾新開。 */
export function withHistory(text: string, entry: string): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  const at = lines.findIndex(l => /^## History\b/.test(l))
  if (at < 0) return `${lines.join('\n')}\n\n## History\n\n${entry}\n`
  let end = at + 1
  while (end < lines.length && !/^## /.test(lines[end]!)) end++
  let insert = end
  while (insert > at + 1 && lines[insert - 1]!.trim() === '') insert--
  return [...lines.slice(0, insert), entry, ...lines.slice(insert)].join('\n') + '\n'
}

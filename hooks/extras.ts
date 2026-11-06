// 0.9 起的純函式：派工二次確認、Agent 輸出、部署步驟、提醒、審查摘要、git 狀態。不碰磁碟。
import type { Case, HistoryEntry } from '../types'
import { plain, screenLines } from './model'

/** 二次確認：同一個動作 3 秒內按第二次才執行。 */
export const CONFIRM_MS = 3000
export type Armed = { key: string; at: number }
export function confirmStep(armed: Armed | null, key: string, now: number): { fire: boolean; armed: Armed | null } {
  if (armed && armed.key === key && now - armed.at <= CONFIRM_MS) return { fire: true, armed: null }
  return { fire: false, armed: { key, at: now } }
}
export const isArmed = (armed: Armed | null, key: string, now: number) => !!armed && armed.key === key && now - armed.at <= CONFIRM_MS

/** 檢查列上待確認的是哪個鍵：t 確認規格、v 執行檢查、g 派實作；第二次按下去就會核准這條檢查。 */
export type ApprovalKey = 't' | 'v' | 'g'
/** 流程停在檢查段、因為指令沒核准：changed 是核准過別的指令（卡片上的檢查被改過），unapproved 是這張卡從沒核准過。 */
export type HeldReason = 'changed' | 'unapproved'
/**
 * 檢查列要不要列出指令全文（不去掉前綴的短版）：第二次按就會核准它，或流程正停在它沒核准。
 * t 待確認一律列（確認規格就核准）；v、g 只在還沒核准時列（核准過按 v 直接跑、按 g 不多核准什麼）。
 */
export function checkApprovalLine(armedKey: ApprovalKey | null, held: HeldReason | null, approved: boolean, verify: string): string | null {
  if (armedKey === 't') return `核准這條（再按 t 之後自動執行）：${verify}`
  if (approved) return null
  if (armedKey === 'v') return `核准這條（再按 v 之後執行）：${verify}`
  if (armedKey === 'g') return `核准這條（再按 g 之後派工，做完自動執行）：${verify}`
  if (held === 'changed') return `改過的指令（按兩次 v 核准並執行）：${verify}`
  return held === 'unapproved' ? `還沒核准的指令（按兩次 v 核准並執行）：${verify}` : null
}

/** Agent 最近幾行有意義的輸出：清掉控制序列、略過雜訊與連續重複。 */
export function logLines(raw: string, n = 10): string[] {
  return screenLines(raw).filter((line, i, all) => line !== all[i - 1]).map(line => line.slice(0, 160)).slice(-n)
}

/** 卡片「## 部署…」段落裡的步驟（編號或項目符號），略過還沒填的空項目。 */
export function deploySteps(cardText: string | null): string[] {
  if (!cardText) return []
  const lines = cardText.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex(l => /^##\s*部署/.test(l))
  if (start < 0) return []
  const steps: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break
    const m = l.match(/^\s*(?:\d+[.)、]|[-*])\s+(.*\S)\s*$/)
    if (m && !/^<.*>$/.test(m[1]!)) steps.push(plain(m[1]!))
  }
  return steps
}

/**
 * 卡片「## History」段落的每一筆，新的在前：`- ` 開頭的行是一筆，縮排的續行併進前一筆。
 * 開頭的 `YYYY-MM-DD` 是日期、後面可接 `HH:MM` 時間（去掉後面的「：」）；模板佔位（`YYYY-MM-DD`、日期後沒有內容）不算。
 * 日期＋時間由新到舊；時間相同或沒寫時間（舊卡）的照卡片裡由後往前（卡片由舊到新寫），沒有日期的放最後。
 * cardMtime（卡片最後修改時間，毫秒）有值時，時間晚於它超過 1 分鐘的那筆是 Agent 估錯的未來時間：只回日期，排序仍用原時間。
 */
export function historyEntries(cardText: string | null, cardMtime: number | null = null): HistoryEntry[] {
  if (!cardText) return []
  const lines = cardText.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex(l => /^##\s*History\s*$/i.test(l))
  if (start < 0) return []
  const raw: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break
    const item = l.match(/^[-*]\s+(.*)$/)
    if (item) raw.push(item[1]!.trim())
    else if (/^\s+\S/.test(l) && raw.length) raw[raw.length - 1] = `${raw[raw.length - 1]} ${l.trim()}`.trim()
  }
  const entries = raw.flatMap((body, order) => {
    if (/^YYYY-MM-DD/.test(body)) return []
    const m = body.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?!\d))?\s*[：:]?\s*(.*)$/)
    const text = plain(m ? m[3]! : body).trim()
    if (!text) return []
    const entry: HistoryEntry = !m ? { text } : m[2] ? { date: m[1]!, time: m[2], text } : { date: m[1]!, text }
    return [{ order, entry }]
  })
  // 排序鍵：沒寫時間的沿用卡片裡前面同一天最近一筆的時間（舊新格式混排時跟著前一筆），都沒有就當當天最早。
  const keyed = entries.map((e, i) => {
    const date = e.entry.date ?? ''
    const time = e.entry.time ?? entries.slice(0, i).reverse().find(p => p.entry.date === e.entry.date && p.entry.time)?.entry.time ?? ''
    return { ...e, key: `${date} ${time}` }
  })
  return keyed
    .sort((a, b) => b.key.localeCompare(a.key) || b.order - a.order)
    .map(e => cardMtime !== null && isFuture(e.entry, cardMtime) ? { date: e.entry.date!, text: e.entry.text } : e.entry)
}

/** 歷程時間可以比卡片修改時間晚多久（同一分鐘內寫完再存檔、秒數被捨去）。 */
export const HISTORY_SLACK_MS = 60_000
/** 這筆的日期＋時間（本地時間）晚於卡片修改時間所在那一分鐘再加 HISTORY_SLACK_MS：寫卡片時還沒到的時間。 */
function isFuture(e: HistoryEntry, cardMtime: number): boolean {
  if (!e.date || !e.time) return false
  const [y, mo, d] = e.date.split('-').map(Number)
  const [h, mi] = e.time.split(':').map(Number)
  const at = new Date(y!, mo! - 1, d!, h!, mi!).getTime()
  return at > Math.floor(cardMtime / 60_000) * 60_000 + HISTORY_SLACK_MS
}

/**
 * 登錄表「## 提醒」段落：`- YYYY-MM-DD 事項` 回傳距今天數（負數是已過期）；`- 事項` 沒寫日期，date、days 是 null，
 * 永遠不算到期也不算過期。有日期的依天數排前面，沒日期的照原本順序排在後面。
 */
export type Reminder = { date: string | null; text: string; days: number | null }
export const REMIND_DAYS = 3
export function parseReminders(text: string, now: number): Reminder[] {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex(l => /^##\s*提醒/.test(l))
  if (start < 0) return []
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const dated: Reminder[] = []
  const undated: Reminder[] = []
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break
    const m = l.match(/^\s*[-*]\s*(\d{4})-(\d{1,2})-(\d{1,2})\s+(.+?)\s*$/)
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      dated.push({ date: `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`, text: plain(m[4]!), days: Math.round((d.getTime() - today.getTime()) / 86_400_000) })
      continue
    }
    const item = undatedItem(l)
    if (item) undated.push({ date: null, text: plain(item), days: null })
  }
  return [...dated.sort((a, b) => a.days! - b.days!), ...undated]
}
/**
 * 沒寫日期的一行提醒的事項，不算提醒就回 null。只收最外層的 `- `／`* ` 項目；打勾（[x]）、整條劃掉（~~…~~）、
 * 開頭像日期卻不是 YYYY-MM-DD 事項（斜線日期、只寫日期）、`<…>` 佔位、沒有文字的分隔線都不算，跟以前格式不符就忽略一樣。
 * 未打勾的 [ ] 拿掉框照算。
 */
function undatedItem(line: string): string | null {
  const m = line.match(/^[-*]\s+(.*\S)\s*$/)
  if (!m) return null
  const body = m[1]!.replace(/^\[ \]\s+/, '')
  if (/^\[[xX]\]/.test(body) || /^~~/.test(body) || /^<.*>$/.test(body)) return null
  if (/^\d{1,4}[-/.]\d/.test(body)) return null
  return /\p{L}/u.test(body) ? body : null
}

/** 有日期且 3 天內到期（含已過期）：提示列只看這些。 */
export const dueReminders = (list: Reminder[] | undefined) => (list ?? []).filter(r => r.days !== null && r.days <= REMIND_DAYS)
/** 面板列的提醒：到期的有日期提醒，再接全部沒日期的。 */
export const paneReminders = (list: Reminder[] | undefined) => [...dueReminders(list), ...(list ?? []).filter(r => r.days === null)]
export const reminderWhen = (r: Reminder) => r.days === null ? '' : r.days < 0 ? `已過 ${-r.days} 天` : r.days === 0 ? '今天' : `還有 ${r.days} 天`

/** 審查檔裡的 CRITICAL、HIGH 前幾條：「- [HIGH][稽核] 檔案:行 — 說明」→「HIGH 稽核 檔案:行 — 說明」。 */
export function reviewTop(text: string | null, n = 3): string[] {
  if (!text) return []
  const out: string[] = []
  for (const l of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = l.match(/^\s*[-*]\s*\[(CRITICAL|HIGH)\]\s*(?:\[([^\]]+)\])?\s*(.+)$/i)
    if (m) out.push(plain(`${m[1]!.toUpperCase()}${m[2] ? ` ${m[2]}` : ''} ${m[3]}`))
  }
  return out.slice(0, n)
}

/**
 * 審查檔第一行的前置結果：「前置：成功，候選 n 條，採用 m 條」→「成功，候選 n 條，採用 m 條」，
 * 「前置：失敗（原因）」→「失敗（原因）」。不在第一行、格式不對、沒有檔案都回 null。先去掉控制序列與 \r。
 */
export function preflightLine(text: string | null): string | null {
  if (!text) return null
  const first = plain(text.replace(/\r\n?/g, '\n').split('\n')[0]!).trim()
  const ok = first.match(/^前置：成功，候選 (\d+) 條，採用 (\d+) 條$/)
  if (ok) return `成功，候選 ${ok[1]} 條，採用 ${ok[2]} 條`
  const fail = first.match(/^前置：失敗（(.+)）$/)
  return fail ? `失敗（${fail[1]}）` : null
}

/**
 * 審查檔裡要自動修的 MEDIUM 條數：「- [MEDIUM]…」開頭的行（不分大小寫，跟 reviewTop 同一種比對），行尾是註記就不算：
 * 結尾的括號以「不修」或「等你決定」收尾（「（記錄、不修）」「（不修）」「（等你決定）」「（上一輪已列，等你決定）」，後面可以接句號、空白）。
 * 說明裡的括號照算，不管在中間或結尾（例如「（parse 失敗後不修正預設值）」「（不修會 crash）」「（若不修正會顯示前一天）」），
 * 免得影響行為的 MEDIUM 既不修也不問。沒有檔案回 0。
 */
export function mediumToFix(text: string | null): number {
  if (!text) return 0
  return text.replace(/\r\n?/g, '\n').split('\n')
    .filter(l => /^\s*[-*]\s*\[MEDIUM\]/i.test(l) && !/[（(][^（）()]*(?:不修|等你決定)[）)][。.]?\s*$/.test(l))
    .length
}

/**
 * 審查檔裡標「（等你決定）」的 MEDIUM 條數：「- [MEDIUM]…」開頭、行尾括號以「等你決定」收尾（「（上一輪已列，等你決定）」也算，後面可以接句號、空白）。
 * 有 CRITICAL／HIGH 時這幾題留在審查檔、等你留無，靠修正後的審查過關時問；沒有檔案回 0。
 */
export function mediumToDecide(text: string | null): number {
  if (!text) return 0
  return text.replace(/\r\n?/g, '\n').split('\n')
    .filter(l => /^\s*[-*]\s*\[MEDIUM\]/i.test(l) && /[（(][^（）()]*等你決定[）)][。.]?\s*$/.test(l))
    .length
}

/** `git status --porcelain=v2 --branch`：領先、落後、未提交、未追蹤，以及有沒有遠端分支（upstream）。 */
export type GitState = { ahead: number; behind: number; changed: number; untracked: number; /** false：origin 上沒有這個分支（從沒 push 過，或合併後遠端分支被刪、fetch --prune 過）。沒填（舊資料）當作有。 */ upstream?: boolean }
export function parseGitStatus(text: string): GitState {
  const st: GitState = { ahead: 0, behind: 0, changed: 0, untracked: 0, upstream: false }
  for (const l of String(text ?? '').split(/\r?\n/)) {
    if (l.startsWith('# branch.upstream ')) { st.upstream = true; continue }
    const ab = l.match(/^# branch\.ab \+(\d+) -(\d+)/)
    if (ab) { st.ahead = Number(ab[1]); st.behind = Number(ab[2]); continue }
    if (/^[12u] /.test(l)) st.changed++
    else if (l.startsWith('? ')) st.untracked++
  }
  return st
}
/**
 * PR 已合併、PR 的 head 就是現在的 HEAD：沒有 upstream 是合併後遠端分支被自動刪掉，分支上沒有沒推的 commit。
 * 合併後又 commit（head 不同）、PR 沒帶 head、沒有 PR（git 判斷的合併不會刪遠端分支）都不算。Bitbucket 的 head 是 12 碼短 sha，比前綴。
 */
export function mergedAtHead(c: Pick<Case, 'git' | 'pr'>): boolean {
  const head = c.git?.head ?? ''
  const prHead = c.pr?.state === 'MERGED' ? c.pr.head ?? '' : ''
  return !!head && !!prHead && (head.startsWith(prHead) || prHead.startsWith(head))
}
/** merged：見 mergedAtHead；成立時沒有 upstream 不算未 push。 */
export function gitLine(g: GitState, merged = false): string {
  const noUpstream = merged ? '已合併，遠端分支已刪除' : '未 push（沒有遠端分支）'
  const parts = [g.upstream === false ? noUpstream : '', g.ahead ? `領先 ${g.ahead}` : '', g.behind ? `落後 ${g.behind}` : '', g.changed ? `未提交 ${g.changed} 檔` : '', g.untracked ? `未追蹤 ${g.untracked} 檔` : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : '與遠端一致、無未提交變更'
}

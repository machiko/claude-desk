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
 * 開頭的 `YYYY-MM-DD` 是日期（去掉後面的「：」）；模板佔位（`YYYY-MM-DD`、日期後沒有內容）不算。
 * 日期由新到舊，同一天照卡片裡由後往前（卡片由舊到新寫），沒有日期的放最後。
 */
export function historyEntries(cardText: string | null): HistoryEntry[] {
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
    const m = body.match(/^(\d{4}-\d{2}-\d{2})\s*[：:]?\s*(.*)$/)
    const text = plain(m ? m[2]! : body).trim()
    return text ? [{ order, entry: m ? { date: m[1]!, text } : { text } }] : []
  })
  return entries
    .sort((a, b) => (b.entry.date ?? '').localeCompare(a.entry.date ?? '') || b.order - a.order)
    .map(e => e.entry)
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

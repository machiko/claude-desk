// 0.9 起的純函式：派工二次確認、Agent 輸出、部署步驟、提醒、審查摘要、git 狀態、下一件。不碰磁碟。
import type { Case } from '../types'
import { isNoise, plain } from './model'

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
  const out: string[] = []
  for (const l of String(raw ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '\n').split(/[\r\n]+/)) {
    const line = plain(l).trim()
    if (!line || isNoise(line) || out[out.length - 1] === line) continue
    out.push(line.slice(0, 160))
  }
  return out.slice(-n)
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

/** 登錄表「## 提醒」段落：`- YYYY-MM-DD 事項`；回傳每條與距今天數（負數是已過期）。 */
export type Reminder = { date: string; text: string; days: number }
export const REMIND_DAYS = 3
export function parseReminders(text: string, now: number): Reminder[] {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex(l => /^##\s*提醒/.test(l))
  if (start < 0) return []
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const out: Reminder[] = []
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break
    const m = l.match(/^\s*[-*]\s*(\d{4})-(\d{1,2})-(\d{1,2})\s+(.+?)\s*$/)
    if (!m) continue
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    out.push({ date: `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`, text: plain(m[4]!), days: Math.round((d.getTime() - today.getTime()) / 86_400_000) })
  }
  return out.sort((a, b) => a.days - b.days)
}
export const dueReminders = (list: Reminder[] | undefined) => (list ?? []).filter(r => r.days <= REMIND_DAYS)
export const reminderWhen = (r: Reminder) => r.days < 0 ? `已過 ${-r.days} 天` : r.days === 0 ? '今天' : `還有 ${r.days} 天`

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

/** `git status --porcelain=v2 --branch`：領先、落後、未提交、未追蹤。 */
export type GitState = { ahead: number; behind: number; changed: number; untracked: number }
export function parseGitStatus(text: string): GitState {
  const st: GitState = { ahead: 0, behind: 0, changed: 0, untracked: 0 }
  for (const l of String(text ?? '').split(/\r?\n/)) {
    const ab = l.match(/^# branch\.ab \+(\d+) -(\d+)/)
    if (ab) { st.ahead = Number(ab[1]); st.behind = Number(ab[2]); continue }
    if (/^[12u] /.test(l)) st.changed++
    else if (l.startsWith('? ')) st.untracked++
  }
  return st
}
export function gitLine(g: GitState): string {
  const parts = [g.ahead ? `領先 ${g.ahead}` : '', g.behind ? `落後 ${g.behind}` : '', g.changed ? `未提交 ${g.changed} 檔` : '', g.untracked ? `未追蹤 ${g.untracked} 檔` : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : '與遠端一致、無未提交變更'
}

/** `n`：下一件。從目前選的那件往後找，需要你處理的優先；都沒有就照順序輪。 */
const NEEDS_YOU = new Set(['ask', 'reply', 'gate', 'failed'])
export function nextCase(sorted: Case[], current: string | null): string | null {
  if (!sorted.length) return null
  const at = sorted.findIndex(c => c.statusPath === current)
  const order = [...sorted.slice(at + 1), ...sorted.slice(0, at + 1)]
  const urgent = order.find(c => NEEDS_YOU.has(c.state) && c.statusPath !== current)
  return (urgent ?? order.find(c => c.statusPath !== current) ?? sorted[0]!).statusPath
}

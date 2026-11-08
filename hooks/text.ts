// 純文字與時間工具：清掉控制字元、重播終端機畫面、算寬度與裁切、多久以前與重置時間、指令失敗的原因句、任務代號。
// 葉節點：不在執行期 import 任何 hooks 模組（model、dispatch 與畫面都從這裡拿）。
import type { Case } from '../types'

/** 任務的代號：worktree 資料夾名，也是 /desk:card 指令裡的 <slug>。 */
export const slugOf = (c: Pick<Case, 'root'>) => c.root.split('/').filter(Boolean).pop() ?? ''

/**
 * card.py 失敗時的原因：它把原因印在第一行，後面才接細節（例如整份登錄表）。
 * 未預期的 Python 例外則是 Traceback 開頭、例外印在最後一行，這時取最後一行。
 */
export function reasonLine(r: { stderr?: string; stdout?: string } | null | undefined, fallback = '沒有輸出') {
  const lines = String(r?.stderr || r?.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const traceback = lines.some(l => l.startsWith('Traceback (most recent call last)'))
  return (traceback ? lines.at(-1) : lines[0]) || fallback
}

/** 指令失敗時給人看的那一行：stderr（沒有就 stdout）的最後一行。 */
export const errorLine = (r: { stderr?: string; stdout?: string } | null | undefined, fallback = '沒有輸出') =>
  String(r?.stderr || r?.stdout || '').trim().split(/\r?\n/).pop() || fallback

export const STALE_MS = 3 * 24 * 60 * 60_000

/** 例外的訊息，去掉控制字元。 */
export const errorText = (error: unknown) => plain(error instanceof Error ? error.message : String(error))

/** Herdr 相容的 OSC 7501 四種語意化狀態。 */
export type Osc7501State = 'working' | 'blocked' | 'done' | 'idle'

/** 從原始終端機輸出解析出的最後一筆 OSC 7501 狀態訊號。 */
export type Osc7501Signal = {
  state: Osc7501State
  waitsFor?: 'permission' | 'question'
  agent?: string
  message?: string
}

const OSC_7501_RE = /\u001b\]7501;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g
const OSC_7501_STATES = new Set<Osc7501State>(['working', 'blocked', 'done', 'idle'])

/**
 * 在 plain() 剝掉控制序列之前，掃描原始輸出裡最後一筆合法的 OSC 7501 轉義序列：
 * `\e]7501;state=working|blocked|done|idle[;wait=permission|question][;agent=agy][;msg=...]\e\\`（或 `\x07` 結尾）。
 */
export function parseOsc7501(raw: string): Osc7501Signal | null {
  const text = String(raw ?? '')
  if (!text.includes('\u001b]7501;')) return null
  let found: Osc7501Signal | null = null
  for (const m of text.matchAll(OSC_7501_RE)) {
    const body = m[1] ?? ''
    const kv = new Map<string, string>()
    for (const part of body.split(';')) {
      const eq = part.indexOf('=')
      if (eq <= 0) continue
      const k = part.slice(0, eq).trim().toLowerCase()
      const v = part.slice(eq + 1).trim()
      if (k && v) kv.set(k, v)
    }
    const rawState = (kv.get('state') ?? '').toLowerCase() as Osc7501State
    if (!OSC_7501_STATES.has(rawState)) continue
    const rawWait = (kv.get('wait') ?? kv.get('reason') ?? kv.get('waitingfor') ?? '').toLowerCase()
    const waitsFor: 'permission' | 'question' | undefined = rawWait === 'permission' ? 'permission' : rawWait === 'question' ? 'question' : rawState === 'blocked' ? 'permission' : undefined
    const agent = plain(kv.get('agent') ?? kv.get('runner') ?? '').trim() || undefined
    const message = plain(kv.get('msg') ?? kv.get('message') ?? '').trim() || undefined
    found = {
      state: rawState,
      ...(waitsFor ? { waitsFor } : {}),
      ...(agent ? { agent } : {}),
      ...(message ? { message } : {}),
    }
  }
  return found
}

/**
 * 外部來的文字（Agent 記錄、檢查輸出、卡片）進畫面前清乾淨：拿掉所有終端機控制序列與控制字元。
 * 引擎會整個拒畫含控制字元的文字，面板就會變成一片空白。
 */
export function plain(text: string): string {
  return String(text ?? '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')          // CSI：顏色、游標移動、清除
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '') // OSC：標題、超連結
    .replace(/\u001b[@-Z\\-_]/g, '')                    // 其他兩字元序列
    .replace(/^[\d;]*m/, '')                             // 尾巴被截斷時殘留的半截顏色碼
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

/**
 * 不算「有意義的一行」：太短、轉圈圈的狀態字（含被截斷的半個字）、秒數與 token 計數、按鍵提示、純框線、
 * 沒有空白也沒有中文的單一英文片段、畫面最底的 UI 列（輸入框上框線夾名字、模式列、努力度）。
 */
export function isNoise(line: string): boolean {
  const l = line.trim()
  if (displayWidth(l) < 4) return true
  // 輸入框上框線「──…── <名字> ─」、模式列「⏸ manual mode on · ← for agents」「⏵⏵ accept edits on」（只認 ⏸／⏵⏵ 開頭的，提問裡的「mode on」不算）、努力度「● high · /effort」。
  if (/^─{10,} .* ─$/.test(l) || /^(?:⏸|⏵⏵)\s*(?:[a-z]+ mode|accept edits|bypass permissions) on\b|← (?:for|\d+) agents|· \/effort$/.test(l)) return true
  if (/…/.test(l) && displayWidth(l) < 40) return true
  if (/\d+(?:\.\d+)?k? tokens|\d+s ·|· ↓|esc to interrupt|\? for shortcuts|shift\+tab|^running |^[A-Z][a-z]+ for \d+\s*s/.test(l)) return true
  if (/^[\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║>·\-=*`()]+$/.test(l)) return true
  if (!/[\u3400-\u9fff]/.test(l) && !/\s/.test(l) && l.length < 16) return true
  // 重繪剩下的數字碎片（倒數、欄位號）：沒有中文、也沒有連續三個英文字母。
  if (!/[\u3400-\u9fff]/.test(l) && !/[A-Za-z]{3}/.test(l)) return true
  // 額度列（5h:40% 7d:43%）。
  if (/\d+[hd]:\d+%/.test(l)) return true
  return isStatusLine(l)
}

/**
 * 畫面最底的狀態列「<分支> │ +n/-m │ <worktree>」（沒有改動時沒有中段）：用 │ 分欄、每欄是一個詞（或它的重繪碎片，例如「r leas v14.2.6」）。
 * 兩端都是 │ 的是框線裡的句子（權限提示框、表格），不算。
 */
export function isStatusLine(line: string): boolean {
  const l = line.trim()
  if (!/│/.test(l)) return false
  if (/\+\d+\/-\d+/.test(l)) return true
  if (/[\u3400-\u9fff]/.test(l) || (l.startsWith('│') && l.endsWith('│'))) return false
  return l.split('│').every(seg => seg.trim().split(/\s+/).length <= 3)
}

/** 東亞寬字（CJK、全形、韓文）在終端機佔兩格。 */
const isWide = (code: number) => code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x3fffd))

/**
 * `claude logs` 是整個畫面的重繪紀錄（每次只畫有變的格子），把它重播成最後的畫面，一列一個字串，由上到下。
 * 只追游標與格子：游標移動（上下左右、跳欄、定位）、清行、清畫面照做；顏色、模式切換與其他序列略過。
 * 真實紀錄列與列之間是 \r（回到行首），列由緊接的 \e[nB、\e[n;mH 決定；\n 當一般換行。
 * 同一列多次重繪會疊在同一列上，所以不會把「c mmand.run」這種只畫了變動格子的碎片當成一句話；
 * 紀錄開始前就畫好的格子還是看不到（狀態列常只剩碎片），那些由 isNoise 擋。
 * 短 session 的紀錄從整頁畫起，畫面最底的輸入框（只剩提示符 ❯ 的那列）與它以下的框線、模型列、分支列、模式列都是 UI 元件，整段丟掉。
 */
export function screenLines(raw: string): string[] {
  const text = String(raw ?? '')
  const rows = new Map<number, string[]>()
  let r = 0
  let c = 0
  const row = () => { const got = rows.get(r); if (got) return got; const made: string[] = []; rows.set(r, made); return made }
  const re = /\u001b\[([0-?]*)[ -/]*([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\r|\n|[^\u001b\r\n]+/g
  for (const m of text.matchAll(re)) {
    const s = m[0]
    if (s === '\r') { c = 0; continue }
    if (s === '\n') { r++; c = 0; continue }
    if (s[0] !== '\u001b') {
      for (const ch of s) {
        const code = ch.codePointAt(0) ?? 0
        if (code < 32 || (code >= 0x7f && code <= 0x9f)) continue
        const cells = row()
        cells[c++] = ch
        if (isWide(code)) cells[c++] = ''
      }
      continue
    }
    if (m[2] === undefined) continue
    const args = (m[1] ?? '').split(';').map(x => parseInt(x, 10))
    const arg = (i: number, fallback: number) => { const v = args[i]; return v === undefined || Number.isNaN(v) ? fallback : v }
    switch (m[2]) {
      case 'A': r = Math.max(0, r - arg(0, 1)); break
      case 'B': r += arg(0, 1); break
      case 'C': c += arg(0, 1); break
      case 'D': c = Math.max(0, c - arg(0, 1)); break
      case 'G': c = Math.max(0, arg(0, 1) - 1); break
      case 'H': case 'f': r = Math.max(0, arg(0, 1) - 1); c = Math.max(0, arg(1, 1) - 1); break
      case 'K': { const cells = row(); const k = arg(0, 0); if (k === 0) cells.length = Math.min(cells.length, c); else if (k === 1) cells.fill(' ', 0, c + 1); else cells.length = 0; break }
      case 'J': { const k = arg(0, 0); for (const key of [...rows.keys()]) if (k === 2 || (k === 0 && key > r) || (k === 1 && key < r)) rows.delete(key); if (k === 0) row().length = Math.min(row().length, c); break }
      default: break
    }
  }
  const lines = [...rows.keys()].sort((a, b) => a - b)
    .map(k => plain(Array.from(rows.get(k)!, x => x ?? ' ').join('')).replace(/\s+/g, ' ').trim())
  const prompt = lines.lastIndexOf('❯')
  return (prompt < 0 ? lines : lines.slice(0, prompt)).filter(l => l && !isNoise(l))
}

/** Agent 最後畫面上最下面一句有意義的話（見 screenLines），略過雜訊；行首的轉圈圈、項目符號與 [標籤] 拿掉。 */
export function lastMeaningful(raw: string, max = 120): string {
  return (screenLines(raw).pop() ?? '').replace(/^[⏺●✻✽✢✳✶·❯]\s*/, '').replace(/^\[[^\]]*\]\s*/, '').slice(0, max)
}

/** 字串在終端機佔的格數：CJK 與常見全形兩格，其餘一格。 */
export function displayWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 32) continue
    w += isWide(code) ? 2 : 1
  }
  return w
}

/** 裁到 `columns` 格，尾端加 …；放得下就原樣。 */
export function fit(text: string, columns: number): string {
  if (columns <= 0) return ''
  if (displayWidth(text) <= columns) return text
  let out = ''
  let w = 0
  for (const ch of text) {
    const cw = displayWidth(ch)
    if (w + cw > columns - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}

/** 補空白到 `columns` 格。 */
export const pad = (text: string, columns: number) => text + ' '.repeat(Math.max(0, columns - displayWidth(text)))

/** 多久以前：剛剛、5 分鐘前、3 小時前、2 天前（帶「前」，看得出是過去的時間）。 */
export function ago(t: number | null, now: number): string {
  if (t === null) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return '剛剛'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分鐘前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小時前`
  return `${Math.floor(h / 24)} 天前`
}

/** 跑了多久：12 秒、4 分 12 秒、1 小時 3 分（一小時以上不寫秒）。 */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 小時 ${m % 60} 分`
}

/** 總執行時間只到分：不到 1 分、13 分、1 小時 3 分。 */
export function runMinutesText(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return '不到 1 分'
  if (m < 60) return `${m} 分`
  return `${Math.floor(m / 60)} 小時 ${m % 60} 分`
}

export const hhmm = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 重置時間：今天只寫時分，明天寫「明天」，7 天內寫星期，更遠寫日期；short 只留哪一天（今天、明天、週三、1/12）。 */
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']
const DAY_MS = 86_400_000
const WEEK_DAYS = 7
export function resetText(iso: string | undefined, now: number, short = false): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const n = new Date(now)
  // 比日曆日：兩邊都取當地午夜再相減（四捨五入吸收日光節約的一小時）。
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) / DAY_MS)
  const day = days <= 0 ? '' : days === 1 ? '明天' : days < WEEK_DAYS ? `週${WEEKDAY[d.getDay()]}` : `${d.getMonth() + 1}/${d.getDate()}`
  if (short) return day || '今天'
  return `${day ? `${day} ` : ''}${hhmm(t)} 重置`
}

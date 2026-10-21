// 狀態模型：從卡片、檔案時間與背景 agent 推出每件任務的一個狀態詞，以及工作桌要看的順序。
// 純函式；register.tsx 負責讀。
import type { AgentInfo, Case, CaseState, FeedEvent, Snapshot, Verify } from '../types'
import type { RegistryRow } from './card'
import { filledAc, hasSpec, parseCard, parseDecisions, parseGate, projectRoot, saysNone, verifyCommand } from './card'
import { STATE } from './theme'
import { parseVerdict, blocking, pipeline, standingVerdict } from './pipeline'
import { isDeskLaunch } from './dispatch'

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
 * 沒有空白也沒有中文的單一英文片段。
 */
export function isNoise(line: string): boolean {
  const l = line.trim()
  if (displayWidth(l) < 4) return true
  if (/…/.test(l) && displayWidth(l) < 40) return true
  if (/\d+(?:\.\d+)?k? tokens|\d+s ·|· ↓|esc to interrupt|\? for shortcuts|^running |^[A-Z][a-z]+ for \d+\s*s/.test(l)) return true
  if (/^[\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║>·\-=*`()]+$/.test(l)) return true
  if (!/[\u3400-\u9fff]/.test(l) && !/\s/.test(l) && l.length < 16) return true
  return false
}

/** Agent 記錄的最後一句有意義的話：控制序列與 \r 都當成分行，略過雜訊。 */
export function lastMeaningful(raw: string, max = 120): string {
  const lines = String(raw ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '\n').split(/[\r\n]+/).map(l => plain(l).trim()).filter(l => l && !isNoise(l))
  return (lines.pop() ?? '').replace(/^\[[^\]]*\]\s*/, '').slice(0, max)
}

/** 模型名稱給人看：claude-opus-5-5 → Opus 5.5；別名（opus、haiku）與其他寫法原樣。 */
export function modelLabel(id: string | undefined): string {
  const raw = String(id ?? '').trim()
  const m = raw.match(/^claude-([a-z]+)-(\d+)-(\d+)(.*)$/i)
  if (!m) return raw
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}${m[4] ?? ''}`
}

/** 字串在終端機佔的格數：CJK 與常見全形兩格，其餘一格。 */
export function displayWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 32) continue
    w += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x3fffd)) ? 2 : 1
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

/** 多久以前：剛剛、5 分、3 時、2 天。 */
export function ago(t: number | null, now: number): string {
  if (t === null) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return '剛剛'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分鐘`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小時`
  return `${Math.floor(h / 24)} 天`
}

export const hhmm = (t: number) => {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function rawAgents(json: string): any[] {
  try { const v = JSON.parse(json.replace(/^\uFEFF/, '')); return Array.isArray(v) ? v : Array.isArray(v?.agents) ? v.agents : [] } catch { return [] }
}

/**
 * `claude agents --json --all`：每個根目錄留一個「真的在動」的背景 agent（status busy，或 waiting 停在權限提示）。
 * 一個轉完回合的 agent 會 status idle 而 state 還是 working／blocked，那不算在跑；
 * 它是不是「停下來等你」要看它是不是工作桌派出去的那一次（`asksFor`）。
 */
export const parseAgents = (json: string): Record<string, AgentInfo> => agentsByRoot(rawAgents(json))

const cwdOf = (a: any): string => typeof a?.cwd === 'string' ? a.cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''

/** 同 parseAgents，從已經解析好的清單（例如拿掉被取代的之後）挑。 */
export function agentsByRoot(list: readonly any[]): Record<string, AgentInfo> {
  const out: Record<string, AgentInfo> = {}
  for (const a of list) {
    const cwd = cwdOf(a)
    if (!cwd || a.kind !== 'background') continue
    const status = String(a.status ?? '').toLowerCase()
    if (status !== 'busy' && status !== 'waiting') continue
    const info = agentInfo(a)
    const prev = out[cwd]
    if (!prev || (info.startedAt ?? 0) > (prev.startedAt ?? 0)) out[cwd] = info
  }
  return out
}

/** 一個根目錄最後一次派工的名字與派出時間（$.store 的 jobs）。 */
export type LastLaunch = { launchName: string; startedAt: number }
/** 被後來的派工取代、還停在提問的工作桌 Agent。 */
export type Superseded = { root: string; id: string; name: string; startedAt: number }

const isSuperseded = (a: any, last: Readonly<Record<string, LastLaunch>>): boolean => {
  const l = last[cwdOf(a)]
  const name = String(a?.name ?? '')
  return !!l && a.kind === 'background' && String(a.status ?? '').toLowerCase() === 'waiting'
    && isDeskLaunch(name) && name !== l.launchName && typeof a.startedAt === 'number' && a.startedAt < l.startedAt
}

/**
 * 挑出被取代的 Agent：工作桌派的（desk- 開頭）、停在提問（status waiting）、比這個根目錄最後一次派工早啟動、不是最後那一次。
 * 它們不再代表任務（狀態照卡片走）；回傳拿掉它們之後的清單，與被取代的那幾個（給工作桌停掉）。
 */
export function supersede(list: readonly any[], last: Readonly<Record<string, LastLaunch>>): { list: any[]; superseded: Superseded[] } {
  return {
    list: list.filter(a => !isSuperseded(a, last)),
    superseded: list.filter(a => isSuperseded(a, last)).map(a => ({ root: cwdOf(a), id: typeof a.id === 'string' ? a.id : '', name: plain(String(a.name)), startedAt: a.startedAt as number })),
  }
}

export function agentInfo(a: any): AgentInfo {
  return { ...(typeof a.id === 'string' ? { id: a.id } : {}), name: plain(String(a.name ?? a.id ?? '')), ...(typeof a.sessionId === 'string' ? { sessionId: a.sessionId } : {}), state: String(a.state ?? ''), status: String(a.status ?? ''), ...(a.waitingFor ? { waitingFor: plain(String(a.waitingFor)) } : {}), ...(typeof a.startedAt === 'number' ? { startedAt: a.startedAt } : {}) }
}

/** 工作桌派出去的那一次（按啟動名）做完後停在提問：state blocked 且不再 busy。 */
export function asksFor(list: any[], launchName: string | undefined): AgentInfo | null {
  if (!launchName) return null
  const a = list.find(x => x?.name === launchName && x?.kind === 'background')
  if (!a) return null
  const status = String(a.status ?? '').toLowerCase()
  if (status === 'busy' || status === 'waiting') return null
  return String(a.state ?? '').toLowerCase() === 'blocked' ? { ...agentInfo(a), asks: true } : null
}

/**
 * 工作桌派出去的那一次（按啟動名）結束了沒、怎麼結束的：還在跑（busy／waiting）、停在提問（blocked）、清單裡找不到都是 null；
 * `claude stop` 停掉的是 stopped（清單裡 state 是 stopped、沒有 status），其他算 finished。找不到不算結束：剛派出去的那次可能還沒出現在這份清單。
 */
export function endedHow(list: readonly any[], launchName: string | undefined): 'finished' | 'stopped' | null {
  if (!launchName) return null
  const a = list.find(x => x?.name === launchName && x?.kind === 'background')
  if (!a) return null
  const status = String(a.status ?? '').toLowerCase()
  if (status === 'busy' || status === 'waiting') return null
  const state = String(a.state ?? '').toLowerCase()
  if (state === 'blocked') return null
  return state === 'stopped' ? 'stopped' : 'finished'
}

/** 停下來等人的 agent：權限提示，或工作桌派出去的那次停在提問。 */
export const agentWaits = (a: AgentInfo | undefined) => !!a && (!!a.waitingFor || a.status === 'waiting' || !!a.asks)

export function stateOf(c: Omit<Case, 'state'>, verify: Verify | undefined): CaseState {
  if (!c.hasCard) return 'nocard'
  if (!saysNone(c.ask)) return 'ask'
  if (agentWaits(c.agent)) return 'reply'
  const running = !!c.agent && !c.agent.asks
  const verdict = parseVerdict(c.gate)
  // 審查結論由自動流程處理：沒擋的就過、有擋的去修；流程停下或沒有流程時才要人。
  if (verdict) {
    if (running) return 'running'
    if (c.chain?.stopped || (!c.chain && blocking(verdict) > 0)) return blocking(verdict) > 0 ? 'failed' : 'ready'
    return blocking(verdict) > 0 ? 'running' : 'ready'
  }
  if (parseGate(c.gate)) return 'gate'
  if (running) return 'running'
  if (c.chain?.stopped) return 'failed'
  if (verify && verify.command === c.verify && !verify.ok) return 'failed'
  if (saysNone(c.next)) return 'idle'
  return 'ready'
}

export function buildCase(rawRow: RegistryRow, cardText: string | null, mtime: number | null, agents: Record<string, AgentInfo>, verify: Verify | undefined): Case {
  const row = { ...rawRow, name: plain(rawRow.name) }
  const card = cardText === null ? null : parseCard(cardText)
  const root = projectRoot(row.statusPath)
  const agent = agents[root]
  const base: Omit<Case, 'state'> = {
    name: row.name, statusPath: row.statusPath, root, hasCard: card !== null, ...(row.manual ? { manual: true } : {}),
    status: plain(card?.['狀態'] ?? ''), verify: plain(verifyCommand(card?.['驗證'])), ask: plain(card?.['等你'] ?? ''), next: plain(card?.['下一步'] ?? ''), gate: plain(card?.['關卡'] ?? ''),
    updatedAt: mtime, ...(agent ? { agent } : {}),
    ...(cardText !== null && hasSpec(cardText) && !filledAc(cardText).length ? { specGap: true as const } : {}),
  }
  return { ...base, state: stateOf(base, verify) }
}

/** 工作桌的順序：先需要人的，再正在跑的，最後閒置；同狀態新的在前。 */
export function sorted(cases: readonly Case[]): Case[] {
  return [...cases].sort((a, b) => STATE[a.state].weight - STATE[b.state].weight || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

export function counts(cases: readonly Case[]): Record<CaseState, number> {
  const out = { ask: 0, reply: 0, gate: 0, failed: 0, running: 0, ready: 0, done: 0, idle: 0, nocard: 0 }
  for (const c of cases) out[c.state]++
  return out
}

/** 會搶焦點的任務：有真的任務時示範任務只是背景（教學模式）；只有示範資料時就是它們。 */
export function liveCases(cases: readonly Case[]): Case[] {
  return cases.some(c => !c.demo) ? cases.filter(c => !c.demo) : [...cases]
}

/** 現在該看的那一件：排序後第一件需要人或可做的；全部閒置就 null。 */
export function focusCase(cases: readonly Case[]): Case | null {
  const first = sorted(liveCases(cases))[0]
  return first && first.state !== 'idle' && first.state !== 'nocard' && first.state !== 'done' ? first : null
}

/** 一件任務在列表上的那句話：等你的題目、關卡、agent 等什麼、否則下一步。 */
export function summary(c: Case): string {
  if (c.state === 'ask') { const d = parseDecisions(c.ask)[0]; return d ? d.title || c.ask : c.ask }
  if (c.state === 'reply') return c.agent?.waitingFor ? `Agent 等待：${c.agent.waitingFor}` : c.agent?.last ? `Agent 提問：${c.agent.last}` : 'Agent 等待你回覆'
  if (c.state === 'gate') { const g = parseGate(c.gate)!; return g.detail || c.gate }
  if (c.state === 'nocard') return '找不到卡片'
  if (c.state === 'failed' && c.chain?.stopped) return c.chain.stopped
  const verdict = standingVerdict(c)
  if (verdict && blocking(verdict) === 0 && c.state === 'ready') return c.pr?.state === 'OPEN' ? (c.pr.ci === 'fail' ? 'PR 的 CI 失敗' : c.pr.ci === 'pending' ? 'PR 的 CI 執行中' : 'PR 可合併') : '審查通過，可開 PR'
  if (c.state === 'idle') return c.statusShort || c.status || '閒置'
  return c.next
}

/** 自上一份快照以來的變化，給動態與 toast。 */
export function events(prev: Snapshot | null, cur: Snapshot): FeedEvent[] {
  // 示範資料切換、換了專案：不是任務本身有變化，不發動態。
  if (!prev || prev.demo !== cur.demo || prev.project !== cur.project) return []
  const before = new Map(prev.cases.map(c => [c.statusPath, c]))
  const out: FeedEvent[] = []
  for (const c of cur.cases) {
    if (c.demo) continue
    const p = before.get(c.statusPath)
    const push = (text: string, tone: FeedEvent['tone']) => out.push({ at: cur.at, text, tone, card: c.statusPath })
    if (!p) { push(`${c.name} 加入工作桌`, 'subtle'); continue }
    if (c.state === 'ask' && (p.state !== 'ask' || p.ask !== c.ask)) push(`${c.name} 等你：${fit(summary(c), 40)}`, 'warning')
    else if (c.state === 'reply' && p.state !== 'reply') push(`${c.name} Agent 等待你回覆`, 'warning')
    else if (c.state === 'gate' && (p.state !== 'gate' || p.gate !== c.gate)) push(`${c.name} 進入關卡：${fit(summary(c), 40)}`, 'warning')
    else if (c.state === 'running' && p.state !== 'running') push(`${c.name} 開始執行`, 'suggestion')
    else if (p.state === 'running' && c.state !== 'running' && c.state !== 'reply') push(`${c.name} Agent 已完成`, 'subtle')
    else if (c.state === 'failed' && p.state !== 'failed') push(`${c.name} 檢查未通過`, 'error')
  }
  return out
}

/** 每件（與不屬於任何一件的）各留最近幾筆動態：忙的那件不會把別件的擠掉。 */
export const FEED_KEEP = 12

/** 新的在前；每件各留最近 FEED_KEEP 筆。 */
export function keepFeed(list: readonly FeedEvent[]): FeedEvent[] {
  const seen = new Map<string, number>()
  return list.filter(e => {
    const key = e.card ?? ''
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    return n <= FEED_KEEP
  })
}

/** 「最近」只看現在這件：屬於它的，與不屬於任何一件的（版本更新、某件已歸檔等）。 */
export function feedOf(feed: readonly FeedEvent[], focus: Case | null): FeedEvent[] {
  return feed.filter(e => !e.card || e.card === focus?.statusPath)
}

/** 已經不在工作桌上的那幾件（歸檔、換專案）的動態不會再顯示，清掉。 */
export function feedOnDesk(feed: readonly FeedEvent[], cases: readonly Case[]): FeedEvent[] {
  const onDesk = new Set(cases.map(c => c.statusPath))
  return feed.filter(e => !e.card || onDesk.has(e.card))
}

/** 示範資料：幾種常見局面（等你、執行中、閒置、關卡）。教學模式拿它的任務當「其他任務」的背景（demoCases）。 */
export function demoSnapshot(now: number): Snapshot {
  const agents: Record<string, AgentInfo> = { '/demo/beta': { name: 'desk-demo', state: 'working', status: 'busy', startedAt: now - 3 * 60_000 } }
  const card = (status: string, verify: string, ask: string, next: string, gate = '無') =>
    `<!-- DESK -->\n- 狀態：${status}\n- 檢查：${verify}\n- 等你：${ask}\n- 下一步：${next}\n- 關卡：${gate}\n<!-- /DESK -->`
  const rows: [RegistryRow, string, number][] = [
    [{ name: '主工作區（release/v1.4）', statusPath: '/demo/main/.desk/CARD.md' }, card('release/v1.4 與 origin 同步；整套測試 312 綠', '`npm test`', 'CHANGELOG 日期要現在補還是發版時補？A) 現在 B) 發版時', '等後續功能合入'), now - 20 * 60_000],
    [{ name: '訂單匯出 CSV', statusPath: '/demo/beta/.desk/CARD.md' }, card('依審查意見修正欄位順序與時區', '`npm test -- export`', '無', '依 .task/REVIEW.md 的意見修正'), now - 3 * 60_000],
    [{ name: '會員登入改版', statusPath: '/demo/gamma/.desk/CARD.md' }, card('四項修補完成，commit 3f9a2c1，PR 先擱置', '`npm run test:e2e`', '無', '無'), now - 2 * 24 * 60 * 60_000],
    [{ name: '部署流程改版', statusPath: '/demo/delta/.desk/CARD.md' }, card('切換暫緩；已合併 release/v1.3', '`make ci-lint`', '無', '切換前先備份舊映像', 'review：合併取捨已完成，請確認 node:22 釘版'), now - 5 * 60 * 60_000],
  ]
  const git = (branch: string) => ({ branch, head: 'demo' })
  const branches = ['release/v1.4', 'feature/order-csv-export', 'feature/login-redesign', 'ci/deploy-pipeline']
  const cases = rows.map(([row, text, mtime], i) => { const c = { ...buildCase(row, text, mtime, agents, undefined), git: git(branches[i]!) }; return { ...c, pipeline: pipeline(c, undefined) } })
  const iso = (ms: number) => new Date(ms).toISOString()
  return {
    at: now, demo: true, error: null, contextPercent: 34, cases,
    limits: [{ kind: 'five_hour', remaining: 78, resetsAt: iso(now + 2.5 * 3_600_000) }, { kind: 'seven_day', remaining: 31, resetsAt: iso(now + 3 * 86_400_000) }],
    versions: { live: 'v1.3.2', dev: 'v1.4' },
    containers: { total: 7, running: 7, down: [], unhealthy: [] },
    models: { session: 'claude-opus-5-5', effort: 'high', dispatch: { model: 'opus', effort: 'high' }, sync: { model: 'haiku', effort: '', fresh: true } },
  }
}

/** 教學模式的背景任務：標成示範，只能看、不搶焦點。 */
export function demoCases(now: number): Case[] {
  return demoSnapshot(now).cases.map(c => ({ ...c, demo: true }))
}

/** 指令裡的任務名找任務：先全名、再部分符合；示範任務只能看，指令找不到它們。 */
export function caseNamed(s: Snapshot | null, name: string): Case | null {
  if (!s) return null
  const q = name.trim()
  // 示範任務只能看，指令找不到它們。
  const real = s.cases.filter(c => !c.demo)
  return real.find(c => c.name === q) ?? real.find(c => c.name.includes(q)) ?? null
}

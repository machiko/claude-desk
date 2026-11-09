// 狀態模型：從卡片、檔案時間與背景 agent 推出每件任務的一個狀態詞，以及工作桌要看的順序。
// 純函式；register.tsx 負責讀。
import type { AgentInfo, Case, CaseState, FeedEvent, Snapshot, Verify } from '../types'
import type { RegistryRow } from './card'
import { filledAc, hasSpec, parseCard, parseDecisions, parseGate, projectRoot, saysNone, verifyCommand } from './card'
import { STATE } from './theme'
import { unreviewedNote, parseVerdict, blocking, isMerged, pipeline, releasingStep, standingVerdict, toFix } from './pipeline'
import { RUN_WARN_MS, spanMs } from './run-time'
import { AGENT_STOPPED, MEDIUM_FIX_NOT_SENT } from './chain'
import { LIMIT_NAME, QUOTA_RESTART, quotaHeld } from './quota-words'
import type { Limit } from './quota-words'
import { fit, plain, resetText, runMinutesText } from './text'
import { agentWaits, approvalWait, approveText } from './agents'

// 文字工具搬到 text.ts、Agent 清單解析搬到 agents.ts；呼叫端與測試照舊從這裡匯入也行。
export { STALE_MS, ago, displayWidth, elapsedText, errorLine, errorText, fit, hhmm, isNoise, isStatusLine, lastMeaningful, pad, parseOsc7501, plain, reasonLine, resetText, runMinutesText, screenLines, slugOf } from './text'
export type { Osc7501Signal, Osc7501State } from './text'
export { BEACON_ID_PREFIX, agentInfo, agentWaits, agentsByRoot, applyOscToAgent, approvalWait, approveText, askClearedOnCard, askedOnCardAtEnd, asksFor, asksQuestion, beaconAgentInfo, beaconRootOf, codeJobEnded, endedAlive, endedHow, isBeaconId, parseAgents, parseBeaconJson, rawAgents, runSeen, supersede } from './agents'
export type { AgentBeacon, EndedAlive, LastLaunch, Superseded } from './agents'

/** 模型名稱給人看：claude-opus-5-5 → Opus 5.5；別名（opus、haiku）與其他寫法原樣。 */
export function modelLabel(id: string | undefined): string {
  const raw = String(id ?? '').trim()
  const m = raw.match(/^claude-([a-z]+)-(\d+)-(\d+)(.*)$/i)
  if (!m) return raw
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}${m[4] ?? ''}`
}

/**
 * 這件的總執行時間：已結束的派工與自動檢查、還沒結束那次派工收起來的幾段（c.runMs），加上它現在這段在跑的時間
 * （min(now, c.runUntil) - c.runFrom）。跟存進去的累計同一套紀錄、同樣的封頂算（見 run-time.ts 的 runOf）。
 */
export function totalRunMs(c: Case, now: number): number {
  const running = c.runFrom !== undefined ? spanMs({ from: c.runFrom, until: c.runUntil ?? Infinity }, now) : 0
  return (c.runMs ?? 0) + running
}

/** 總執行時間超過門檻（15 分鐘）：用畫面上寫的整分數比，「15 分」不會被標成超過。 */
export const isRunLong = (c: Case, now: number): boolean => Math.floor(totalRunMs(c, now) / 60_000) > RUN_WARN_MS / 60_000

/** 卡片頭一列的「總執行 13 分」；超過 15 分加「（超過 15 分）」（hasNote 為 false 時不加，窄畫面用）；沒派過工是空字串。 */
export function runTimeText(c: Case, now: number, hasNote = true): string {
  const ms = totalRunMs(c, now)
  if (ms <= 0) return ''
  return `總執行 ${runMinutesText(ms)}${hasNote && isRunLong(c, now) ? `（超過 ${RUN_WARN_MS / 60_000} 分）` : ''}`
}

export { LIMIT_NAME, QUOTA_RESTART, QUOTA_RESTART_CATCHUP, isQuotaHold, quotaHeld, quotaLowOf } from './quota-words'
export type { Limit } from './quota-words'

/**
 * 5 小時額度剩餘（四捨五入，跟面板 header 一樣）低於門檻時的說明「5 小時額度剩 25%，低於門檻 30%」；否則空字串。
 * 剛好等於門檻不算；門檻 0（關掉）、沒有 five_hour 那條（讀不到額度）、重置時間已過（舊資料）都回空字串，不當成額度不足。
 */
export function quotaLow(limits: readonly Limit[] | undefined, threshold: number, now: number): string {
  const five = threshold > 0 ? (limits ?? []).find(l => l.kind === 'five_hour') : undefined
  if (!five || !Number.isFinite(five.remaining)) return ''
  // 重置時間已經過了：那是重置前的舊用量，等於讀不到現在的額度，不擋。
  const resets = five.resetsAt ? Date.parse(five.resetsAt) : NaN
  if (Number.isFinite(resets) && resets <= now) return ''
  const left = Math.max(0, Math.min(100, Math.round(five.remaining)))
  return left < threshold ? `${LIMIT_NAME.five_hour}額度剩 ${left}%，低於門檻 ${threshold}%` : ''
}

/**
 * 自動流程的額度煞車：額度低於門檻（quotaLow）時的暫停原因，接著寫重置時間（面板 header 同一種寫法）與接下來要做什麼
 * （預設按 g 重開；解衝突被擋下時傳 QUOTA_RESTART_CATCHUP，叫你在對話處理）；否則空字串。
 */
export function quotaHold(limits: readonly Limit[] | undefined, threshold: number, now: number, restart: string = QUOTA_RESTART): string {
  const low = quotaLow(limits, threshold, now)
  if (!low) return ''
  const five = limits!.find(l => l.kind === 'five_hour')!
  return `${low}，${resetText(five.resetsAt, now) || '重置'}${restart}`
}

export function stateOf(c: Omit<Case, 'state'>, verify: Verify | undefined): CaseState {
  if (!c.hasCard) return 'nocard'
  if (!saysNone(c.ask)) return 'ask'
  if (approvalWait(c.agent)) return 'approve'
  if (agentWaits(c.agent)) return 'reply'
  // 發版在對話裡跑（卡片寫進行中、還沒逾時）：沒有背景 Agent 也算處理中。
  if (c.releasing) return 'running'
  const running = !!c.agent && !c.agent.asks
  const verdict = parseVerdict(c.gate)
  // 審查結論由自動流程處理：沒擋的就過、有擋的去修；流程停下或沒有流程時才要人。
  // 停下時要修的 MEDIUM 也算 failed（按 g 修）；流程在走時只有 CRITICAL＋HIGH 算 running，要修的 MEDIUM 維持 ready，
  // 排隊中的修正才不會被當成「Agent 仍在執行」丟掉。
  if (verdict) {
    if (running) return 'running'
    // 額度煞車擋在過關前（例如要派資安審查、重新審查時）：卡片上的結論沒擋，但流程還沒走完，算 failed（按 g 重開）。
    // 你選了修掉的審查 MEDIUM 沒派出修正：結論沒擋，但要你按 g 重派，算 failed。
    if (c.chain?.stopped || (!c.chain && blocking(verdict) > 0)) return toFix(c, verdict) > 0 || quotaHeld(c.chain) || c.chain?.stopped === MEDIUM_FIX_NOT_SENT ? 'failed' : 'ready'
    return blocking(verdict) > 0 ? 'running' : 'ready'
  }
  if (parseGate(c.gate)) return 'gate'
  if (running) return 'running'
  if (c.chain?.stopped) return 'failed'
  if (verify && verify.command === c.verify && !verify.ok) return 'failed'
  if (saysNone(c.next)) return 'idle'
  return 'ready'
}

/**
 * 已合併（合併段過了）之後工作桌不再派 Agent：最後一次派工停在提問（asks）一定是合併前留下的，不再代表任務。
 * 拿掉那個 Agent、照卡片重算 state；停在提問的 Agent 本來就不算在跑，六段不受影響。其他情況原樣回傳。
 */
export function settleMergedAsk<T extends Case>(c: T, verify: Verify | undefined): T {
  if (!isMerged(c) || !c.agent?.asks) return c
  const { agent: _left, ...rest } = c
  return { ...rest, state: stateOf(rest, verify) } as T
}

/** 卡片「基準」欄的分支（去掉反引號）；沒有這欄、寫「無」或空白就是空字串。 */
const cardBaseOf = (card: Record<string, string> | null): string => {
  const value = plain(card?.['基準'] ?? '').replace(/`/g, '').trim()
  return saysNone(value) ? '' : value
}

/** 卡片「疊放於」欄的原卡分支：去掉反引號與 origin/（跟原卡 worktree 的分支名比對）；沒有或寫「無」是空字串。 */
const stackedOnOf = (card: Record<string, string> | null): string => {
  const value = plain(card?.['疊放於'] ?? '').replace(/`/g, '').trim().replace(/^origin\//, '')
  return saysNone(value) ? '' : value
}

/** `now`：判斷發版進行中有沒有逾時用；沒給（示範資料、只看卡片的測試）就不算發版中。 */
export function buildCase(rawRow: RegistryRow, cardText: string | null, mtime: number | null, agents: Record<string, AgentInfo>, verify: Verify | undefined, now?: number): Case {
  const row = { ...rawRow, name: plain(rawRow.name) }
  const card = cardText === null ? null : parseCard(cardText)
  const root = projectRoot(row.statusPath)
  const agent = agents[root]
  const branchBase = cardBaseOf(card)
  const stackedOn = stackedOnOf(card)
  const status = plain(card?.['狀態'] ?? '')
  const releasing = now === undefined ? null : releasingStep(status, mtime, now)
  const base: Omit<Case, 'state'> = {
    name: row.name, statusPath: row.statusPath, root, hasCard: card !== null, ...(row.manual ? { manual: true } : {}),
    status, verify: plain(verifyCommand(card?.['驗證'])), ask: plain(card?.['等你'] ?? ''), next: plain(card?.['下一步'] ?? ''), gate: plain(card?.['關卡'] ?? ''),
    ...(branchBase ? { base: branchBase } : {}), ...(stackedOn ? { stackedOn } : {}),
    updatedAt: mtime, ...(releasing ? { releasing } : {}), ...(agent ? { agent } : {}),
    ...(cardText !== null && hasSpec(cardText) && !filledAc(cardText).length ? { specGap: true as const } : {}),
  }
  return { ...base, state: stateOf(base, verify) }
}

/** 挑現在卡用的急迫度順序：先需要人的，再正在跑的，最後閒置；同狀態新的在前。全部任務清單不用它，照登錄表順序排。 */
export function sorted(cases: readonly Case[]): Case[] {
  return [...cases].sort((a, b) => STATE[a.state].weight - STATE[b.state].weight || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

export function counts(cases: readonly Case[]): Record<CaseState, number> {
  const out = { ask: 0, reply: 0, approve: 0, gate: 0, failed: 0, running: 0, ready: 0, done: 0, idle: 0, nocard: 0 }
  for (const c of cases) out[c.state]++
  return out
}

/** 會搶焦點的任務：有真的任務時示範任務只是背景（教學模式）；只有示範資料時就是它們。 */
export function liveCases(cases: readonly Case[]): Case[] {
  return cases.some(c => !c.demo) ? cases.filter(c => !c.demo) : [...cases]
}

/** 需要人的狀態：摘要列的「等你 +N」與面板的「另有 n 件等你」都算這幾種。 */
export const NEEDS_YOU: ReadonlySet<CaseState> = new Set<CaseState>(['ask', 'reply', 'approve', 'gate', 'failed'])

/** 全部任務標題列的狀態計數依序列這幾種（同 STATE 的 weight）；等回覆、等批准併進等你的 ●。 */
const TALLIED: CaseState[] = ['ask', 'gate', 'failed', 'running', 'ready', 'idle']
const TALLY_AS: Partial<Record<CaseState, CaseState>> = { reply: 'ask', approve: 'ask' }

/** 各狀態幾件（示範任務不算），件數 0 的不列。 */
export function stateCounts(cases: readonly Case[]): { state: CaseState; count: number }[] {
  const n = counts(liveCases(cases))
  const total = (s: CaseState) => n[s] + (Object.keys(TALLY_AS) as CaseState[]).filter(k => TALLY_AS[k] === s).reduce((sum, k) => sum + n[k], 0)
  return TALLIED.map(state => ({ state, count: total(state) })).filter(t => t.count > 0)
}

/** 現在卡以外還有幾件需要人（示範任務不算）。 */
export function waitingBesides(cases: readonly Case[], focus: Case | null): number {
  return liveCases(cases).filter(c => NEEDS_YOU.has(c.state) && c !== focus).length
}

/** 現在該看的那一件：排序後第一件需要人或可做的；全部閒置就 null。 */
export function focusCase(cases: readonly Case[]): Case | null {
  const first = sorted(liveCases(cases))[0]
  return first && first.state !== 'idle' && first.state !== 'nocard' && first.state !== 'done' ? first : null
}

/** 一件任務在列表上的那句話：等你的題目、關卡、agent 等什麼、否則下一步。 */
export function summary(c: Case): string {
  if (c.state === 'ask') { const d = parseDecisions(c.ask)[0]; return d ? d.title || c.ask : c.ask }
  if (c.state === 'approve') return approveText(c)
  if (c.state === 'reply') return c.agent?.waitingFor ? `Agent 等待：${c.agent.waitingFor}` : c.agent?.last ? `Agent 提問：${c.agent.last}` : 'Agent 等待你回覆'
  if (c.state === 'gate') { const g = parseGate(c.gate)!; return g.detail || c.gate }
  if (c.state === 'nocard') return '找不到卡片'
  if (c.state === 'failed' && c.chain?.stopped) return c.chain.stopped
  const verdict = standingVerdict(c)
  // 未複審過關：修完寫的關卡不算審查結論（card.ts 的 parseGate），沒有結論可看，照流程紀錄說已過關。
  const unreviewed = !!c.chain?.passed && !!c.chain.unreviewed && !c.chain.stale
  if (((verdict && toFix(c, verdict) === 0) || unreviewed) && c.state === 'ready') return c.pr?.state === 'OPEN' ? (c.pr.ci === 'fail' ? 'PR 的 CI 失敗' : c.pr.ci === 'pending' ? 'PR 的 CI 執行中' : 'PR 可合併') : unreviewed ? `${unreviewedNote(c.chain)}，可開 PR` : '驗收通過，可開 PR'
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
    const push = (text: string, tone: FeedEvent['tone'], whileState?: FeedEvent['whileState']) => out.push({ at: cur.at, text, tone, card: c.statusPath, ...(whileState ? { whileState } : {}) })
    if (!p) { push(`${c.name} 加入工作桌`, 'subtle'); continue }
    if (c.state === 'ask' && (p.state !== 'ask' || p.ask !== c.ask)) push(`${c.name} 等你：${fit(summary(c), 40)}`, 'warning', 'ask')
    else if (c.state === 'reply' && p.state !== 'reply') push(`${c.name} Agent 等待你回覆`, 'warning', 'reply')
    else if (c.state === 'approve' && p.state !== 'approve') push(`${c.name} Agent 等你批准權限`, 'warning', 'approve')
    else if (c.state === 'gate' && (p.state !== 'gate' || p.gate !== c.gate)) push(`${c.name} 進入關卡：${fit(summary(c), 40)}`, 'warning', 'gate')
    // 發版在對話裡跑，不是 Agent：說開始發版、發版步驟結束，不說開始執行、Agent 已完成或已停止。
    else if (c.releasing && !p.releasing) push(`${c.name} 開始發版`, 'suggestion')
    else if (p.releasing && !c.releasing) push(`${c.name} 發版步驟結束`, 'subtle')
    else if (c.state === 'running' && p.state !== 'running') push(`${c.name} 開始執行`, 'suggestion')
    else if (p.state === 'running' && c.state !== 'running' && c.state !== 'reply' && c.state !== 'approve') push(`${c.name} Agent ${stoppedAgent(c) ? '已停止' : '已完成'}`, 'subtle')
    // 流程暫停、檢查沒過、檢查中斷、容器沒起都已寫了原因、跳了 toast；只剩審查結論擋下、流程沒停（手動審查）要在這裡說。
    else if (c.state === 'failed' && p.state !== 'failed' && reviewBlocks(c)) push(`${c.name} 驗收有要修的問題`, 'error')
  }
  return out
}

/** 這件的 Agent 是被停掉的（面板按 k 停下流程，或 `claude stop`），不是做完：動態寫「已停止」。 */
const stoppedAgent = (c: Case): boolean => c.chain?.stopped === AGENT_STOPPED || c.lastEnded === 'stopped'

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

/** 審查結論有要修的問題、流程沒停：stateOf 因為它算成 failed，沒有別處寫原因。 */
function reviewBlocks(c: Case): boolean {
  const verdict = parseVerdict(c.gate)
  return !!verdict && blocking(verdict) > 0 && !c.chain?.stopped
}

const isIssue = (e: FeedEvent | undefined): e is FeedEvent => !!e && (e.tone === 'error' || e.tone === 'warning')

/** 淡色事件（加入工作桌、Agent 已完成、Agent 已停止）不代表問題解決了：按 k 停掉後 Agent 離開清單，不能把停止原因收掉。 */
const latest = (feed: readonly FeedEvent[], match: (e: FeedEvent) => boolean) => feed.find(e => match(e) && e.tone !== 'subtle')

/**
 * 「歷程」上方的問題列：這件最新一筆、不屬於任何一件的最新一筆（都略過淡色事件），各自是錯誤或警告才算，取比較新的那筆；沒有就 null。
 * 之後發生一般事件（檢查通過等），那筆就不再是最新，問題列跟著消失；描述狀態的警告（等你、關卡等）在卡片離開那個狀態後也不算。feed 新的在前。
 */
export function issueOf(feed: readonly FeedEvent[], focus: Case | null): FeedEvent | null {
  const found = focus ? latest(feed, e => e.card === focus.statusPath) : undefined
  const mine = found && (!found.whileState || found.whileState === focus?.state) ? found : undefined
  const global = latest(feed, e => !e.card)
  // 時間一樣時看順序：feed 新的在前，排前面的比較新。
  const candidates = [mine, global].filter(isIssue).sort((a, b) => b.at - a.at || feed.indexOf(a) - feed.indexOf(b))
  return candidates[0] ?? null
}

/** 現在這件的動態：屬於它的，與不屬於任何一件的（版本更新、某件已歸檔等）。 */
export function feedOf(feed: readonly FeedEvent[], focus: Case | null): FeedEvent[] {
  return feed.filter(e => !e.card || e.card === focus?.statusPath)
}

/** 已經不在工作桌上的那幾件（歸檔、換專案）的動態不會再顯示，清掉。 */
export function feedOnDesk(feed: readonly FeedEvent[], cases: readonly Case[]): FeedEvent[] {
  const onDesk = new Set(cases.map(c => c.statusPath))
  return feed.filter(e => !e.card || onDesk.has(e.card))
}

/** 示範資料：幾種常見局面（等你、執行中、閒置、關卡）。教學模式拿它的任務當「全部任務」的背景（demoCases）。 */
export function demoSnapshot(now: number): Snapshot {
  const agents: Record<string, AgentInfo> = { '/demo/beta': { name: 'desk-demo', state: 'working', status: 'busy', startedAt: now - 3 * 60_000 } }
  const card = (status: string, verify: string, ask: string, next: string, gate = '無') =>
    `<!-- DESK -->\n- 狀態：${status}\n- 檢查：${verify}\n- 等你：${ask}\n- 下一步：${next}\n- 關卡：${gate}\n<!-- /DESK -->`
  const rows: [RegistryRow, string, number][] = [
    [{ name: '主工作區（release/v1.4）', statusPath: '/demo/main/.desk/CARD.md' }, card('release/v1.4 與 origin 同步；整套測試 312 綠', '`npm test`', 'CHANGELOG 日期要現在補還是發版時補？A) 現在 B) 發版時', '等後續功能合入'), now - 20 * 60_000],
    [{ name: '訂單匯出 CSV', statusPath: '/demo/beta/.desk/CARD.md' }, card('依驗收意見修正欄位順序與時區', '`npm test -- export`', '無', '依 .task/REVIEW.md 的意見修正'), now - 3 * 60_000],
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

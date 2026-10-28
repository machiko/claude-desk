// 六段：規格 → 實作 → 檢查 → 審查 → 合併 → 上線。只從已經讀到的證據推算，不碰磁碟。
// 證據由後往前看：最後一段有證據，它之前的都算過了；接著第一個還沒過的就是「現在」。
import type { Case, ChainInfo, PrInfo, ReviewVerdict, Stage, StageId, StageStatus, Pipeline, Verify } from '../types'
import { ARCHIVE_WORD, SHIPPED_WORD, parseGate, saysNone } from './card'

export const STAGES: readonly { id: StageId; label: string }[] = [
  { id: 'spec', label: '規格' },
  { id: 'build', label: '實作' },
  { id: 'check', label: '檢查' },
  { id: 'review', label: '審查' },
  { id: 'merge', label: '合併' },
  { id: 'ship', label: '上線' },
]
export const STAGE_GLYPH: Record<StageStatus, string> = { done: '●', active: '◉', wait: '◆', fail: '✕', todo: '○', na: '·' }
const INDEX = Object.fromEntries(STAGES.map((s, i) => [s.id, i])) as Record<StageId, number>

/** 審查結論：關卡寫成 `review：CRITICAL 0、HIGH 1、MEDIUM 2、LOW 0；…`。四個數字缺任何一個就讀不出。 */
export function parseVerdict(gate: string | undefined): ReviewVerdict | null {
  const g = parseGate(gate)
  if (!g || g.kind !== 'review') return null
  const n = (name: string) => { const m = g.detail.match(new RegExp(`${name}\\s*[:：=]?\\s*(\\d+)`, 'i')); return m ? Number(m[1]) : null }
  const [critical, high, medium, low] = [n('CRITICAL'), n('HIGH'), n('MEDIUM'), n('LOW')]
  if (critical === null || high === null || medium === null || low === null) return null
  return { critical, high, medium, low }
}

export const blocking = (v: ReviewVerdict) => v.critical + v.high

/** 還算數的審查結論：審查之後分支有新 commit（chain.stale），卡片上那次的結論就不算。 */
export const standingVerdict = (c: Pick<Case, 'gate' | 'chain'>): ReviewVerdict | null => c.chain?.stale ? null : parseVerdict(c.gate)

/** 發版線（release/…）本身：規格、實作、審查、合併不適用，只看檢查與上線。 */
export const isReleaseLine = (c: Pick<Case, 'git'>) => !!c.git && /^release\//.test(c.git.branch)

/**
 * 真實模式可以按 t 確認規格：停在規格段、關卡是 spec：…、認得到填好的驗收情境、沒有 Agent 在跑或停著等回覆，也不是示範任務。
 * 有關卡時 state 是 gate 而不是 running，所以直接看 agent。
 */
export const awaitsSpecOk = (c: Pick<Case, 'demo' | 'agent' | 'pipeline' | 'gate' | 'specGap'>) =>
  !c.demo && !c.agent && !c.specGap && c.pipeline?.current === 'spec' && parseGate(c.gate)?.kind === 'spec'

/** 可以從面板歸檔：六段全過（finalState 已排除 Agent 在跑、等你），不是發版線，也不是示範任務。教學模式由呼叫端另外排除。 */
export const canArchive = (c: Pick<Case, 'demo' | 'state' | 'git'>) => !c.demo && c.state === 'done' && !isReleaseLine(c)

/**
 * 可以從面板按「⚑ 發版」：走到上線段、還沒有 tag 包含它，也不是示範任務。教學模式由呼叫端另外排除（教學照舊按 t 打 tag）。
 * 發版線（release/* 分支本身）不算：它不是「已合併待發版」的卡，打 tag 就是它自己的上線。
 */
export const canRelease = (c: Pick<Case, 'demo' | 'pipeline' | 'tag' | 'git' | 'pr' | 'mergedInto'>) =>
  !c.demo && c.pipeline?.current === 'ship' && !c.tag && !isReleaseLine(c) && !shipsWith(c)

/**
 * 合併進發版線（release/…）的功能卡隨那條線發版：回傳發版線的分支名，否則 null。
 * PR 已合併看 PR 的目標分支；其他（沒有 PR，或 PR 還開著、被關掉）看 git 判斷併進的分支（去掉 origin/）。發版線本身不算。
 */
export function shipsWith(c: Pick<Case, 'git' | 'pr' | 'mergedInto'>): string | null {
  if (isReleaseLine(c)) return null
  const into = c.pr?.state === 'MERGED' ? c.pr.dest : c.mergedInto?.replace(/^origin\//, '')
  return into && /^release\//.test(into) ? into : null
}

/**
 * 記下的 HEAD 之後分支有沒有新 commit。0.21.1 以前存的是分支名稱（gitProbe 讀錯），那種紀錄沒有 commit 可比，當作沒有。
 */
export function movedSince(recorded: string | undefined, git: { branch: string; head: string } | undefined): boolean {
  if (!recorded || !git?.head) return false
  return recorded !== git.head && recorded !== git.branch
}

/** 這次檢查還算數：跑的是卡片現在的指令，而且跑完後分支沒有新 commit。 */
export function checkStands(c: Pick<Case, 'verify' | 'git'>, v: Verify | undefined): boolean | null {
  if (!v || v.command !== c.verify) return null
  if (movedSince(v.head, c.git)) return null
  return v.ok
}

/**
 * 正在跑的 Agent 在做什麼：工作桌派的那一次（含啟動中）帶著種類。對不上派工的（例如在面板外開的）當作在寫程式：
 * 流程記的最後一種是上一次派工的，不是它的。
 */
export function runningKind(c: Pick<Case, 'agent'>): NonNullable<ChainInfo['lastKind']> | null {
  // 停在權限提示的 Agent 清單上仍是 status waiting，但它沒在做事，要等人批准。
  if (!c.agent || c.agent.asks || c.agent.status === 'idle' || c.agent.waitsFor === 'permission') return null
  return c.agent.kind ?? 'continue'
}

/** 會改程式的 Agent（實作、修正、回覆後接著做）：它在跑時，之前的檢查結果不能讓六段往前走。審查、同步不改程式。 */
const WRITES_CODE = new Set(['continue', 'fix', 'reply'])

/** `verifying`：完成檢查正在跑；`queued`：完成檢查在排隊。兩者都讓六段停在檢查段。 */
export function pipeline(c: Case, v: Verify | undefined, verifying = false, queued = false): Pipeline {
  const status: Record<StageId, StageStatus> = { spec: 'todo', build: 'todo', check: 'todo', review: 'todo', merge: 'todo', ship: 'todo' }
  const notes: Partial<Record<StageId, string>> = {}
  const gate = parseGate(c.gate)
  const stale = !!c.chain?.stale
  const verdict = standingVerdict(c)
  const check = checkStands(c, v)
  const release = isReleaseLine(c)
  const running = runningKind(c)
  const coding = !!running && WRITES_CODE.has(running)
  // 停在權限提示的 Agent 是做到一半被擋住：和寫程式中一樣，之前的檢查結果不能讓六段往前走（等人批准，不是待審查）。
  const busy = coding || c.agent?.waitsFor === 'permission'

  const reviewed = (verdict && blocking(verdict) === 0) || (c.chain?.passed && !stale)
  // 按 u 確認上線後關卡清成無、PR 資訊過一小時也不顯示，靠確認時寫進卡片的狀態與下一步認得它已上線。
  const confirmed = !!c.tag && (c.status.includes(`${c.tag} ${SHIPPED_WORD}`) || c.next.startsWith(ARCHIVE_WORD))
  // tag 只在走到上線段後才算數：從打了 tag 的 main 剛開的分支，HEAD 也被 tag 包含。發版線沒有審查與合併段，照算。
  const tagged = !!c.tag && (release || c.pr?.state === 'MERGED' || !!reviewed || gate?.kind === 'release' || confirmed)

  // 由後往前找最遠的「過了」證據。
  let reached = -1
  if (tagged && !(gate?.kind === 'release')) reached = INDEX.ship
  else if (c.pr?.state === 'MERGED' || tagged) reached = INDEX.merge
  else if (reviewed) reached = INDEX.review
  else if (check === true && !busy) reached = INDEX.check
  else if (check === false && !busy) reached = INDEX.build
  // 審查後有新 commit：程式已經寫了，退回檢查重來。
  else if (stale && !busy) reached = INDEX.build
  else if (!saysNone(c.next) || c.agent || c.verify) reached = c.verify && saysNone(c.ask) && gate?.kind !== 'spec' ? INDEX.spec : -1
  // 沒有 PR 可看時，git 看到 HEAD 已在基準分支裡也算合併；但只在審查過了之後（剛開的分支 HEAD 也在 base 裡）。
  // 審查後又有 commit（stale）再合併的也算：審查過、整個分支也進了基準分支。
  if (c.mergedInto && (reached === INDEX.review || stale)) reached = Math.max(reached, INDEX.merge)
  // 規格段還是範本（認不到填好的 AC）：檢查結果、審查後的新 commit 都不能讓它跳過規格段；審查過、已合併、有 tag 的照舊。
  if (c.specGap && reached < INDEX.review) reached = -1
  // 流程停住、檢查又沒通過過：卡片上的審查結論（例如 Agent 自己寫的）不能讓它跳過檢查段。已合併、已打 tag 的不管。
  const held = !!c.chain?.stopped && check !== true && !release && !tagged && c.pr?.state !== 'MERGED' && !c.mergedInto
  if (held && reached > INDEX.build) reached = INDEX.build
  // 完成檢查在跑或排隊：結果還沒出來，停在檢查段（之前在同一個 HEAD 通過過也一樣）；審查過了的不退。
  if ((verifying || queued) && !busy && reached >= INDEX.spec && reached <= INDEX.check) reached = INDEX.build
  for (let i = 0; i <= reached; i++) status[STAGES[i]!.id] = 'done'

  const current = STAGES[reached + 1]?.id ?? null
  if (current) {
    const set = (s: StageStatus, note = '') => { status[current] = s; if (note) notes[current] = note }
    switch (current) {
      case 'spec':
        if (!saysNone(c.ask)) set('wait', '待你決定')
        else if (c.specGap) set('wait', '尚缺驗收情境')
        else if (gate?.kind === 'spec') set('wait', '規格待確認')
        else set('wait', '尚缺完成檢查')
        break
      case 'build':
        if (coding) set('active', c.chain?.round ? `修正第 ${c.chain.round} 輪` : 'Agent 處理中')
        else if (c.state === 'reply') set('wait', 'Agent 等待你回覆')
        else if (c.state === 'approve') set('wait', 'Agent 等你批准權限')
        else if (c.chain?.stopped) set('fail', c.chain.stopped)
        else if (c.manual) set('todo', '手動追蹤')
        else if (c.state === 'idle') set('todo', '閒置')
        else set('wait', '可繼續實作')
        break
      case 'check':
        if (verifying || running === 'verify') set('active', '測試執行中')
        else if (queued) set('active', '排隊中')
        else if (check === false) set('fail', c.chain?.stopped ?? '檢查未通過')
        else if (held) set('fail', c.chain!.stopped!)
        else set('wait', stale ? '審查後有新 commit，需重新檢查' : '尚未執行檢查')
        break
      case 'review':
        if (running === 'review') set('active', '審查中')
        else if (verdict) set(c.chain?.stopped ? 'fail' : 'active', c.chain?.stopped ?? `CRITICAL ${verdict.critical}、HIGH ${verdict.high}，修正中`)
        else if (stale) set(c.chain?.stopped ? 'fail' : 'wait', c.chain?.stopped ?? '審查後有新 commit，待重新審查')
        else if (gate?.kind === 'review') set('wait', '審查結論缺少分級')
        else set('wait', '待審查')
        break
      case 'merge':
        if (!c.pr && c.chain?.needsHuman) set('wait', '高風險，請你看過再開 PR')
        else if (!c.pr || c.pr.state === 'DECLINED' || c.pr.state === 'SUPERSEDED') set('wait', c.pr ? 'PR 已拒絕，需重新開啟' : c.chain?.skippedReview ? '只動文件、免審查，可開 PR' : '可開 PR')
        else if (c.pr.ci === 'fail') set('fail', 'CI 失敗')
        else if (c.pr.ci === 'pending') set('active', 'CI 執行中')
        else set('wait', '可合併')
        // 審查結論是 Agent 自己寫的：照算，但註記標出來。
        if (c.chain?.selfReview && notes.merge) notes.merge += '（自審）'
        break
      case 'ship':
        if (c.tag) set('wait', `${c.tag} 已打，待確認上線`)
        else { const line = shipsWith(c); set('wait', line ? `隨 ${line} 發版，待打 tag` : '待打 tag') }
        break
    }
  }
  if (release) for (const id of ['spec', 'build', 'review', 'merge'] as StageId[]) status[id] = 'na'
  const stages: Stage[] = STAGES.map(s => ({ ...s, status: status[s.id] }))
  const effective = current && status[current] !== 'na' ? current : release ? (status.check === 'done' ? 'ship' : 'check') : null
  if (release && effective === 'check' && !notes.check) notes.check = check === false ? '檢查未通過' : verifying ? '測試執行中' : queued ? '排隊中' : '尚未執行檢查'
  if (release && effective === 'check') status.check = check === false ? 'fail' : verifying || queued ? 'active' : 'wait'
  if (release && effective === 'ship') { status.ship = c.tag && gate?.kind !== 'release' ? 'done' : 'wait'; notes.ship = c.tag ? (gate?.kind === 'release' ? `${c.tag} 已打，待確認上線` : '') : '待打 tag' }
  const done = stages.every(s => status[s.id] === 'done' || status[s.id] === 'na')
  return { stages: STAGES.map(s => ({ ...s, status: status[s.id] })), current: done ? null : effective, note: effective ? notes[effective] ?? '' : '' }
}

/** `規格● 實作◉ 檢查○ …` 的分段，給畫圖用；`compact` 只畫字形。 */
export function stageParts(p: Pipeline, compact: boolean): { text: string; status: StageStatus }[] {
  return p.stages.filter(s => s.status !== 'na').map(s => ({ text: compact ? STAGE_GLYPH[s.status] : `${s.label}${STAGE_GLYPH[s.status]}`, status: s.status }))
}

export function stageLabel(p: Pipeline): string {
  const s = p.stages.find(x => x.id === p.current)
  return s ? `${s.label}${p.note ? `・${p.note}` : ''}` : '完成'
}

export type { PrInfo }

/** 合併段過了（PR 已合併、git 看到已併進基準分支，或已打 tag）：之後只剩上線與歸檔。發版線沒有合併段，不算。 */
export const isMerged = (c: Pick<Case, 'pipeline'>) => !!c.pipeline?.stages.some(s => s.id === 'merge' && s.status === 'done')

/**
 * 有 Agent 在跑：state 是 running，或卡片「等你」有內容（state 是 ask）但 Agent 還在跑。
 * 開 PR、push 會派工，不能只看 state，否則推送 Agent 在跑時還能再派一個。
 */
export const agentBusy = (c: Pick<Case, 'state' | 'agent'>) => c.state === 'running' || !!runningKind(c)

/** 合併段還沒有可用的 PR、沒有 Agent 在跑：要派 Agent push 並開 PR。高風險改動也算（按鈕照列，第一次按只提醒看審查檔；見 turn.ts needsPrConfirm）。 */
export const needsPr = (c: Case) => c.pipeline?.current === 'merge' && !agentBusy(c) && (!c.pr || c.pr.state === 'DECLINED' || c.pr.state === 'SUPERSEDED')

/**
 * 合併段、PR 已開，分支又領先遠端（修 CI、審查後修正）：要派 Agent push。
 * 還沒有可用的 PR 時由「開 PR」一起 push，這裡不重複；示範任務、Agent 在跑、已合併都不算。
 * 遠端分支找不到（gitState 算不出領先）時不出現：PR 開著，分支一定推過，只是本機看不到。
 */
export const needsPush = (c: Case) => !c.demo && !agentBusy(c) && c.pipeline?.current === 'merge' && !isMerged(c)
  && c.pr?.state === 'OPEN' && (c.gitState?.ahead ?? 0) > 0

/**
 * 六段都過了（每段 done 或不適用）、沒有人要做的事：任務算「完成」。等你、執行中等狀態不受影響。
 * 合併之後流程停住或完成檢查沒過，分支已經進了基準分支，不再算未通過：照上線段走。
 * 規格段還是範本、六段停在規格段：流程停住或檢查沒過也不算未通過（按 g 修不了），要先寫規格。
 */
export function finalState(c: Pick<Case, 'state' | 'pipeline' | 'specGap'>): Case['state'] {
  const p = c.pipeline
  const specHeld = !!c.specGap && p?.current === 'spec'
  const state = c.state === 'failed' && (isMerged(c) || specHeld) ? 'ready' : c.state
  if (!p || p.current !== null || (state !== 'ready' && state !== 'idle')) return state
  return p.stages.every(s => s.status === 'done' || s.status === 'na') ? 'done' : state
}

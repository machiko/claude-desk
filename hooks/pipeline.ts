// 六段：規格 → 實作 → 檢查 → 審查 → 合併 → 上線。只從已經讀到的證據推算，不碰磁碟。
// 證據由後往前看：最後一段有證據，它之前的都算過了；接著第一個還沒過的就是「現在」。
import type { Case, PrInfo, ReviewVerdict, Stage, StageId, StageStatus, Pipeline, Verify } from '../types'
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

/** 這次檢查還算數：跑的是卡片現在的指令，而且跑完後分支沒有新 commit。 */
export function checkStands(c: Pick<Case, 'verify' | 'git'>, v: Verify | undefined): boolean | null {
  if (!v || v.command !== c.verify) return null
  if (c.git?.head && v.head && v.head !== c.git.head) return null
  return v.ok
}

export function pipeline(c: Case, v: Verify | undefined, verifying = false): Pipeline {
  const status: Record<StageId, StageStatus> = { spec: 'todo', build: 'todo', check: 'todo', review: 'todo', merge: 'todo', ship: 'todo' }
  const notes: Partial<Record<StageId, string>> = {}
  const gate = parseGate(c.gate)
  const stale = !!c.chain?.stale
  const verdict = standingVerdict(c)
  const check = checkStands(c, v)
  const release = isReleaseLine(c)
  const runningKind = c.agent && !c.agent.asks && c.agent.status !== 'idle' ? c.chain?.lastKind ?? 'continue' : null

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
  else if (check === true && !runningKind) reached = INDEX.check
  else if (check === false && !runningKind) reached = INDEX.build
  // 審查後有新 commit：程式已經寫了，退回檢查重來。
  else if (stale && !runningKind) reached = INDEX.build
  else if (!saysNone(c.next) || c.agent || c.verify) reached = c.verify && saysNone(c.ask) && gate?.kind !== 'spec' ? INDEX.spec : -1
  // 沒有 PR 可看時，git 看到 HEAD 已在基準分支裡也算合併；但只在審查過了之後（剛開的分支 HEAD 也在 base 裡）。
  if (reached === INDEX.review && c.mergedInto) reached = INDEX.merge
  for (let i = 0; i <= reached; i++) status[STAGES[i]!.id] = 'done'

  const current = STAGES[reached + 1]?.id ?? null
  if (current) {
    const set = (s: StageStatus, note = '') => { status[current] = s; if (note) notes[current] = note }
    switch (current) {
      case 'spec':
        if (!saysNone(c.ask)) set('wait', '待你決定')
        else if (gate?.kind === 'spec') set('wait', '規格待確認')
        else set('wait', '尚缺完成檢查')
        break
      case 'build':
        if (runningKind === 'continue' || runningKind === 'fix' || runningKind === 'reply') set('active', c.chain?.round ? `修正第 ${c.chain.round} 輪` : 'Agent 處理中')
        else if (c.state === 'reply') set('wait', 'Agent 等待你回覆')
        else if (c.chain?.stopped) set('fail', c.chain.stopped)
        else if (c.manual) set('todo', '手動追蹤')
        else if (c.state === 'idle') set('todo', '閒置')
        else set('wait', '可繼續實作')
        break
      case 'check':
        if (verifying || runningKind === 'verify') set('active', '測試執行中')
        else if (check === false) set('fail', c.chain?.stopped ?? '檢查未通過')
        else set('wait', stale ? '審查後有新 commit，需重新檢查' : '尚未執行檢查')
        break
      case 'review':
        if (runningKind === 'review') set('active', '審查中')
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
        break
      case 'ship':
        set('wait', c.tag ? `${c.tag} 已打，待確認上線` : '待打 tag')
        break
    }
  }
  if (release) for (const id of ['spec', 'build', 'review', 'merge'] as StageId[]) status[id] = 'na'
  const stages: Stage[] = STAGES.map(s => ({ ...s, status: status[s.id] }))
  const effective = current && status[current] !== 'na' ? current : release ? (status.check === 'done' ? 'ship' : 'check') : null
  if (release && effective === 'check' && !notes.check) notes.check = check === false ? '檢查未通過' : verifying ? '測試執行中' : '尚未執行檢查'
  if (release && effective === 'check') status.check = check === false ? 'fail' : verifying ? 'active' : 'wait'
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

/** 六段都過了（每段 done 或不適用）、沒有人要做的事：案子算「完成」。等你、執行中、卡住等狀態不受影響。 */
export function finalState(c: Pick<Case, 'state' | 'pipeline'>): Case['state'] {
  const p = c.pipeline
  if (!p || p.current !== null || (c.state !== 'ready' && c.state !== 'idle')) return c.state
  return p.stages.every(s => s.status === 'done' || s.status === 'na') ? 'done' : c.state
}

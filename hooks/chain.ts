// 自動流程：實作做完 → 自動檢查 → 綠了自動審查 → 有 CRITICAL／HIGH 或影響行為的 MEDIUM 自動修正，修正最多兩輪，碰不到合併與上線。
// 純函式：給它上一次派工、檢查結果、審查結論，它說下一步做什麼。
import type { ReviewVerdict } from '../types'
import type { DispatchKind } from './dispatch'
import { blocking } from './pipeline'
import type { Risk } from './risk'

export const MAX_FIX_ROUNDS = 2

/** 實作做完、要自動執行的完成檢查不是你核准過的那條：不跑，停下來等你按 v 看過。`_WHY` 是不帶按鍵說明的原因。 */
export const CHECK_CHANGED_WHY = '完成檢查的指令改過、還沒經你核准'
export const CHECK_UNAPPROVED_WHY = '完成檢查的指令還沒經你核准'
const APPROVE_HINT = '：按 v 看指令並核准，核准後流程接著走'
export const CHECK_CHANGED = CHECK_CHANGED_WHY + APPROVE_HINT
export const CHECK_UNAPPROVED = CHECK_UNAPPROVED_WHY + APPROVE_HINT
/** 流程裡的 Agent 被停掉（面板 k 或外面 `claude stop`）：不算做完，不跑檢查、不派審查或修正；它可能留下改到一半的東西，看過再重開。 */
export const AGENT_STOPPED = 'Agent 被停止，未完成；看過 worktree 後按 g 重開'
/** 停在提問的那次派工，題目已在對話處理（卡片「等你」清掉）：審查要修的不自動派修正。 */
export const ASK_HANDED_OVER = '提問已在對話處理，不自動派修正'

export type ChainRun = {
  owner: string; startedAt: number; round: number; stopped?: string; passed?: boolean
  /** 上一次派審查時的 HEAD；修正後的複審只看這之後的 diff。 */
  reviewHead?: string
  /** reviewHead 當時所在的分支；合併辨識只認「這條分支」看過的 HEAD，同一個資料夾換分支後不算。 */
  reviewBranch?: string
  /** 上一次派資安審查時的 HEAD。 */
  securityHead?: string
  /** securityHead 當時所在的分支。 */
  securityBranch?: string
  /** 過關了但要你看過（高風險）；開了 PR 就算看過。 */
  needsHuman?: string
  /** 只動文件，跳過了審查。 */
  skippedReview?: boolean
  /** 最近一次審查（或免審查過關）判定的 HEAD；分支之後有新 commit，那次的結論就不算數。 */
  judgedHead?: string
  /** judgedHead 當時所在的分支。 */
  judgedBranch?: string
  /** 這一輪是審查通過後又有新 commit 而重新檢查、審查；複審只看 reviewHead 之後的 diff，不算修正輪數。 */
  recheck?: boolean
  /** 停在檢查段（指令未核准、容器沒啟動、檢查中斷）：你排除後按 v 跑完檢查，流程接著走。 */
  heldAtCheck?: boolean
  /** 這輪修正要修的 MEDIUM 數（審查檔裡沒標「不修」「等你決定」的）；派的修正沒帶就沒有。 */
  mediumFix?: number
  /** 最近一次自動派解衝突時的 HEAD：同一個 HEAD 只自動試一次。 */
  catchupHead?: string
}
export type ChainStep =
  | { kind: 'verify' }
  | { kind: 'dispatch'; dispatch: DispatchKind; round: number; reason?: string; security?: boolean; /** 這輪修正要修的 MEDIUM 數；沒有要修的不帶。 */ medium?: number }
  | { kind: 'stop'; reason: string; atCheck?: boolean }
  | { kind: 'pass'; skipped?: boolean; needsHuman?: string }
  | null

/**
 * 流程暫停：寫下原因；只有停在檢查段的原因帶 heldAtCheck（按 v 跑完會接著走），
 * 其他原因（例如你手動停止了 Agent）把之前留下的 heldAtCheck 拿掉。
 */
export function paused(run: ChainRun, reason: string, atCheck = false): ChainRun {
  const { heldAtCheck: _, ...rest } = run
  return { ...rest, stopped: reason, ...(atCheck ? { heldAtCheck: true } : {}) }
}

/**
 * 審查結束：結論算在派審查時的 HEAD 與它所屬的分支；沒記到 HEAD 就用現在的；都沒有就沿用上一次判定的。
 * 分支跟著 HEAD 的來源走，不混用：HEAD 來自舊紀錄（沒記分支）時，分支就是空的。
 */
export function judgedAt(run: ChainRun, security: boolean, git?: { branch: string; head: string }): Pick<ChainRun, 'judgedHead' | 'judgedBranch'> {
  const [head, branch] = security ? [run.securityHead, run.securityBranch] : [run.reviewHead, run.reviewBranch]
  if (head) return { judgedHead: head, judgedBranch: branch }
  if (git?.head) return { judgedHead: git.head, judgedBranch: git.branch }
  return { judgedHead: run.judgedHead, judgedBranch: run.judgedBranch }
}

/**
 * 合併辨識的分叉點路徑只認工作桌在「這條分支」看過的 HEAD：流程紀錄的 reviewHead／judgedHead，且記下的分支就是現在的分支。
 * 流程紀錄按資料夾記，同一個資料夾從上一條分支已審的 HEAD 開新分支時，那個 HEAD 不算這條分支看過的；沒記分支的舊紀錄一律不算（退回認不出，不誤判）。
 */
export function seenHeads(run: ChainRun | undefined, branch: string | undefined): string[] {
  if (!run || !branch) return []
  return [run.reviewBranch === branch ? run.reviewHead : undefined, run.judgedBranch === branch ? run.judgedHead : undefined].filter((h): h is string => !!h)
}

/**
 * `changed`：這張卡核准過別的指令（卡片上的檢查被改過）。`stopped`：剛結束的那次是被 `claude stop` 停掉的，不是做完。
 * `mediumFix`：剛結束的審查，審查檔裡要修的 MEDIUM 數（沒標「不修」「等你決定」的）。
 */
export type ChainContext = { risk?: Risk; lastWasSecurity?: boolean; changed?: boolean; stopped?: boolean; mediumFix?: number }

/**
 * `finished`：上一次派工剛結束、還沒處理過的那種（continue／reply／review）；`check` 是之後跑的檢查結果。
 * 流程只在 `run` 存在、沒停下、沒過關時動。推送（publish）與解衝突（catchup）不在流程裡：做完或被停掉都不跑檢查、不派審查、不算修正輪。
 * 解衝突有 commit 時由「審查通過後有新 commit」的重新檢查接手，沒 commit 時面板寫原因。
 */
export function nextStep(run: ChainRun | undefined, finished: DispatchKind | null, check: boolean | null, verdict: ReviewVerdict | null, trusted: boolean, ctx: ChainContext = {}): ChainStep {
  if (!run || run.stopped || run.passed || !finished || finished === 'publish' || finished === 'catchup') return null
  // 被停掉的 Agent 做的事不完整：不能當成做完往下走（同步不在流程裡，照舊不動）。
  if (ctx.stopped && finished !== 'sync') return { kind: 'stop', reason: AGENT_STOPPED }
  const high = ctx.risk?.level === 'high' ? `高風險改動（${ctx.risk.reasons.join('、')}），審查已過，請你看過再開 PR` : undefined
  if (finished === 'continue' || finished === 'reply') {
    if (check === null) return trusted ? { kind: 'verify' } : { kind: 'stop', reason: ctx.changed ? CHECK_CHANGED : CHECK_UNAPPROVED, atCheck: true }
    if (check && ctx.risk?.level === 'low') return { kind: 'pass', skipped: true }
    if (check) return { kind: 'dispatch', dispatch: 'review', round: run.round }
    return run.round < MAX_FIX_ROUNDS ? { kind: 'dispatch', dispatch: 'continue', round: run.round + 1, reason: 'check' } : { kind: 'stop', reason: `修了 ${MAX_FIX_ROUNDS} 輪檢查仍未通過` }
  }
  if (finished === 'review') {
    if (!verdict) return { kind: 'stop', reason: '審查結論缺少 CRITICAL／HIGH／MEDIUM／LOW 分級' }
    // 影響行為的 MEDIUM 只在還有修正輪數時跟 CRITICAL／HIGH 一起修；輪數用完只剩 MEDIUM 就過關，交給「等你」。
    const medium = run.round < MAX_FIX_ROUNDS ? ctx.mediumFix ?? 0 : 0
    if (blocking(verdict) + medium === 0) {
      if (high && !ctx.lastWasSecurity) return { kind: 'dispatch', dispatch: 'review', round: run.round, security: true }
      return high ? { kind: 'pass', needsHuman: high } : { kind: 'pass' }
    }
    return run.round < MAX_FIX_ROUNDS ? { kind: 'dispatch', dispatch: 'continue', round: run.round + 1, reason: 'review', ...(medium ? { medium } : {}) } : { kind: 'stop', reason: `修了 ${MAX_FIX_ROUNDS} 輪仍有 CRITICAL ${verdict.critical}、HIGH ${verdict.high}` }
  }
  return null
}

/**
 * 那次派工停在提問、題目已在對話處理：之後由對話接手。過關與停下照舊（審查結論照記）；
 * 本來要派修正的改成停下寫原因（擋住的結論還在，不能當沒事）；跑檢查、派審查回 null，只標成處理過。
 */
export function handedOver(step: ChainStep): ChainStep {
  if (!step || step.kind === 'pass' || step.kind === 'stop') return step
  return step.kind === 'dispatch' && step.reason ? { kind: 'stop', reason: ASK_HANDED_OVER } : null
}

// 自動接力：實作做完 → 自動檢查 → 綠了自動審查 → 有 CRITICAL／HIGH 自動修正，修正最多兩輪，碰不到合併與上線。
// 純函式：給它上一次派工、檢查結果、審查結論，它說下一步做什麼。
import type { ReviewVerdict } from '../types'
import type { DispatchKind } from './dispatch'
import { blocking } from './pipeline'
import type { Risk } from './risk'

export const MAX_FIX_ROUNDS = 2

export type ChainRun = {
  owner: string; startedAt: number; round: number; stopped?: string; passed?: boolean
  /** 上一次派審查時的 HEAD；修正後的複審只看這之後的 diff。 */
  reviewHead?: string
  /** 上一次派資安審查時的 HEAD。 */
  securityHead?: string
  /** 過關了但要你看過（高風險）；開了 PR 就算看過。 */
  needsHuman?: string
  /** 只動文件，跳過了審查。 */
  skippedReview?: boolean
  /** 最近一次審查（或免審查過關）判定的 HEAD；分支之後有新 commit，那次的結論就不算數。 */
  judgedHead?: string
  /** 這一輪是審查通過後又有新 commit 而重新檢查、審查；複審只看 reviewHead 之後的 diff，不算修正輪數。 */
  recheck?: boolean
}
export type ChainStep =
  | { kind: 'verify' }
  | { kind: 'dispatch'; dispatch: DispatchKind; round: number; reason?: string; security?: boolean }
  | { kind: 'stop'; reason: string }
  | { kind: 'pass'; skipped?: boolean; needsHuman?: string }
  | null

export type ChainContext = { risk?: Risk; lastWasSecurity?: boolean }

/**
 * `finished`：上一次派工剛結束、還沒處理過的那種（continue／reply／review）；`check` 是之後跑的檢查結果。
 * 接力只在 `run` 存在、沒停下、沒過關時動。
 */
export function nextStep(run: ChainRun | undefined, finished: DispatchKind | null, check: boolean | null, verdict: ReviewVerdict | null, trusted: boolean, ctx: ChainContext = {}): ChainStep {
  if (!run || run.stopped || run.passed || !finished) return null
  const high = ctx.risk?.level === 'high' ? `高風險改動（${ctx.risk.reasons.join('、')}），審查已過，請你看過再開 PR` : undefined
  if (finished === 'continue' || finished === 'reply') {
    if (check === null) return trusted ? { kind: 'verify' } : { kind: 'stop', reason: '完成檢查尚未授權：請先按 v 執行一次，之後才會自動執行' }
    if (check && ctx.risk?.level === 'low') return { kind: 'pass', skipped: true }
    if (check) return { kind: 'dispatch', dispatch: 'review', round: run.round }
    return run.round < MAX_FIX_ROUNDS ? { kind: 'dispatch', dispatch: 'continue', round: run.round + 1, reason: 'check' } : { kind: 'stop', reason: `修了 ${MAX_FIX_ROUNDS} 輪檢查仍未通過` }
  }
  if (finished === 'review') {
    if (!verdict) return { kind: 'stop', reason: '審查結論缺少 CRITICAL／HIGH／MEDIUM／LOW 分級' }
    if (blocking(verdict) === 0) {
      if (high && !ctx.lastWasSecurity) return { kind: 'dispatch', dispatch: 'review', round: run.round, security: true }
      return high ? { kind: 'pass', needsHuman: high } : { kind: 'pass' }
    }
    return run.round < MAX_FIX_ROUNDS ? { kind: 'dispatch', dispatch: 'continue', round: run.round + 1, reason: 'review' } : { kind: 'stop', reason: `修了 ${MAX_FIX_ROUNDS} 輪仍有 CRITICAL ${verdict.critical}、HIGH ${verdict.high}` }
  }
  return null
}

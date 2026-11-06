// 自動流程：實作做完 → 自動檢查 → 綠了自動審查 → 有 CRITICAL／HIGH 自動修正（MEDIUM 交給「等你」），整條分支最多自動修兩輪，碰不到合併與上線。
// 純函式：給它上一次派工、檢查結果、審查結論，它說下一步做什麼。
import type { ReviewVerdict } from '../types'
import type { DispatchKind } from './dispatch'
import { blocking } from './pipeline'
import type { Risk } from './risk'

/** 整張卡（同一條分支）自動派修正的上限：重新驗收、按 g／w 重開都不歸零。 */
export const MAX_FIX_ROUNDS = 2
/** 上限用完後停下的那句的結尾：你可以怎麼接手。 */
const AFTER_LIMIT = '：開 PR、按 g 再修一輪，或改規格'

/** 實作做完、要自動執行的完成檢查不是你核准過的那條：不跑，停下來在檢查列列出全文，等你按兩次 v 核准。`_WHY` 是不帶按鍵說明的原因。 */
export const CHECK_CHANGED_WHY = '測試指令改過、還沒經你核准'
export const CHECK_UNAPPROVED_WHY = '測試指令還沒經你核准'
const APPROVE_HINT = '：按兩次 v 核准並執行，流程接著走'
export const CHECK_CHANGED = CHECK_CHANGED_WHY + APPROVE_HINT
export const CHECK_UNAPPROVED = CHECK_UNAPPROVED_WHY + APPROVE_HINT
/** 換詞前存進流程紀錄（$.store 的 chain.stopped）的同兩句：資料格式，只拿來比對、不顯示。 */
const LEGACY_HELD: Record<string, string> = { [`完成檢查的指令改過、還沒經你核准${APPROVE_HINT}`]: CHECK_CHANGED, [`完成檢查的指令還沒經你核准${APPROVE_HINT}`]: CHECK_UNAPPROVED }
/** 流程紀錄的停下原因給畫面用：換詞前存的兩句換成新句，更新前就停在測試段的流程照樣認得（檢查列列出指令、輪到你說新詞）。 */
export const shownStopped = (stopped: string): string => LEGACY_HELD[stopped] ?? stopped
/** 流程裡的 Agent 被停掉（面板 k 或外面 `claude stop`）：不算做完，不跑檢查、不派審查或修正；它可能留下改到一半的東西，看過再重開。 */
export const AGENT_STOPPED = 'Agent 被停止，未完成；看過 worktree 後按 g 重開'
/** 你在「等你」選了修掉審查 MEDIUM，工作桌自動派修正只試一次、確定沒派出去：流程停下，按 g 重派（g 派的就是那幾條 MEDIUM 的修正）。 */
export const MEDIUM_FIX_NOT_SENT = '你選了修掉的審查 MEDIUM 沒派出修正：按 g 重派'
/** 停在提問的那次派工，題目已在對話處理（卡片「等你」清掉）：審查要修的不自動派修正。 */
export const ASK_HANDED_OVER = '提問已在對話處理，不自動派修正'
/** 拿早先看到的流程紀錄（版本）做決定，寫入時版本已被別的對話改過：不寫，回這句。 */
export const CHAIN_CHANGED = '流程紀錄已被別的對話改過，重新整理後再試'
/** 寫完重讀，這件的版本被別的對話用舊表寫回蓋掉：最多重套這麼多次。 */
export const MAX_SAVE_RETRIES = 3
/** 連續 MAX_SAVE_RETRIES 次都被蓋掉：放棄，動態寫這句。 */
export const CHAIN_OVERWRITTEN = `流程紀錄寫入 ${MAX_SAVE_RETRIES} 次都被別的對話蓋掉，重新整理後再試`

/** 流程紀錄的版本號：舊紀錄沒有，視為 0。 */
export const revOf = (run: Pick<ChainRun, 'rev'> | undefined): number => run?.rev ?? 0

export type ChainRun = {
  /** 版本號：每次寫回加 1（舊紀錄沒有，視為 0）；帶著早先看到的版本寫入時，版本不同就不寫。 */
  rev?: number
  /** 寫入標記：每次寫回換一個（session id 加流水號）；寫後重讀時版本相同但標記不是自己的，就是被同時寫入的另一邊蓋掉。 */
  stamp?: string
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
  /** 舊紀錄：MEDIUM 還會自動修時，這輪修正要修的 MEDIUM 數。現在不再寫入，下一次寫回流程紀錄時拿掉。 */
  mediumFix?: number
  /** 這條分支（整張卡）累計派過的修正輪數（自動與你按 g 的都算）；重新驗收、按 g／w 重開流程都帶著，換分支從 0 起算。舊紀錄沒有，視為這一輪的 round。 */
  fixTotal?: number
  /** fixTotal 算的是哪條分支；跟現在的分支不同（或沒記）就不帶到新流程。 */
  fixBranch?: string
  /** 你在「等你」對審查 MEDIUM 題選了「修掉」送出時的 HEAD：對話清掉「等你」、HEAD 沒變，工作桌就派一次修正（不受上限擋，派出去才算一輪）。 */
  mediumFixAt?: string
  /** 你選修掉 MEDIUM 時，這次流程已跑過資安審查（送出時最後一次派工是資安審查）：那題可能是哪一份問的，修正提示兩份審查檔都寫。下一次選修掉時重寫。 */
  mediumFixSecurity?: boolean
  /** 最近一次自動派解衝突時的 HEAD：同一個 HEAD 只自動試一次。 */
  catchupHead?: string
  /** 額度煞車擋下的那一步（派審查、資安審查或修正）：按 g 重開時直接派這一步，不多派實作。 */
  resume?: QuotaResume
}
/** 額度煞車擋下時本來要派的那步：流程裡的派工只有實作（修正）與審查兩種。 */
export type QuotaResume = { dispatch: 'continue' | 'review'; round: number; security?: boolean; reason?: string }
export type ChainStep =
  | { kind: 'verify' }
  | { kind: 'dispatch'; dispatch: DispatchKind; round: number; reason?: string; security?: boolean }
  | { kind: 'stop'; reason: string; atCheck?: boolean; /** 額度煞車擋下的那步，按 g 直接派它。 */ resume?: QuotaResume }
  | { kind: 'pass'; skipped?: boolean; needsHuman?: string }
  | null

/** 這條分支累計派過的修正輪數：沒記總數的舊紀錄用這一輪的 round。 */
export const fixTotalOf = (run: Pick<ChainRun, 'fixTotal' | 'round'> | undefined): number => run?.fixTotal ?? run?.round ?? 0

/** 自動流程的修正真的派出去了：這條分支累計的修正輪數加 1，記下是哪條分支。 */
export function countedFix(run: ChainRun, branch: string | undefined): Pick<ChainRun, 'fixTotal' | 'fixBranch'> {
  return { fixTotal: fixTotalOf(run) + 1, ...(branch ? { fixBranch: branch } : {}) }
}

/**
 * 開新一輪流程（重新驗收、按 g／w 重開）時要帶上的累計修正數：只帶同一條分支記的；換了分支、沒記分支或還沒修過就不帶（從 0 起算）。
 * `fixed`：這次開流程就是你主動派的修正，總數再加 1（不受上限擋，但照樣算）。
 */
export function carriedFix(run: ChainRun | undefined, branch: string | undefined, fixed = false): Pick<ChainRun, 'fixTotal' | 'fixBranch'> {
  const kept = run && branch && run.fixBranch === branch ? run.fixTotal ?? 0 : 0
  const total = kept + (fixed ? 1 : 0)
  return total && branch ? { fixTotal: total, fixBranch: branch } : {}
}

/**
 * 流程暫停：寫下原因；只有停在檢查段的原因帶 heldAtCheck（按 v 跑完會接著走），
 * 其他原因（例如你手動停止了 Agent）把之前留下的 heldAtCheck 拿掉。
 */
export function paused(run: ChainRun, reason: string, atCheck = false, resume?: QuotaResume): ChainRun {
  const { heldAtCheck: _, resume: __, ...rest } = run
  return { ...rest, stopped: reason, ...(atCheck ? { heldAtCheck: true } : {}), ...(resume ? { resume } : {}) }
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
 * `quotaHold`：5 小時額度低於門檻的暫停原因（model.ts 的 quotaHold）；非空時要派 Agent 的那步改成停下，跑檢查與過關照舊。
 */
export type ChainContext = { risk?: Risk; lastWasSecurity?: boolean; changed?: boolean; stopped?: boolean; quotaHold?: string }

/**
 * `finished`：上一次派工剛結束、還沒處理過的那種（continue／reply／review）；`check` 是之後跑的檢查結果。
 * 流程只在 `run` 存在、沒停下、沒過關時動。推送（publish）與解衝突（catchup）不在流程裡：做完或被停掉都不跑檢查、不派審查、不算修正輪。
 * 解衝突有 commit 時由「審查通過後有新 commit」的重新檢查接手，沒 commit 時面板寫原因。
 */
export function nextStep(run: ChainRun | undefined, finished: DispatchKind | null, check: boolean | null, verdict: ReviewVerdict | null, trusted: boolean, ctx: ChainContext = {}): ChainStep {
  const step = plannedStep(run, finished, check, verdict, trusted, ctx)
  // 額度煞車：只擋派 Agent（花額度）；本機檢查、過關、其他停下照舊。
  if (step?.kind !== 'dispatch' || !ctx.quotaHold) return step
  // 記下被擋的那步：按 g 重開時直接派它（擋在派審查前的不用再派一個實作 Agent）。
  const resume: QuotaResume = { dispatch: step.dispatch === 'review' ? 'review' : 'continue', round: step.round, ...(step.security ? { security: true } : {}), ...(step.reason ? { reason: step.reason } : {}) }
  return { kind: 'stop', reason: ctx.quotaHold, resume }
}

/** 這條分支累計的修正輪數還沒到上限：可以再自動派一輪。 */
const mayFix = (run: ChainRun): boolean => fixTotalOf(run) < MAX_FIX_ROUNDS

function plannedStep(run: ChainRun | undefined, finished: DispatchKind | null, check: boolean | null, verdict: ReviewVerdict | null, trusted: boolean, ctx: ChainContext): ChainStep {
  if (!run || run.stopped || run.passed || !finished || finished === 'publish' || finished === 'catchup') return null
  // 被停掉的 Agent 做的事不完整：不能當成做完往下走（同步不在流程裡，照舊不動）。
  if (ctx.stopped && finished !== 'sync') return { kind: 'stop', reason: AGENT_STOPPED }
  const high = ctx.risk?.level === 'high' ? `高風險改動（${ctx.risk.reasons.join('、')}），驗收已過，請你看過再開 PR` : undefined
  if (finished === 'continue' || finished === 'reply') {
    if (check === null) return trusted ? { kind: 'verify' } : { kind: 'stop', reason: ctx.changed ? CHECK_CHANGED : CHECK_UNAPPROVED, atCheck: true }
    if (check && ctx.risk?.level === 'low') return { kind: 'pass', skipped: true }
    if (check) return { kind: 'dispatch', dispatch: 'review', round: run.round }
    return mayFix(run) ? { kind: 'dispatch', dispatch: 'continue', round: run.round + 1, reason: 'check' } : { kind: 'stop', reason: `整張卡已自動修 ${MAX_FIX_ROUNDS} 輪仍未通過測試${AFTER_LIMIT}` }
  }
  if (finished === 'review') {
    if (!verdict) return { kind: 'stop', reason: '驗收結論缺少 CRITICAL／HIGH／MEDIUM／LOW 分級' }
    // 只有 CRITICAL／HIGH 會自動修；可能影響行為的 MEDIUM 由審查寫進「等你」，流程照樣過關。
    if (blocking(verdict) === 0) {
      if (high && !ctx.lastWasSecurity) return { kind: 'dispatch', dispatch: 'review', round: run.round, security: true }
      return high ? { kind: 'pass', needsHuman: high } : { kind: 'pass' }
    }
    return mayFix(run) ? { kind: 'dispatch', dispatch: 'continue', round: run.round + 1, reason: 'review' } : { kind: 'stop', reason: `整張卡已自動修 ${MAX_FIX_ROUNDS} 輪仍有 CRITICAL ${verdict.critical}、HIGH ${verdict.high}${AFTER_LIMIT}` }
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

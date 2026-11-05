// 修正派工的提示詞：自動流程的修正輪（檢查沒過、審查要修）與手動按 g 修。
import type { Case } from '../../types'
import { AGENT_STOPPED, MAX_FIX_ROUNDS, MEDIUM_FIX_NOT_SENT } from '../chain'
import type { FixReason } from '../dispatch'
import { parseVerdict, toFix } from '../pipeline'
import { REVIEW_FILE, SECURITY_FILE } from './review'
import { isQuotaHold } from '../quota-words'

/** 要改規格才能修的 MEDIUM：不改，交給你決定。修正提示共用。 */
const MEDIUM_DECIDE = `要改規格才能修的 MEDIUM 不要改：在審查檔那條結尾標「（等你決定）」、在卡片 等你 寫成「審查 MEDIUM n 條（摘要）怎麼處理：A) 不修，記錄原因 B) 修掉 C) 改規格」，其他照修。`
const FIX_DONE = '修完 commit，卡片 關卡 改回 無，狀態寫一句修了什麼。'
/**
 * 你按 g 修審查結論：依審查檔修 CRITICAL、HIGH 與沒標「不修」「等你決定」的 MEDIUM（你主動要修的照修，不受自動修正上限擋）。
 * `file` 是要依的那一份審查檔（接在資安審查之後是 SECURITY.md，其他是 REVIEW.md），提示只寫這一份，修正的 Agent 不用猜。
 */
const reviewFixStep = (file: string) => `依 ${file} 修正所有 CRITICAL、HIGH，與沒標「不修」「等你決定」的 MEDIUM（LOW 不用修）。${MEDIUM_DECIDE}${FIX_DONE}`
/** 自動流程的審查修正：只修 CRITICAL、HIGH；MEDIUM 由你在「等你」決定，不在這輪改。 */
const autoReviewFixStep = (file: string) => `依 ${file} 修正所有 CRITICAL、HIGH（MEDIUM、LOW 不用修：MEDIUM 由你在卡片 等你 決定，不要改）。${FIX_DONE}`

/**
 * 你在「等你」對審查 MEDIUM 題選了修掉：照卡片 Decisions 修那幾條 MEDIUM（你主動要的，不受自動修正上限擋）。
 * `file` 是要看的審查檔：這次流程有跑資安審查時兩份都寫（那題可能是程式碼審查問的、資安審查問的或兩份合成的），否則只有 REVIEW.md。
 */
const mediumPickedStep = (file: string) => `你在卡片 等你 對審查 MEDIUM 選了 B) 修掉：依 ${file} 修正標「（等你決定）」、卡片 Decisions 記著你選修掉的那幾條 MEDIUM（其他 MEDIUM 與 LOW 不用修）。${FIX_DONE}`

/** 回答 B 的修正要看的審查檔：這次流程跑過資安審查就兩份都看。 */
const mediumFiles = (security?: boolean) => security ? `${REVIEW_FILE} 與 ${SECURITY_FILE}` : REVIEW_FILE

/** 自動流程修正輪的提示頭：「第 n／2 輪」是這條分支累計的修正輪數。完成檢查沒過附輸出最後幾行；審查要修就依那一份審查檔；你選了修掉 MEDIUM 的不寫輪數（不受上限擋）。 */
export function fixHead(c: Case, fix: FixReason): string {
  if (fix.from === 'medium') return `修正：${mediumPickedStep(mediumFiles(fix.security))}`
  return fix.from === 'check'
    ? `修正第 ${fix.round}／${MAX_FIX_ROUNDS} 輪：完成檢查 \`${c.verify}\` 未通過。輸出最後幾行：\n${(fix.tail ?? []).join('\n')}\n修到完成檢查綠，commit 後寫回卡片。`
    : `修正第 ${fix.round}／${MAX_FIX_ROUNDS} 輪：${autoReviewFixStep(fix.security ? SECURITY_FILE : REVIEW_FILE)}`
}

/**
 * 按 g 修、而下一步只剩等待或派審查時，派出去的開頭：說明是什麼失敗、要修到哪裡，不把等待句或派審查句原樣交出去。
 * 要不要用這個開頭（fixByG 且 idleNext）由 dispatch.ts 判斷；`ci` 是 ciFailed(c)。
 */
export function manualFixHead(c: Case, ci: boolean): string {
  if (ci) return `修正：PR #${c.pr!.id} 的 CI 失敗。先看失敗原因（gh pr checks 或平台頁面），修到 CI 會綠，commit 後寫回卡片。`
  const stopped = c.chain?.stopped
  if (stopped === MEDIUM_FIX_NOT_SENT) return `修正：${mediumPickedStep(mediumFiles(c.chain?.mediumSecurity))}`
  if (stopped === AGENT_STOPPED) return '上一個 Agent 被停止，沒做完：先看 git status、git log 與卡片歷程，把那件事做完，commit 後寫回卡片。'
  // 額度煞車擋下的：不是失敗，照擋下時的情況派（要修的照修；擋在派審查前的沒有東西要修）。
  if (isQuotaHold(stopped)) return quotaRestartHead(c)
  if (stopped) return `修正：流程已暫停（${stopped}）。看 ${REVIEW_FILE}（有的話）與完成檢查 \`${c.verify}\`，修好 CRITICAL、HIGH 與沒標「不修」「等你決定」的 MEDIUM 並讓完成檢查綠（${MEDIUM_DECIDE}），commit 後卡片 關卡 改回 無，狀態寫一句修了什麼。`
  // 審查結論還要修（CRITICAL＋HIGH，加上流程這輪要修的 MEDIUM）：檢查是過的，依審查檔修。
  const verdict = parseVerdict(c.gate)
  if (verdict && toFix(c, verdict) > 0) return `修正：${reviewFixStep(REVIEW_FILE)}`
  return `修正：完成檢查 \`${c.verify}\` 未通過。先自己跑一次看失敗原因，修到完成檢查綠，commit 後寫回卡片。`
}

/** 額度煞車擋在派驗收前、沒有東西要修時，按 g 重開派出去的開頭：不改程式，跑完成檢查、寫回卡片就結束，流程接著自動檢查與驗收。 */
export const QUOTA_NOTHING_TO_FIX = '接續：流程先前因額度不足停在派驗收前，程式不用改。先看 git status 與卡片歷程，有沒 commit 的改動就收尾 commit；跑一次完成檢查確認綠，狀態寫一句、下一步寫等驗收後結束（不要自己派審查）。'

/** 按 g 重開被額度煞車擋下的流程：審查結論還要修就依審查檔修；停在檢查段（檢查沒過）就修到綠；其他（擋在派驗收、資安審查前）沒有東西要修。 */
function quotaRestartHead(c: Case): string {
  const verdict = parseVerdict(c.gate)
  if (verdict && toFix(c, verdict) > 0) return `修正：${reviewFixStep(REVIEW_FILE)}`
  if (c.pipeline?.current !== 'review') return `修正：完成檢查 \`${c.verify}\` 未通過。先自己跑一次看失敗原因，修到完成檢查綠，commit 後寫回卡片。`
  return QUOTA_NOTHING_TO_FIX
}

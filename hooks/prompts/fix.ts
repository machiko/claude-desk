// 修正派工的提示詞：自動流程的修正輪（檢查沒過、審查要修）與手動按 g 修。
import type { Case } from '../../types'
import { AGENT_STOPPED } from '../chain'
import type { FixReason } from '../dispatch'
import { parseVerdict, toFix } from '../pipeline'
import { REVIEW_FILE, SECURITY_FILE } from './review'

/** 要改規格才能修的 MEDIUM：不改，交給你決定。修正提示共用。 */
const MEDIUM_DECIDE = `要改規格才能修的 MEDIUM 不要改：在審查檔那條結尾標「（等你決定）」、在卡片 等你 寫成「審查 MEDIUM n 條（摘要）怎麼處理：A) 不修，記錄原因 B) 修掉 C) 改規格」，其他照修。`
/**
 * 依審查檔修正：自動流程的修正輪與手動按 g 修審查結論共用。`file` 是這輪要依的那一份審查檔
 * （接在資安審查之後是 SECURITY.md，其他是 REVIEW.md），提示只寫這一份，修正的 Agent 不用猜。
 */
const reviewFixStep = (file: string) => `依 ${file} 修正所有 CRITICAL、HIGH，與沒標「不修」「等你決定」的 MEDIUM（LOW 不用修）。${MEDIUM_DECIDE}修完 commit，卡片 關卡 改回 無，狀態寫一句修了什麼。`

/** 自動流程修正輪的提示頭：完成檢查沒過附輸出最後幾行；審查要修就依那一份審查檔。 */
export function fixHead(c: Case, fix: FixReason): string {
  return fix.from === 'check'
    ? `修正第 ${fix.round}／2 輪：完成檢查 \`${c.verify}\` 未通過。輸出最後幾行：\n${(fix.tail ?? []).join('\n')}\n修到完成檢查綠，commit 後寫回卡片。`
    : `修正第 ${fix.round}／2 輪：${reviewFixStep(fix.security ? SECURITY_FILE : REVIEW_FILE)}`
}

/**
 * 按 g 修、而下一步只剩等待或派審查時，派出去的開頭：說明是什麼失敗、要修到哪裡，不把等待句或派審查句原樣交出去。
 * 要不要用這個開頭（fixByG 且 idleNext）由 dispatch.ts 判斷；`ci` 是 ciFailed(c)。
 */
export function manualFixHead(c: Case, ci: boolean): string {
  if (ci) return `修正：PR #${c.pr!.id} 的 CI 失敗。先看失敗原因（gh pr checks 或平台頁面），修到 CI 會綠，commit 後寫回卡片。`
  const stopped = c.chain?.stopped
  if (stopped === AGENT_STOPPED) return '上一個 Agent 被停止，沒做完：先看 git status、git log 與卡片歷程，把那件事做完，commit 後寫回卡片。'
  if (stopped) return `修正：流程已暫停（${stopped}）。看 ${REVIEW_FILE}（有的話）與完成檢查 \`${c.verify}\`，修好 CRITICAL、HIGH 與沒標「不修」「等你決定」的 MEDIUM 並讓完成檢查綠（${MEDIUM_DECIDE}），commit 後卡片 關卡 改回 無，狀態寫一句修了什麼。`
  // 審查結論還要修（CRITICAL＋HIGH，加上流程這輪要修的 MEDIUM）：檢查是過的，依審查檔修。
  const verdict = parseVerdict(c.gate)
  if (verdict && toFix(c, verdict) > 0) return `修正：${reviewFixStep(REVIEW_FILE)}`
  return `修正：完成檢查 \`${c.verify}\` 未通過。先自己跑一次看失敗原因，修到完成檢查綠，commit 後寫回卡片。`
}

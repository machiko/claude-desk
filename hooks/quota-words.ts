// 額度煞車的字詞與判斷：不依賴其他模組的純函式，model、pipeline、catchup、turn 共用（避開 model ↔ pipeline 的循環匯入）。

export const LIMIT_NAME: Record<string, string> = { five_hour: '5 小時', seven_day: '本週' }

export type Limit = { kind: string; remaining: number; resetsAt?: string }

/** 額度煞車的暫停原因結尾；面板「輪到你」認這個結尾，照原句顯示（不再接「看審查檔後按 g 再修一輪」）。 */
export const QUOTA_RESTART = '後按 g 重開'
/** 合併段的解衝突被擋下時的結尾：合併段沒有 g 可按，叫你在對話處理。 */
export const QUOTA_RESTART_CATCHUP = '後在對話合併基準分支、解衝突'
export const isQuotaHold = (why: string | undefined): boolean => !!why && why.startsWith(`${LIMIT_NAME.five_hour}額度剩 `) && (why.endsWith(QUOTA_RESTART) || why.endsWith(QUOTA_RESTART_CATCHUP))
/** 額度煞車原因的前半「5 小時額度剩 25%，低於門檻 30%」（不含重置時間與按 g）；不是額度煞車回空字串。 */
export const quotaLowOf = (why: string | undefined): string => isQuotaHold(why) ? why!.split('，').slice(0, 2).join('，') : ''
/** 流程被額度煞車擋在過關之前（還沒過關）：審查段不算過、面板照原因句叫你按 g。過關後才擋的（解衝突、自動推送）不算。 */
export const quotaHeld = (chain: { stopped?: string; passed?: boolean } | undefined): boolean => !!chain && !chain.passed && isQuotaHold(chain.stopped)

// 額度煞車的字詞與判斷：不依賴其他模組的純函式，model、pipeline、catchup、turn 共用（避開 model ↔ pipeline 的循環匯入）。
// 停下原因看代碼（hooks/stop-reason.ts）：更新前存的中文句由那邊的舊句表還原，一樣認得。
import { t } from './i18n'
import { quotaLowText, stopOf } from './stop-reason'
import type { StopArgs, StopCode } from './stop-reason'

export const LIMIT_NAME: Record<string, string> = { five_hour: t('quota.fiveHour'), seven_day: t('quota.sevenDay') }

export type Limit = { kind: string; remaining: number; resetsAt?: string }

/** 面板資料裡跟停下原因有關的欄位（Case.chain）。 */
type StopFields = { stopped?: string; stopCode?: StopCode; stopArgs?: StopArgs }

/** 停下原因是額度煞車（審查段的按 g 重開，或合併段叫你在對話解衝突）。 */
export const isQuotaHold = (chain: StopFields | undefined): boolean => {
  const code = stopOf(chain)?.code
  return code === 'quotaHold' || code === 'quotaHoldCatchup'
}
/** 額度煞車、而且是按 g 重開那種（合併段解衝突被擋的不是）。 */
export const restartsWithG = (chain: StopFields | undefined): boolean => stopOf(chain)?.code === 'quotaHold'
/** 額度煞車原因的前半「5 小時額度剩 25%，低於門檻 30%」（不含重置時間與按 g）；不是額度煞車回空字串。 */
export const quotaLowOf = (chain: StopFields | undefined): string => {
  const stop = stopOf(chain)
  if (stop?.code !== 'quotaHold' && stop?.code !== 'quotaHoldCatchup') return ''
  return quotaLowText(Number(stop.args?.left ?? 0), Number(stop.args?.threshold ?? 0))
}
/** 流程被額度煞車擋在過關之前（還沒過關）：審查段不算過、面板照原因句叫你按 g。過關後才擋的（解衝突、自動推送）不算。 */
export const quotaHeld = (chain: (StopFields & { passed?: boolean }) | undefined): boolean => !!chain && !chain.passed && isQuotaHold(chain)

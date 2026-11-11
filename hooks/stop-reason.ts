// 流程停下的原因：流程紀錄（$.store 的 chain.stopped／stopArgs）只存代碼與參數，畫面要顯示時才查字串目錄組句；之後換語言不用遷移紀錄。
// 更新 desk 之前停下的流程存的是中文句：讀的時候照下面凍結的舊句表還原成代碼與參數（不回寫），認不得的原樣顯示。
// 葉節點：執行期只 import 字串目錄、card.ts 的指令名與 text.ts 的時間字（三個都不 import 其他 hooks 模組）。
import { t } from './i18n'
import { CARD_CMD } from './card'
import { resetText } from './text'
import type { StopArgs, StopCode } from '../types'

// 代碼與參數的型別放在面板資料的型別檔（types/index.d.ts 要自成一份、不能 import 別的檔），這裡轉出去給 hooks 用。
export type { StopArgs, StopCode }

/** 所有停下代碼（判斷存的值是不是代碼；tests/stop-codes.test.ts 逐種列舉對它）。 */
export const STOP_CODES: ReadonlySet<string> = new Set<StopCode>([
  'checkChanged', 'checkUnapproved', 'agentStopped', 'mediumFixNotSent', 'reviewFixNotSent', 'askHandedOver',
  'fixLimitCheck', 'fixLimitReview', 'verdictMissing', 'highRisk', 'quotaHold', 'quotaHoldCatchup',
  'specGap', 'foreignChanges', 'verifyBroke', 'containersDown', 'catchupNotSent',
])

export const isStopCode = (value: unknown): value is StopCode => typeof value === 'string' && STOP_CODES.has(value)

/** 停下原因：代碼加參數（數字、名稱、分支這類不用翻譯的值）。 */
export type StopReason = { readonly code: StopCode; readonly args?: StopArgs }
/** 寫進流程紀錄的停下原因：有代碼的給 StopReason；還沒改代碼的（排隊時被拒、取消排隊這類派工訊息）照舊是句子，原樣存、原樣顯示。 */
export type StopCause = StopReason | string
/** 讀回來給畫面用的停下原因：認得的帶代碼與參數，text 是要顯示的句子。 */
export type ShownStop = { readonly code?: StopCode; readonly args?: StopArgs; readonly text: string }

/** 不帶參數的停下原因。 */
export const STOP = {
  checkChanged: { code: 'checkChanged' },
  checkUnapproved: { code: 'checkUnapproved' },
  agentStopped: { code: 'agentStopped' },
  mediumFixNotSent: { code: 'mediumFixNotSent' },
  reviewFixNotSent: { code: 'reviewFixNotSent' },
  askHandedOver: { code: 'askHandedOver' },
  verdictMissing: { code: 'verdictMissing' },
  catchupNotSent: { code: 'catchupNotSent' },
} as const satisfies Record<string, StopReason>

/** 整張卡自動修正到上限：`verdict` 有給就是審查仍有 CRITICAL／HIGH，沒給是測試仍沒過。 */
export const fixLimitStop = (rounds: number, verdict?: { critical: number; high: number }): StopReason =>
  verdict ? { code: 'fixLimitReview', args: { rounds, critical: verdict.critical, high: verdict.high } } : { code: 'fixLimitCheck', args: { rounds } }
/** 高風險改動過關、要你看過：`reasons` 是風險規則的名稱（專案設定裡的字，原樣顯示）。 */
export const highRiskStop = (reasons: readonly string[]): StopReason => ({ code: 'highRisk', args: { reasons: reasons.join(t('word.listSep')) } })
/**
 * 額度煞車：剩餘與門檻，加上停下當時的重置時間與時刻（顯示時照停下那一刻算「今天／明天 幾點重置」，跟停下時寫的句子一樣）。
 * `catchup`：擋下的是解衝突，合併段沒有 g 可按，句尾叫你在對話處理。
 */
export const quotaStop = (left: number, threshold: number, resetsAt: string | undefined, at: number, catchup = false): StopReason =>
  ({ code: catchup ? 'quotaHoldCatchup' : 'quotaHold', args: { left, threshold, at, ...(resetsAt ? { resetsAt } : {}) } })
export const specGapStop = (slug: string): StopReason => ({ code: 'specGap', args: { slug } })
export const foreignStop = (files: number): StopReason => ({ code: 'foreignChanges', args: { files } })
export const verifyBrokeStop = (error: string): StopReason => ({ code: 'verifyBroke', args: { error } })
/** 檢查要用的容器沒在跑：服務名用空白接（就是 docker compose 指令的寫法），顯示時名稱改用頓號。 */
export const containersStop = (services: readonly string[]): StopReason => ({ code: 'containersDown', args: { services: services.join(' ') } })

const num = (args: StopArgs | undefined, name: string): number => Number(args?.[name] ?? 0)
const str = (args: StopArgs | undefined, name: string): string => String(args?.[name] ?? '')

/** 額度煞車原因的前半「5 小時額度剩 25%，低於門檻 30%」。 */
export const quotaLowText = (left: number, threshold: number): string => t('stop.quotaLow', { limit: t('quota.fiveHour'), left, threshold })

/** 停下原因組成要顯示的句子。 */
export function stopText(stop: StopReason): string {
  const a = stop.args
  switch (stop.code) {
    case 'checkChanged': return t('stop.approveHint', { why: t('stop.checkChangedWhy') })
    case 'checkUnapproved': return t('stop.approveHint', { why: t('stop.checkUnapprovedWhy') })
    case 'agentStopped': return t('stop.agentStopped')
    case 'mediumFixNotSent': return t('stop.mediumFixNotSent')
    case 'reviewFixNotSent': return t('stop.reviewFixNotSent')
    case 'askHandedOver': return t('stop.askHandedOver')
    case 'fixLimitCheck': return t('stop.fixLimitCheck', { rounds: num(a, 'rounds') })
    case 'fixLimitReview': return t('stop.fixLimitReview', { rounds: num(a, 'rounds'), critical: num(a, 'critical'), high: num(a, 'high') })
    case 'verdictMissing': return t('stop.verdictMissing')
    case 'highRisk': return t('stop.highRisk', { reasons: str(a, 'reasons') })
    case 'quotaHold':
    case 'quotaHoldCatchup': {
      const low = quotaLowText(num(a, 'left'), num(a, 'threshold'))
      const reset = resetText(a?.resetsAt === undefined ? undefined : str(a, 'resetsAt'), num(a, 'at')) || t('stop.quotaResetUnknown')
      return stop.code === 'quotaHold' ? t('stop.quotaHold', { low, reset }) : t('stop.quotaHoldCatchup', { low, reset })
    }
    case 'specGap': return t('stop.specGap', { cmd: CARD_CMD, slug: str(a, 'slug') })
    case 'foreignChanges': return t('stop.foreignChanges', { files: num(a, 'files') })
    case 'verifyBroke': return t('stop.verifyBroke', { error: str(a, 'error') })
    case 'containersDown': {
      const services = str(a, 'services')
      return t('stop.containersDown', { names: services.split(' ').join(t('word.listSep')), services })
    }
    case 'catchupNotSent': return t('stop.catchupNotSent')
  }
}

/** 停下原因要顯示的句子：句子原樣、代碼組句。 */
export const causeText = (cause: StopCause): string => typeof cause === 'string' ? cause : stopText(cause)

/** 寫進流程紀錄的欄位：代碼存 stopped、參數存 stopArgs；句子原樣存 stopped。 */
export function stopFields(cause: StopCause): { stopped: string; stopArgs?: StopArgs } {
  if (typeof cause === 'string') return { stopped: cause }
  return cause.args && Object.keys(cause.args).length ? { stopped: cause.code, stopArgs: cause.args } : { stopped: cause.code }
}

/** 流程紀錄存的停下原因還原成寫入時的樣子（代碼加參數，或原句），暫停後要原樣寫回時用。 */
export function storedCause(stopped: string, stopArgs?: StopArgs): StopCause {
  return isStopCode(stopped) ? { code: stopped, ...(stopArgs ? { args: stopArgs } : {}) } : stopped
}

// ── 舊紀錄：更新前存進流程紀錄的中文句。這是資料格式，凍結不跟著目錄改（目錄換字、換語言後舊紀錄一樣認得）。──

/** 換詞前存的兩句核准句：認回代碼，顯示換成現在的說法。 */
const LEGACY_RENAMED: Readonly<Record<string, StopCode>> = {
  '完成檢查的指令改過、還沒經你核准：按兩次 v 核准並執行，流程接著走': 'checkChanged',
  '完成檢查的指令還沒經你核准：按兩次 v 核准並執行，流程接著走': 'checkUnapproved',
}
/** 不帶數字的固定句：認回代碼，原句照樣顯示。 */
const LEGACY_FIXED: Readonly<Record<string, StopCode>> = {
  '測試指令改過、還沒經你核准：按兩次 v 核准並執行，流程接著走': 'checkChanged',
  '測試指令還沒經你核准：按兩次 v 核准並執行，流程接著走': 'checkUnapproved',
  'Agent 被停止，未完成；看過 worktree 後按 g 重開': 'agentStopped',
  '你選了修掉的審查 MEDIUM 沒派出修正：按 g 重派': 'mediumFixNotSent',
  '依審查修正沒派出，失敗原因見動態：按 g 重派': 'reviewFixNotSent',
  '提問已在對話處理，不自動派修正': 'askHandedOver',
  '驗收結論缺少 CRITICAL／HIGH／MEDIUM／LOW 分級': 'verdictMissing',
  '解衝突沒派出（失敗原因見動態），排除後在對話合併基準分支、解衝突': 'catchupNotSent',
}
/** 帶數字或名稱的舊句：正規式抓出參數；額度句的重置時間是停下當時算好的字，參數只取剩餘與門檻，原句照樣顯示。 */
const LEGACY_PATTERNS: readonly { re: RegExp; read: (m: RegExpMatchArray) => StopReason }[] = [
  { re: /^整張卡已自動修 (\d+) 輪仍未通過測試：開 PR、按 g 再修一輪，或改規格$/, read: m => fixLimitStop(Number(m[1])) },
  { re: /^整張卡已自動修 (\d+) 輪仍有 CRITICAL (\d+)、HIGH (\d+)：開 PR、按 g 再修一輪，或改規格$/, read: m => fixLimitStop(Number(m[1]), { critical: Number(m[2]), high: Number(m[3]) }) },
  { re: /^5 小時額度剩 (\d+)%，低於門檻 (\d+)%，[^]*後按 g 重開$/, read: m => ({ code: 'quotaHold', args: { left: Number(m[1]), threshold: Number(m[2]) } }) },
  { re: /^5 小時額度剩 (\d+)%，低於門檻 (\d+)%，[^]*後在對話合併基準分支、解衝突$/, read: m => ({ code: 'quotaHoldCatchup', args: { left: Number(m[1]), threshold: Number(m[2]) } }) },
  { re: /^規格沒有驗收情境：先輸入 \S+ spec (\S+)$/, read: m => specGapStop(m[1]!) },
  { re: /^worktree 有未提交的改動（(\d+) 個檔），不是上一個 Agent 留下的；可能有別的對話在改，commit 或還原後再派$/, read: m => foreignStop(Number(m[1])) },
  { re: /^測試中斷：([^]*)$/, read: m => verifyBrokeStop(m[1]!) },
  { re: /^容器 .+ 未啟動，請先在主工作區執行 docker compose up -d (.+)$/, read: m => containersStop(m[1]!.split(' ')) },
]

/** 舊句還原成代碼與參數；認不得回 null。 */
function legacyStop(sentence: string): { stop: StopReason; renamed: boolean } | null {
  const renamed = LEGACY_RENAMED[sentence]
  if (renamed) return { stop: { code: renamed }, renamed: true }
  const fixed = LEGACY_FIXED[sentence]
  if (fixed) return { stop: { code: fixed }, renamed: false }
  for (const { re, read } of LEGACY_PATTERNS) {
    const m = sentence.match(re)
    if (m) return { stop: read(m), renamed: false }
  }
  return null
}

/**
 * 流程紀錄的停下原因給畫面用：代碼組成句子；舊紀錄的中文句認得就帶上代碼與參數（換詞前的兩句顯示成新說法，其他原句照樣顯示），
 * 認不得的原樣顯示、不帶代碼。沒停下回 undefined。
 */
export function readStop(stopped: string | undefined, stopArgs?: StopArgs): ShownStop | undefined {
  if (!stopped) return undefined
  if (isStopCode(stopped)) {
    const stop: StopReason = { code: stopped, ...(stopArgs ? { args: stopArgs } : {}) }
    return { ...stop, text: stopText(stop) }
  }
  const legacy = legacyStop(stopped)
  if (!legacy) return { text: stopped }
  return { ...legacy.stop, text: legacy.renamed ? stopText(legacy.stop) : stopped }
}

/**
 * 面板資料（Case.chain）的停下代碼：組資料時帶的 stopCode；沒帶的（直接給句子的舊資料）照舊句表認。
 * 給判斷「是哪一種停下」的地方用，不要再拿 stopped 的句子去比。
 */
export function stopCodeOf(chain: { stopped?: string; stopCode?: StopCode } | undefined): StopCode | undefined {
  if (!chain?.stopped) return undefined
  return chain.stopCode ?? readStop(chain.stopped)?.code
}

/** 同上，連參數一起（額度煞車要剩餘與門檻）。 */
export function stopOf(chain: { stopped?: string; stopCode?: StopCode; stopArgs?: StopArgs } | undefined): StopReason | undefined {
  if (!chain?.stopped) return undefined
  if (chain.stopCode) return { code: chain.stopCode, ...(chain.stopArgs ? { args: chain.stopArgs } : {}) }
  const shown = readStop(chain.stopped)
  return shown?.code ? { code: shown.code, ...(shown.args ? { args: shown.args } : {}) } : undefined
}

// 工作桌的設計語彙：語意色（跟著使用者主題）、狀態字形、文案（字從字串目錄 hooks/i18n 取，物件形狀不變）。
// 色彩只在「需要人」「正在跑」「好」「壞」四處出現；其他都是文字本身的輕重。
import type { CaseState, StageStatus } from '../types'
import { t } from './i18n'

export const COLOR = {
  text: 'text',
  dim: 'subtle',
  faint: 'inactive',
  attention: 'warning',
  running: 'suggestion',
  good: 'success',
  bad: 'error',
} as const

export const STATE: Record<CaseState, { glyph: string; label: string; color: string; weight: number }> = {
  ask: { glyph: '●', label: t('state.ask'), color: COLOR.attention, weight: 0 },
  reply: { glyph: '●', label: t('state.reply'), color: COLOR.attention, weight: 1 },
  /** Agent 停在權限提示：要到 claude agents 批准，不是回覆。 */
  approve: { glyph: '●', label: t('state.approve'), color: COLOR.attention, weight: 1 },
  gate: { glyph: '◆', label: t('state.gate'), color: COLOR.attention, weight: 2 },
  failed: { glyph: '✕', label: t('state.failed'), color: COLOR.bad, weight: 3 },
  running: { glyph: '▶', label: t('state.running'), color: COLOR.running, weight: 4 },
  /** 圖示不用「▸」：清單上的「▸」只代表你選的那件。 */
  ready: { glyph: '▷', label: t('state.ready'), color: COLOR.text, weight: 5 },
  /** 六段全部過了（已上線、上線已確認）：排在待辦之後，可歸檔。 */
  done: { glyph: '✓', label: t('state.done'), color: COLOR.good, weight: 6 },
  idle: { glyph: '○', label: t('state.idle'), color: COLOR.faint, weight: 7 },
  nocard: { glyph: '·', label: t('state.nocard'), color: COLOR.faint, weight: 8 },
}

/** 摘要列上有數字才顯示的狀態，依序。 */
export const BAND_STATES: CaseState[] = ['ask', 'reply', 'approve', 'gate', 'failed', 'running', 'ready']

export const SPINNER = ['◐', '◓', '◑', '◒']
/** 現在卡每一列最左邊的狀態色邊條。 */
export const EDGE = '▎'
/** 六段裡進行中那段：執行中時在兩個字形間交替，看得出在動。 */
export const ACTIVE_PULSE = ['◉', '◎']

export const WORD = {
  brand: 'desk',
  nowPicked: t('word.nowPicked'),
  nowAuto: t('word.nowAuto'),
  all: t('word.all'),
  list: t('word.list'),
  /** 現在卡上方區段標題後接：現在卡以外還有幾件需要人。 */
  othersWaiting: (n: number) => t('word.othersWaiting', { n }),
  /** 選了任務時區段標題後接「<任務名> · 」這句。 */
  pickedNote: t('word.pickedNote'),
  deselect: t('word.deselect'),
  history: t('word.history'),
  /** 沒有任務時的空狀態：每列照說明頁的寫法「做什麼（什麼時候用）」。 */
  empty: t('word.empty'),
  loading: t('word.loading'),
  off: t('word.off'),
  verify: t('word.verify'),
  open: t('word.open'),
  fill: t('word.fill'),
  refresh: t('word.refresh'),
  updateTo: t('word.updateTo'),
  checkUpdate: t('word.checkUpdate'),
  updating: t('word.updating'),
  upToDate: t('word.upToDate'),
  readAt: t('word.readAt'),
  createRegistry: t('word.createRegistry'),
  /** 讀不到登錄表時，紅字下那行。 */
  retryRegistry: t('word.retryRegistry'),
  hide: t('word.hide'),
  /** 執行中鎖住的動作：標籤後面接這句，不能按。 */
  busyLocked: t('word.busyLocked'),
  /** 處理端擋下時的 toast：「<任務名>：Agent 處理中，完成後再<動作>」。 */
  busyRefused: t('word.busyRefused'),
} as const

/** 六段各狀態的顏色：摘要列、面板與現在卡的六段都用它。 */
export const STAGE_COLOR: Record<StageStatus, string> = { done: COLOR.dim, active: COLOR.running, wait: COLOR.attention, fail: COLOR.bad, todo: COLOR.faint, na: COLOR.faint }

/** 示範任務被按了會改東西的鍵：派工、檢查與卡片動作都跳這句。 */
export const DEMO_ONLY = t('word.demoOnly')

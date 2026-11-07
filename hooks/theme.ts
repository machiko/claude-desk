// 工作桌的設計語彙：語意色（跟著使用者主題）、狀態字形、文案。
// 色彩只在「需要人」「正在跑」「好」「壞」四處出現；其他都是文字本身的輕重。
import type { CaseState, StageStatus } from '../types'

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
  ask: { glyph: '●', label: '等你', color: COLOR.attention, weight: 0 },
  reply: { glyph: '●', label: '等回覆', color: COLOR.attention, weight: 1 },
  /** Agent 停在權限提示：要到 claude agents 批准，不是回覆。 */
  approve: { glyph: '●', label: '等批准', color: COLOR.attention, weight: 1 },
  gate: { glyph: '◆', label: '關卡', color: COLOR.attention, weight: 2 },
  failed: { glyph: '✕', label: '失敗', color: COLOR.bad, weight: 3 },
  running: { glyph: '▶', label: '處理中', color: COLOR.running, weight: 4 },
  /** 圖示不用「▸」：清單上的「▸」只代表你選的那件。 */
  ready: { glyph: '▷', label: '待辦', color: COLOR.text, weight: 5 },
  /** 六段全部過了（已上線、上線已確認）：排在待辦之後，可歸檔。 */
  done: { glyph: '✓', label: '已上線', color: COLOR.good, weight: 6 },
  idle: { glyph: '○', label: '閒置', color: COLOR.faint, weight: 7 },
  nocard: { glyph: '·', label: '無卡片', color: COLOR.faint, weight: 8 },
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
  nowPicked: '現在 · 你選的',
  nowAuto: '現在 · 自動挑選',
  all: '任務',
  list: '全部任務',
  /** 現在卡上方區段標題後接：現在卡以外還有幾件需要人。 */
  othersWaiting: (n: number) => `另有 ${n} 件等你`,
  /** 選了任務時區段標題後接「<任務名> · 」這句。 */
  pickedNote: '之後每則對話都附上它的卡',
  deselect: '✕ 取消選取',
  history: '歷程',
  /** 沒有任務時的空狀態：每列照說明頁的寫法「做什麼（什麼時候用）」。 */
  empty: '尚無任務（還沒開過卡）\n輸入 /desk tutorial 看教學（第一次用時）\n輸入 /desk:card new <分支> <任務名> 開第一張卡（要開始做一件事時）',
  loading: '讀取任務中…',
  off: '此對話未開啟工作桌；輸入 /desk 開啟。',
  verify: '測試',
  open: '開啟',
  fill: '填入決策',
  refresh: '重新整理',
  updateTo: '更新到',
  checkUpdate: '檢查並更新',
  updating: '更新中…',
  upToDate: '已是最新版本',
  readAt: '讀取',
  createRegistry: '建立空的登錄表',
  /** 讀不到登錄表時，紅字下那行。 */
  retryRegistry: '排除後輸入 /desk refresh 重讀',
  hide: '收起',
  /** 執行中鎖住的動作：標籤後面接這句，不能按。 */
  busyLocked: '（處理中，完成後可用）',
  /** 處理端擋下時的 toast：「<任務名>：Agent 處理中，完成後再<動作>」。 */
  busyRefused: 'Agent 處理中，完成後再',
} as const

/** 六段各狀態的顏色：摘要列、面板與現在卡的六段都用它。 */
export const STAGE_COLOR: Record<StageStatus, string> = { done: COLOR.dim, active: COLOR.running, wait: COLOR.attention, fail: COLOR.bad, todo: COLOR.faint, na: COLOR.faint }

/** 示範任務被按了會改東西的鍵：派工、檢查與卡片動作都跳這句。 */
export const DEMO_ONLY = '示範任務只能看；請照教學那件的指示操作'

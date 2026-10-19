// 工作桌的設計語彙：語意色（跟著使用者主題）、狀態字形、文案。
// 色彩只在「需要人」「正在跑」「好」「壞」四處出現；其他都是文字本身的輕重。
import type { CaseState } from '../types'

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
  gate: { glyph: '◆', label: '關卡', color: COLOR.attention, weight: 2 },
  failed: { glyph: '✕', label: '失敗', color: COLOR.bad, weight: 3 },
  running: { glyph: '▶', label: '進行中', color: COLOR.running, weight: 4 },
  ready: { glyph: '▸', label: '待辦', color: COLOR.text, weight: 5 },
  /** 六段全部過了（已上線、上線已確認）：排在待辦之後，可歸檔。 */
  done: { glyph: '✓', label: '已上線', color: COLOR.good, weight: 6 },
  idle: { glyph: '○', label: '閒置', color: COLOR.faint, weight: 7 },
  nocard: { glyph: '·', label: '無卡片', color: COLOR.faint, weight: 8 },
}

/** 摘要列上有數字才顯示的狀態，依序。 */
export const BAND_STATES: CaseState[] = ['ask', 'reply', 'gate', 'failed', 'running', 'ready']

export const SPINNER = ['◐', '◓', '◑', '◒']

export const WORD = {
  brand: 'desk',
  now: '現在',
  all: '案子',
  others: '其他案子',
  feed: '最近',
  empty: '尚無案子：請在登錄表新增一列，或輸入 /desk demo 查看示範。',
  loading: '讀取案子中…',
  off: '此對話未開啟工作桌；輸入 /desk 開啟。',
  verify: '檢查',
  open: '開啟',
  fill: '填入決策',
  refresh: '重新整理',
  update: '更新版本',
  hide: '收起',
} as const

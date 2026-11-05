// 動作表：footer 上每個動作的單鍵、圖示與標籤只寫在這裡；保留鍵、「▶ 輪到你」的鍵與 footer 的按鈕都由它導出。
// 新加動作先登記在這張表（tests/turn-actions-gate.test.tsx 會檢查「輪到你」那句與 footer 一致）。
import { KIND_LABEL } from './kind-label'
import { WORD } from './theme'

export type ActionId = 'fill' | 'unqueue' | 'continue' | 'review' | 'sync' | 'reply' | 'stop' | 'logs' | 'review-file' | 'pr' | 'open-pr' | 'push' | 'verify' | 'ship' | 'open' | 'spec-ok' | 'archive' | 'release' | 'tutorial'

/** 一個動作：單鍵、圖示、標籤（現有按鈕的字樣）。教學的標籤跟著那一步換（TUTORIAL_STEP_LABEL），這裡不寫。 */
export type ActionDef = { hotkey?: string; glyph?: string; label?: string }

/** 停止與取消排隊同為 k（派工排隊中沒有 Agent 可停）、確認規格與教學同為 t（教學模式不列確認規格），表允許重複。 */
export const ACTIONS: Readonly<Record<ActionId, ActionDef>> = {
  fill: { hotkey: 'f', glyph: '✎', label: WORD.fill },
  unqueue: { hotkey: 'k', glyph: '■', label: '取消排隊' },
  continue: { hotkey: 'g', glyph: '▶', label: KIND_LABEL.continue },
  review: { hotkey: 'w', glyph: '◆', label: KIND_LABEL.review },
  sync: { hotkey: 's', glyph: '↻', label: KIND_LABEL.sync },
  reply: { hotkey: 'y', glyph: '↩', label: KIND_LABEL.reply },
  stop: { hotkey: 'k', glyph: '■', label: '停止' },
  logs: { hotkey: 'l', glyph: '≡', label: '輸出' },
  'review-file': { hotkey: 'e', glyph: '↗', label: '審查檔' },
  pr: { hotkey: 'p', glyph: '↗', label: 'PR' },
  'open-pr': { hotkey: 'n', glyph: '⇡', label: '開 PR' },
  push: { hotkey: 'n', glyph: '⇡', label: 'push' },
  verify: { hotkey: 'v', glyph: '▶', label: WORD.verify },
  ship: { hotkey: 'u', glyph: '✓', label: '上線確認' },
  open: { hotkey: 'o', glyph: '↗', label: WORD.open },
  'spec-ok': { hotkey: 't', glyph: '✓', label: '確認規格' },
  archive: { hotkey: 'q', glyph: '⌫', label: '歸檔' },
  release: { hotkey: 'z', glyph: '⚑', label: '發版' },
  tutorial: { hotkey: 't' },
}

/** 動作的單鍵。 */
export const HOTKEY = (id: ActionId): string | undefined => ACTIONS[id].hotkey

/** 按鈕平常的字樣：「圖示 標籤」。 */
export const actionText = (id: ActionId): string => `${ACTIONS[id].glyph ?? ''} ${ACTIONS[id].label ?? ''}`.trim()

/** 面板本身的鍵：重新整理、展開、更多動作、說明、隱藏摘要列（pane.tsx 的 footer 與說明頁）。 */
export const PANE_KEYS: readonly string[] = ['r', 'x', 'm', 'i', 'h']

/** 列上的動作鍵；決策選項若撞到這些字母就只能用點的（tests/stage-actions.test.tsx 守門）。 */
export const RESERVED: ReadonlySet<string> = new Set([...Object.values(ACTIONS).flatMap(a => (a.hotkey ? [a.hotkey] : [])), ...PANE_KEYS])

/** 動作 id 照 footer 排列的順序。 */
export const ACTION_ORDER: readonly ActionId[] = ['fill', 'unqueue', 'continue', 'review', 'reply', 'sync', 'stop', 'logs', 'review-file', 'pr', 'release', 'open-pr', 'push', 'verify', 'ship', 'spec-ok', 'archive', 'tutorial', 'open']

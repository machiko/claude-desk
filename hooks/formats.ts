// 格式版本：卡片、dispatch.json、登錄表各自的版號與標記（docs/FORMATS.md）。純函式，不碰磁碟。
// 沒有標記的檔一律視為格式 1，不自動補標記；讀到比這版認得的新的格式時，面板動態警告一次、這張卡不派工，card.py 拒絕寫卡。
// skills/card/scripts/card.py 有同樣的常數與讀法（CARD_FORMAT、card_format），scripts/tests/test_formats_doc.py 核對兩端與文件一致。
import type { FeedEvent } from '../types'

/** 這版 desk 寫出、也認得的卡片格式：DESK 區塊開頭標記寫 `<!-- DESK 格式=1：…-->`。 */
export const CARD_FORMAT = 1
/** dispatch.json 的格式：頂層 `"format": 1`（沒寫也是 1）。 */
export const SETTINGS_FORMAT = 1
/** 登錄表的格式：第一行標題之後一行 `<!-- desk 登錄表 格式=1 -->`。 */
export const REGISTRY_FORMAT = 1

/** 區塊開頭標記（`<!-- DESK …-->`、舊的 `<!-- CARD …-->`）裡的「格式=n」；開頭標記的認法跟 parseCard 相同。 */
const CARD_OPENER = /<!--\s*(?:DESK|CARD)([^>]*)-->/
const REGISTRY_MARK = /<!--\s*desk\s+登錄表([^>]*)-->/
const VERSION = /格式\s*[=＝]\s*([0-9]+)/

const versionIn = (marker: string | undefined): number => {
  const m = (marker ?? '').match(VERSION)
  const n = m ? Number(m[1]) : NaN
  return Number.isInteger(n) && n >= 1 ? n : 1
}

/** 卡片的格式版號：區塊開頭標記的「格式=n」；沒有標記、沒有區塊都是 1。 */
export function cardFormat(text: string): number {
  return versionIn(text.match(CARD_OPENER)?.[1])
}

/** 登錄表的格式版號：`<!-- desk 登錄表 格式=n -->`；沒有標記是 1。 */
export function registryFormat(text: string): number {
  return versionIn(text.match(REGISTRY_MARK)?.[1])
}

/** 比這版認得的新的卡片擋派工時的原因：手動派工的拒絕、面板「輪到你」都用這句。 */
export const NEWER_CARD_WHY = '這張卡是較新版 desk 的格式'
/** 拒絕句後面接的下一步。 */
export const UPDATE_DESK_NEXT = '輸入 /desk update 更新 desk'

/** 一份比這版認得的新的檔：卡片（帶任務名）或登錄表。 */
export type NewerFormat = { kind: 'card' | 'registry'; path: string; format: number; name?: string }
/** 已報過的較新格式：`<kind>:<路徑>` → 報過的版號。跟動態放在同一處，動態清掉時一起清（教學開始／結束）；/desk off 不清動態，紀錄也留著。 */
export type FormatsSeen = Record<string, number>

const keyOf = (f: NewerFormat) => `${f.kind}:${f.path}`

/** 動態的那一句。 */
export function newerFormatText(f: NewerFormat): string {
  return f.kind === 'card'
    ? `「${f.name ?? f.path}」${NEWER_CARD_WHY}（格式 ${f.format}），請更新 desk；這張卡照常顯示但不派工`
    : `登錄表 ${f.path} 是較新版 desk 的格式（格式 ${f.format}），請更新 desk`
}

/**
 * 這一輪的較新格式動態（純函式）：同一份檔、同一個版號只報一次；檔已回到認得的格式（更新了 desk 或改了檔）就從紀錄拿掉，
 * 之後再變成較新的格式會再報。回傳要記下的紀錄與這一輪的動態。
 */
export function newerFormatNotices(found: readonly NewerFormat[], seen: FormatsSeen, at: number): { seen: FormatsSeen; events: FeedEvent[] } {
  const next: FormatsSeen = Object.fromEntries(found.map(f => [keyOf(f), f.format]))
  const events = found.filter(f => seen[keyOf(f)] !== f.format).map((f): FeedEvent => ({
    at, text: newerFormatText(f), tone: 'warning', ...(f.kind === 'card' ? { card: f.path } : {}),
  }))
  return { seen: next, events }
}

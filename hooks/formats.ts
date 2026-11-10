// 格式版本：卡片、dispatch.json、登錄表各自的版號與標記（docs/FORMATS.md）。純函式，不碰磁碟。
// 沒有標記的檔一律視為格式 1，不自動補標記；讀到比這版認得的新的格式時，面板動態警告一次、這張卡不派工，card.py 拒絕寫卡。
// skills/card/scripts/card.py 有同樣的常數與讀法（CARD_FORMAT、card_format），scripts/tests/test_formats_doc.py 核對兩端與文件一致。
// 標記裡的「格式=n」「desk 登錄表」是解析契約（正規式），不搬進字串目錄；給人看的句子在 hooks/i18n/zh-TW.ts 的 formats.*。
import type { FeedEvent } from '../types'
import { t } from './i18n'

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
export const NEWER_CARD_WHY = t('formats.newerCardWhy')
/** 拒絕句後面接的下一步。 */
export const UPDATE_DESK_NEXT = t('formats.updateDeskNext')

/** 一份比這版認得的新的檔：卡片（帶任務名）或登錄表。 */
export type NewerFormat = { kind: 'card' | 'registry'; path: string; format: number; name?: string }
/** 已報過的較新格式：`<kind>:<路徑>` → 報過的版號。跟動態放在同一處，動態清掉時一起清（教學開始／結束）；/desk off 不清動態，紀錄也留著。 */
export type FormatsSeen = Record<string, number>

const keyOf = (f: NewerFormat) => `${f.kind}:${f.path}`

/** 動態的那一句。 */
export function newerFormatText(f: NewerFormat): string {
  return f.kind === 'card'
    ? t('formats.newerCard', { name: f.name ?? f.path, why: NEWER_CARD_WHY, format: f.format })
    : t('formats.newerRegistry', { path: f.path, format: f.format })
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

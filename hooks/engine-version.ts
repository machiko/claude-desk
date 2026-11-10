// Claude Code 最低版本檢查：互動對話開始時看引擎版本，比 desk 支援的舊（或讀不到）就提示一次要更新到哪一版；只提示，不擋 desk 啟動。
// 每個引擎版本只報一次，報過的版號記在 $.store（各對話共用），重開對話、重新載入都不再報；換成另一個仍太舊的版本才再報。
// 教學開始／結束會清掉動態：教學結束時把目前版本該有的那行補回動態（engineWarningLine），不再跳 toast、不改報過的紀錄。
// 最低版本跟 README「需要什麼」與 CI 安裝的版本是同一個，三處一起改（scripts/tests/test_min_claude_code_version.py 會比對）。
// 跨檔傳 $ 的函式一律用 function 宣告（箭頭函式會被引擎掃描拒絕載入）。

import { t } from './i18n'
import { compareVersions } from './update'

export const MIN_CLAUDE_CODE = '2.1.302'
/** 報過的引擎版號（讀不到版本時是 UNKNOWN_VERSION）。 */
export const ENGINE_NOTIFIED_KEY = 'engineVersionNotified'
/** 讀不到版本時記在 store 的版號：只報一次。 */
export const UNKNOWN_VERSION = 'unknown'

export const tooOldText = (version: string) => t('engineVersion.tooOld', { version, min: MIN_CLAUDE_CODE })
export const unknownVersionText = t('engineVersion.unknown', { min: MIN_CLAUDE_CODE })

export type VersionNotice = { key: string; text: string }

/**
 * 要不要報版本：version 是引擎版本（讀不到是 null），notified 是上次報過的版號。
 * 開發版（`2.1.302-dev`）的 `-` 後綴不看，等於或高於最低版本就不報；已經報過同一個版號也不報。
 */
export function versionNotice(version: string | null, notified: string | null): VersionNotice | null {
  const key = version?.trim() || UNKNOWN_VERSION
  if (key === notified) return null
  if (key === UNKNOWN_VERSION) return { key, text: unknownVersionText }
  if (compareVersions(key, MIN_CLAUDE_CODE) >= 0) return null
  return { key, text: tooOldText(key) }
}

/** 讀引擎版本：有 base（`2.1.280`、`2.1.280-dev`）就用 base，沒有就用完整版號；版本 API 不存在或丟錯回 null。 */
async function engineVersion($: any): Promise<string | null> {
  try {
    const v = await $.session.version().catch(() => null)
    const base = typeof v?.base === 'string' && v.base.trim() ? v.base : null
    return base ?? (typeof v?.version === 'string' && v.version.trim() ? v.version : null)
  } catch {
    return null
  }
}

/**
 * 目前引擎版本該有的那句警告（夠新回 null），不看也不記 store 的報過紀錄：教學結束清掉動態後補回那一行用。
 * 讀不到版本時是讀不到的那句；出錯回 null，不丟例外。
 */
export async function engineWarningLine($: any): Promise<string | null> {
  try {
    return versionNotice(await engineVersion($), null)?.text ?? null
  } catch {
    return null
  }
}

/** 互動對話開始時呼叫：要報就先記下版號、回傳要報的那句；不用報或出錯回 null，不丟例外。 */
export async function checkEngineVersion($: any): Promise<VersionNotice | null> {
  try {
    const version = await engineVersion($)
    const notified = await $.store.get(ENGINE_NOTIFIED_KEY).catch(() => null)
    const notice = versionNotice(version, typeof notified === 'string' ? notified : null)
    // 記不下來（store 寫入失敗）照樣報，下個對話會再報一次。
    if (notice) await $.store.set(ENGINE_NOTIFIED_KEY, notice.key).catch(() => false)
    return notice
  } catch {
    return null
  }
}

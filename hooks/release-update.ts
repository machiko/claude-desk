// desk 自己發版後自動更新：回合中任何一次重新整理看到 desk 專案的卡片寫「已發版 v<版號>」就記下待辦（$.store），
// 回合結束（重讀與規格確認派工之後）跑一次 runUpdate，沿用它的前置檢查、訊息與自動重新載入。同一版只跑一次，失敗只回報不重試。
// 發版第 10 步寫狀態與 archive --cleanup 常在同一回合：回合結束時卡片可能已經不在，所以要回合中先記下來。
// 跨檔傳 $ 的函式一律用 function 宣告（箭頭函式會被引擎掃描拒絕載入）。
import type { Case, Snapshot } from '../types'
import { feedPush, tellPanel } from './desk-io'
import { isNewer } from './update'
import { runUpdate } from './update-run'

export const RELEASE_UPDATE_KEY = 'releaseUpdate'
/** 待辦：哪一版、哪張卡發的；handled＝這一版已經處理過（更新過、擋下或不用更新），不再跑。 */
export type ReleaseUpdate = { version: string; name: string; handled: boolean }

const RELEASED = /已發版\s*v?(\d+(?:\.\d+)+)/

/** 卡片狀態寫的「已發版 v<版號>」裡的版號；沒寫就是 null。 */
export function releasedVersion(status: string): string | null {
  return RELEASED.exec(String(status ?? ''))?.[1] ?? null
}

/** 這個根目錄是 desk 自己：plugin.json 的 name 跟載入中的 desk 一樣。不比 git remote：GitHub 安裝的 $.plugin.root 是 cache 目錄。 */
export async function isDeskProject($: any, root: string): Promise<boolean> {
  const manifest = await $.fs.read(`${root}/.claude-plugin/plugin.json`).catch(() => null)
  try { return typeof manifest === 'string' && JSON.parse(manifest)?.name === String($.plugin.name || 'desk') } catch { return false }
}

async function loadPending($: any): Promise<ReleaseUpdate | null> {
  const v = await $.store.get(RELEASE_UPDATE_KEY).catch(() => null) as ReleaseUpdate | null
  return v && typeof v.version === 'string' ? v : null
}

/** 重新整理讀到的卡：第一張（不含示範任務）寫「已發版」的 desk 專案卡，版號跟已記的不同就記成待辦。 */
export async function noteReleased($: any, s: Snapshot) {
  const released = s.cases.filter((c: Case) => !c.demo && releasedVersion(c.status))
  for (const c of released) {
    if (!(await isDeskProject($, c.root))) continue
    const version = releasedVersion(c.status)!
    if ((await loadPending($))?.version === version) return
    const next: ReleaseUpdate = { version, name: c.name, handled: false }
    await $.store.set(RELEASE_UPDATE_KEY, next)
    return
  }
}

/**
 * 回合結束：有還沒處理的待辦，而且發的版比載入中的新，就先記成處理過（失敗不重試）、在動態與下一則提示說一句，再跑 runUpdate。
 * 載入中的已經不比它舊就只記成處理過；讀不到載入中的版號就交給 runUpdate 自己比。
 */
export async function afterReleaseUpdate($: any, loadedVersion: string | undefined) {
  const pending = await loadPending($)
  if (!pending || pending.handled) return
  const handled: ReleaseUpdate = { ...pending, handled: true }
  await $.store.set(RELEASE_UPDATE_KEY, handled)
  if (loadedVersion && !isNewer(pending.version, loadedVersion)) return
  const now = await $.clock.now()
  const text = `${pending.name} 已發版 v${pending.version}：自動更新 desk`
  await feedPush($, [{ at: now, text, tone: 'suggestion' }])
  await tellPanel($, now, text)
  await runUpdate($)
}

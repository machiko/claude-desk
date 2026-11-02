// desk 自己發版後自動更新：回合中任何一次重新整理看到 desk 專案的卡片寫「已發版 v<版號>」就記下待辦（這個對話自己的 $.state），
// 回合結束（重讀與規格確認派工之後）跑一次 runUpdate，沿用它的前置檢查、訊息與自動重新載入。同一版只跑一次，失敗只回報不重試。
// 發版第 10 步寫狀態與 archive --cleanup 常在同一回合：回合結束時卡片可能已經不在，所以要回合中先記下來。
// 待辦不放 $.store：store 是所有對話共用的，別的專案的對話回合結束會把它拿走、在那邊更新與重新載入；store 只記處理過的版號（跨對話、重開都不重跑）。
// 跨檔傳 $ 的函式一律用 function 宣告（箭頭函式會被引擎掃描拒絕載入）。
import { atom, read, update } from 'claude-code'
import type { PluginOptions } from 'claude-code'
import { parseCard, parseRegistry, projectRoot } from './card'
import type { RegistryRow } from './card'
import { feedPush, tellPanel } from './desk-io'
import { deskPaths, home } from './probes'
import { isNewer } from './update'
import { runUpdate } from './update-run'

const notedAtom = atom({ plugin: 'desk', key: 'releaseNoted' } as const, null)

export const RELEASE_UPDATE_KEY = 'releaseUpdate'
/** 處理過的版號（$.store，所有對話共用）：哪一版、哪張卡發的；handled＝這一版已經處理過（更新過、擋下或不用更新），哪個對話都不再跑。 */
export type ReleaseUpdate = { version: string; name: string; handled: boolean }
type Released = { version: string; name: string }

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

async function loadHandled($: any): Promise<ReleaseUpdate | null> {
  const v = await $.store.get(RELEASE_UPDATE_KEY).catch(() => null) as ReleaseUpdate | null
  return v && typeof v.version === 'string' && v.handled === true ? v : null
}

/** 這一版已經有對話處理過（store 記的版號不比它舊）。 */
async function handledAlready($: any, version: string): Promise<boolean> {
  const done = await loadHandled($)
  return !!done && !isNewer(version, done.version)
}

/** 一張登錄表列的卡：寫了「已發版」而且是 desk 專案，就回傳版號與卡名。讀不到卡片或 plugin.json 就不算。 */
async function releasedDeskCard($: any, row: RegistryRow): Promise<Released | null> {
  const text = await $.fs.read(row.statusPath).catch(() => null)
  const version = typeof text === 'string' ? releasedVersion(parseCard(text)?.['狀態'] ?? '') : null
  if (!version || !(await isDeskProject($, projectRoot(row.statusPath)))) return null
  return { version, name: row.name }
}

/**
 * 重新整理一開始（讀完登錄表、還沒跑 claude agents 與各卡探測）就看：同回合的 archive --cleanup 會刪掉 worktree，晚了就讀不到 plugin.json。
 * 寫「已發版」的 desk 專案卡挑版號最大的；比這個對話已記的新、也還沒有對話處理過，才記成待辦，不倒退（登錄表留著上一版的已發版卡也不會蓋掉新版）。
 */
export async function noteReleased($: any, rows: readonly RegistryRow[]) {
  const found = (await Promise.all(rows.map(row => releasedDeskCard($, row)))).filter((x): x is Released => x !== null)
  const newest = found.reduce<Released | null>((best, x) => (!best || isNewer(x.version, best.version) ? x : best), null)
  if (!newest || (await handledAlready($, newest.version))) return
  await update($, notedAtom, v => (v && !isNewer(newest.version, v.version) ? v : newest))
}

/** 對話改到卡片、又有一輪重新整理還在跑（可能在改之前就讀過登錄表）：先讀登錄表記下 desk 發版，再等那一輪，不讓同回合的 archive --cleanup 搶先刪掉 worktree。 */
export async function noteReleasedNow($: any, options: PluginOptions) {
  const paths = await deskPaths($, options)
  const text = paths.registry ? await $.fs.read(paths.registry).catch(() => null) : null
  if (typeof text === 'string') await noteReleased($, parseRegistry(text, await home($)))
}

/**
 * 回合結束：這個對話記了待辦、還沒有對話處理過這一版，就先在 store 記成處理過（失敗不重試、別的對話也不再跑），
 * 發的版比載入中的新才在動態與下一則提示說一句、跑 runUpdate。載入中的已經不比它舊就只記成處理過；讀不到載入中的版號就交給 runUpdate 自己比。
 */
export async function afterReleaseUpdate($: any, loadedVersion: string | undefined) {
  const noted = await read($, notedAtom)
  if (!noted) return
  await update($, notedAtom, () => null)
  if (await handledAlready($, noted.version)) return
  const handled: ReleaseUpdate = { ...noted, handled: true }
  await $.store.set(RELEASE_UPDATE_KEY, handled)
  if (loadedVersion && !isNewer(noted.version, loadedVersion)) return
  const now = await $.clock.now()
  const text = `${noted.name} 已發版 v${noted.version}：自動更新 desk`
  await feedPush($, [{ at: now, text, tone: 'suggestion' }])
  await tellPanel($, now, text)
  await runUpdate($)
}

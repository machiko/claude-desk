// 被後來派工取代、還停在提問的工作桌 Agent：重新整理時停掉，每個只試一次，結果寫進「最近」。
// 挑哪些算被取代是 model.ts 的 supersede（純函式）；這裡只做 I/O。跨檔傳 $ 的函式一律用 function 宣告。
import type { Case } from '../types'
import type { LastLaunch, Superseded } from './model'
import { errorLine, hhmm } from './model'
import type { RootJobs } from './dispatch'
import { normalizeRoot } from './dispatch'
import { feedPush } from './desk-io'

/** 已經試著停過的 Agent id（成功或失敗都算），不再重試。 */
export const STALE_STOPS_KEY = 'supersededStops'
/** 只記最近這麼多個，store 不會一直長。 */
const STALE_STOPS_KEEP = 50
const STOP_TIMEOUT_MS = 30_000

/** 每個根目錄最後一次派工的名字與時間，給 supersede 比對。 */
export function lastLaunches(jobs: Readonly<Record<string, RootJobs>>): Record<string, LastLaunch> {
  return Object.fromEntries(Object.entries(jobs).flatMap(([root, j]) => j?.last ? [[normalizeRoot(root), { launchName: j.last.launchName, startedAt: j.last.startedAt }]] : []))
}

async function triedStops($: any): Promise<string[]> {
  const v = await $.store.get(STALE_STOPS_KEY).catch(() => null)
  return Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === 'string') : []
}

/**
 * 停掉工作桌上那幾件被取代的 Agent（`claude stop <id>`）。先記下 id 再停：停不掉也不重試。
 * 不在工作桌上的根目錄不碰。只等記 id（下一輪才不會重停）；`claude stop` 同時跑、不等，卡住也不拖住重新整理與自動流程。
 */
export async function stopSuperseded($: any, cases: readonly Case[], found: readonly Superseded[], now: number) {
  if (!found.length) return
  const tried = await triedStops($)
  const todo = found.flatMap(agent => {
    const card = agent.id && !tried.includes(agent.id) ? cases.find(c => !c.demo && normalizeRoot(c.root) === agent.root) : undefined
    return card ? [{ agent, card }] : []
  })
  if (!todo.length) return
  await $.store.set(STALE_STOPS_KEY, [...todo.map(x => x.agent.id), ...tried].slice(0, STALE_STOPS_KEEP))
  for (const { agent, card } of todo) void stopOne($, agent, card, now)
}

/** 停一個，結果寫進「最近」；`claude stop` 失敗或逾時都記成停不掉。 */
async function stopOne($: any, agent: Superseded, card: Case, now: number) {
  const r = await $.process.run(['claude', 'stop', agent.id], { timeoutMs: STOP_TIMEOUT_MS }).catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: String(e) }))
  const what = `${hhmm(agent.startedAt)} 派出、被後來派工取代的 Agent`
  const ok = r?.exitCode === 0
  const text = ok ? `${card.name} 已停掉 ${what}` : `${card.name} 停不掉 ${what}：${errorLine(r, 'claude stop 失敗')}`
  await feedPush($, [{ at: now, text, tone: ok ? 'subtle' : 'warning', card: card.statusPath }])
}

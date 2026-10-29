// 被後來派工取代、還停在提問的工作桌 Agent：重新整理時停掉，每個只試一次，結果寫進「最近」。
// 最後一次派工停在提問、題目寫進卡片又在對話處理掉的：記下來，不再等它（noteCardAsks）。
// 挑哪些算被取代是 model.ts 的 supersede（純函式）；這裡只做 I/O。跨檔傳 $ 的函式一律用 function 宣告。
import type { Case } from '../types'
import type { LastLaunch, Superseded } from './model'
import { askClearedOnCard, asksQuestion, errorLine, hhmm, plain } from './model'
import type { RootJobs } from './dispatch'
import { normalizeRoot } from './dispatch'
import { saysNone } from './card'
import { JOBS_KEY, feedPush, loadJobs } from './desk-io'

/** 已經試著停過的 Agent（成功或失敗都算），不再重試：有 id 記 id；沒 id 的停不掉、只在「最近」說一次，記「名字@派出時間」。 */
export const STALE_STOPS_KEY = 'supersededStops'
/** 只記最近這麼多個，store 不會一直長。 */
const STALE_STOPS_KEEP = 50
const STOP_TIMEOUT_MS = 30_000

/** 每個根目錄最後一次派工的名字與時間，給 supersede 比對。 */
export function lastLaunches(jobs: Readonly<Record<string, RootJobs>>): Record<string, LastLaunch> {
  return Object.fromEntries(Object.entries(jobs).flatMap(([root, j]) => j?.last ? [[normalizeRoot(root), { launchName: j.last.launchName, startedAt: j.last.startedAt }]] : []))
}

const stopKey = (agent: Superseded) => agent.id || `${agent.name}@${agent.startedAt}`

async function triedStops($: any): Promise<string[]> {
  const v = await $.store.get(STALE_STOPS_KEY).catch(() => null)
  return Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === 'string') : []
}

/**
 * 停掉工作桌上那幾件被取代的 Agent（`claude stop <id>`）。先記下再停：停不掉也不重試；沒 id 的不跑 stop，只記成停不掉。
 * 不在工作桌上的根目錄不碰。只等記下（下一輪才不會重停）；`claude stop` 同時跑、不等，卡住也不拖住重新整理與自動流程。
 * 停完寫「最近」出錯也不能變成沒人接的 rejection：用 toast 說一聲。
 */
export async function stopSuperseded($: any, cases: readonly Case[], found: readonly Superseded[], now: number) {
  if (!found.length) return
  const tried = await triedStops($)
  const todo = found.flatMap(agent => {
    const card = !tried.includes(stopKey(agent)) ? cases.find(c => !c.demo && normalizeRoot(c.root) === agent.root) : undefined
    return card ? [{ agent, card }] : []
  })
  if (!todo.length) return
  await $.store.set(STALE_STOPS_KEY, [...todo.map(x => stopKey(x.agent)), ...tried].slice(0, STALE_STOPS_KEEP))
  for (const { agent, card } of todo) {
    void stopOne($, agent, card, now).catch((e: unknown) => $.ui.toast(`${card.name}：停掉被取代的 Agent 後記不下結果（${plain(e instanceof Error ? e.message : String(e))}）`, { timeoutMs: 8000 }))
  }
}

/** 停一個，結果寫進「最近」；`claude stop` 失敗或逾時都記成停不掉，沒 id 的直接記成停不掉。 */
async function stopOne($: any, agent: Superseded, card: Case, now: number) {
  const r = agent.id
    ? await $.process.run(['claude', 'stop', agent.id], { timeoutMs: STOP_TIMEOUT_MS }).catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: String(e) }))
    : { exitCode: 1, stdout: '', stderr: '沒有 Agent id' }
  const what = `${hhmm(agent.startedAt)} 派出、被後來派工取代的 Agent`
  const ok = r?.exitCode === 0
  const text = ok ? `${card.name} 已停掉 ${what}` : `${card.name} 停不掉 ${what}：${errorLine(r, 'claude stop 失敗')}`
  await feedPush($, [{ at: now, text, tone: ok ? 'subtle' : 'warning', card: card.statusPath }])
}

/**
 * 最後一次派工停在提問、題目也寫進卡片「等你」：記下 cardAsked。之後「等你」清成「無」（題目在對話處理了）就記成 answered，
 * 「最近」寫一筆；面板從這一輪起照卡片走。那個 Agent 不停、不回覆。只改還是同一次派工的紀錄，新派工不帶舊標記。
 */
export async function noteCardAsks($: any, list: readonly any[], cases: readonly Case[], now: number) {
  for (const c of cases) {
    if (c.demo) continue
    const key = normalizeRoot(c.root)
    const all = await loadJobs($)
    const last = all[key]?.last
    if (!last || last.answered || !asksQuestion(list, last.launchName)) continue
    const cleared = askClearedOnCard(last, c.ask)
    if (!cleared && (last.cardAsked || saysNone(c.ask))) continue
    await $.store.set(JOBS_KEY, { ...all, [key]: { ...all[key], last: { ...last, ...(cleared ? { answered: true } : { cardAsked: true }) } } })
    if (cleared) await feedPush($, [{ at: now, text: `${c.name} Agent 的提問已在對話處理（卡片「等你」已清），不再等它回覆`, tone: 'subtle', card: c.statusPath }])
  }
}

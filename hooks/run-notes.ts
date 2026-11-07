// 派工執行時間紀錄：每輪重新整理看各根目錄最後一次派工的 Agent，記下怎麼結束、在跑與等人的時間，算進總執行並同步更新畫面。
// 從 register.tsx 搬出；$ 只傳給 function 宣告（外掛載入的限制）。
import { atom, update } from 'claude-code'
import type { Case } from '../types'
import { endedHow, runSeen } from './agents'
import { JOBS_KEY, loadJobs } from './desk-io'
import type { JobRecord, RootJobs } from './dispatch'
import { worktreeMark } from './probes'
import { addRunTime, dispatchRunMs, observeRun, runOf } from './run-time'
import type { RunShown } from './run-time'
import { normalizeRoot } from './settings'

const snapshot = atom({ plugin: 'desk', key: 'snapshot' } as const, null)

/**
 * 這幾個根目錄（登錄表上的卡，加上要停掉的做完 Agent 所在的，可能是別的專案）最後一次派工的 Agent：
 * - 剛結束（做完或被停掉）：記下怎麼結束；會改程式的那種（繼續、回覆、修正）再記下這時 worktree 的未提交指紋，
 *   之後派工用它分辨「現在的改動是上一個 Agent 留下的」還是別的對話在改。每一次派工只記一次，審查與同步不動指紋。
 *   同時把這次派工在跑的時間加進總執行時間：只在第一次記下 ended 時加，同一次派工不會重複算；
 *   最多算到最後看到它在跑之後 grace（工作桌關著時結束的，不把關著的時間算進去）。
 * - 還在跑或停下來等人：記下最後看到在跑的時間、等人時暫停（見 observeRun），等的時間不算。
 * 記下之後同步更新這一輪的畫面（畫面在記下之前就算好了），總執行不會晚一輪才跟上。
 */
export async function noteRuns($: any, list: readonly any[], roots: readonly string[], now: number, grace: number, branches: Readonly<Record<string, string>>) {
  for (const key of new Set(roots.map(normalizeRoot))) {
    const last = (await loadJobs($))[key]?.last
    if (!last || last.ended) continue
    const how = endedHow(list, last.launchName)
    if (!how) { await noteSeen($, key, last, runSeen(list, last.launchName), now, grace); continue }
    const codeAgent = last.kind === 'continue' || last.kind === 'reply' || last.kind === 'catchup'
    const mark = codeAgent ? await worktreeMark($, key) : undefined
    // 算指紋的這段時間可能剛派了新工：只改還是同一筆的紀錄。
    const all = await loadJobs($)
    const cur = all[key]?.last
    if (!cur || cur.launchName !== last.launchName || cur.ended) continue
    const timed = addRunTime(all[key], dispatchRunMs(cur, now, grace), branches[key])
    const next: RootJobs = { ...timed, ...(mark ? { mark: mark.hash } : {}), last: { ...cur, ended: { how } } }
    await $.store.set(JOBS_KEY, { ...all, [key]: next })
    await restageRun($, key, next, grace)
  }
}

/** 還沒結束的派工：看到它在跑或停下來等人，紀錄有變才寫（只改還是同一筆、還沒結束的紀錄）。 */
async function noteSeen($: any, key: string, last: JobRecord, seen: 'busy' | 'waiting' | null, now: number, grace: number) {
  if (!seen || observeRun(last, seen, now, grace) === last) return
  const all = await loadJobs($)
  const cur = all[key]?.last
  if (!cur || cur.launchName !== last.launchName || cur.ended) return
  const next: RootJobs = { ...all[key], last: observeRun(cur, seen, now, grace) }
  await $.store.set(JOBS_KEY, { ...all, [key]: next })
  await restageRun($, key, next, grace)
}

/** 這個根目錄的卡換上剛記下的總執行（畫面用的 runMs、runFrom、runUntil）。 */
async function restageRun($: any, key: string, jobs: RootJobs, grace: number) {
  await update($, snapshot, s => s ? { ...s, cases: s.cases.map(c => !c.demo && normalizeRoot(c.root) === key ? withRun(c, runOf(jobs, c.git?.branch, grace)) : c) } : s)
}

/** 換上總執行（0 或沒有就拿掉那欄），回傳新的一份。 */
function withRun(c: Case, run: RunShown): Case {
  const { runMs: _, runFrom: _f, runUntil: _u, ...rest } = c
  return { ...rest, ...(run.runMs ? { runMs: run.runMs } : {}), ...(run.runFrom !== undefined ? { runFrom: run.runFrom, runUntil: run.runUntil } : {}) }
}

/** 每件任務的根目錄（正規化）現在在哪條分支；讀不到 git 的不列。 */
export function branchesOf(cases: readonly Case[]): Record<string, string> {
  return Object.fromEntries(cases.filter(c => !c.demo && c.git?.branch).map(c => [normalizeRoot(c.root), c.git!.branch]))
}

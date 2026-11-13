// 執行時間：一次派工與自動檢查各跑了多久、累計進這條分支的總執行，以及畫面上要加的那段在跑的時段。純函式。
import type { JobRecord, RootJobs, StageRun } from './dispatch'

/** 總執行時間超過這麼久（15 分鐘）就用警示色標出來。 */
export const RUN_WARN_MS = 15 * 60_000

/** 每條分支的逐段紀錄最多留這麼多筆（最近的）：一直按測試也不會讓紀錄無限長。 */
export const STAGE_RUNS_MAX = 200

/**
 * 把一次派工或自動檢查花的時間加進總執行時間（回傳新的一份，不改原本的）；有給 run 就把這一段接在逐段紀錄尾端。
 * branch 跟記著的分支不同：換了分支，總執行與逐段紀錄都從這次重新算。沒有 branch（讀不到）就照原本的分支加。
 */
export function addRunTime(jobs: RootJobs | undefined, ms: number, branch?: string, run?: StageRun): RootJobs {
  const own = jobs ?? {}
  const spent = Math.max(0, ms)
  const isNewBranch = !!branch && !!own.runBranch && branch !== own.runBranch
  const runBranch = branch ?? own.runBranch
  const kept = isNewBranch ? [] : own.runs ?? []
  const runs = run ? [...kept, run].slice(-STAGE_RUNS_MAX) : kept
  const { runs: _, ...rest } = own
  return { ...rest, runMs: (isNewBranch ? 0 : own.runMs ?? 0) + spent, ...(runBranch ? { runBranch } : {}), ...(runs.length ? { runs } : {}) }
}

/** 看到派工在跑時，離上次記下「最後看到在跑」超過這麼久才再記一次，免得每次重新整理都寫。 */
export const RUN_SEEN_STEP_MS = 60_000

/**
 * 這次派工現在這段在跑的時段：從 from 起，最多算到 until（最後看到它在跑＋grace）：
 * 工作桌關著時結束的、或 Agent 已經不在清單裡的，不會把之後的時間算進去。停下來等人時沒有這段。
 * 存進去的累計（stretchMs）與畫面上的數字（runOf → totalRunMs）都用它，兩邊封頂一樣。
 */
function stretchSpan(r: JobRecord, grace: number): { from: number; until: number } | null {
  if (r.paused) return null
  const from = r.runAt ?? r.startedAt
  return { from, until: Math.max(r.seenAt ?? from, from) + grace }
}

/** 這段時段算到 now 是幾毫秒（不超過 until）。 */
export const spanMs = (span: { from: number; until: number }, now: number): number => Math.max(0, Math.min(now, span.until) - span.from)

/** 這次派工現在這段在跑的時間，算到 now（見 stretchSpan）；停下來等人時是 0。 */
function stretchMs(r: JobRecord, now: number, grace: number): number {
  const span = stretchSpan(r, grace)
  return span ? spanMs(span, now) : 0
}

/** 這次派工總共在跑多久：之前收起來的幾段，加上現在這段。 */
export const dispatchRunMs = (r: JobRecord, now: number, grace: number): number => (r.busyMs ?? 0) + stretchMs(r, now, grace)

/**
 * 這次派工結束（或被取代）時記成的一段；流程自己排的「重新檢查」紀錄不是 Agent，回傳 null。
 * 種類：修正輪（round > 0）是 fix、資安審查是 security，其他照派工種類。runMs 跟加進總執行的同一個數（dispatchRunMs）；
 * endedAt 跟總執行同一套封頂（最多到最後看到在跑＋grace，見 stretchSpan）。停下來等人時沒有在跑的時段，算到 now：
 * 等人的時間不算進這段的 runMs，也不會變成段與段之間的空等。
 */
export function stageOf(r: JobRecord, now: number, grace: number): StageRun | null {
  if (r.recheck) return null
  const kind = (r.round ?? 0) > 0 ? 'fix' : r.security ? 'security' : r.kind
  const span = stretchSpan(r, grace)
  const endedAt = Math.max(r.startedAt, span ? Math.min(now, span.until) : now)
  return { kind, startedAt: r.startedAt, endedAt, runMs: dispatchRunMs(r, now, grace), ...(r.queuedMs ? { queuedMs: r.queuedMs } : {}) }
}

/**
 * 重新整理看到這次派工的樣子：在跑（busy）或停下來等人（waiting）。回傳新的一份；沒變就回原本那份（呼叫端用 === 判斷要不要寫）。
 * 在跑：剛從等人回來就從現在重新起算，否則離上次記下超過 RUN_SEEN_STEP_MS 才更新「最後看到在跑」。
 * 等人：把現在這段收進 busyMs 並暫停，等的時間不算。
 */
export function observeRun(r: JobRecord, seen: 'busy' | 'waiting', now: number, grace: number): JobRecord {
  if (seen === 'busy') {
    if (r.paused) {
      const { paused: _, ...rest } = r
      return { ...rest, runAt: now, seenAt: now }
    }
    return now - (r.seenAt ?? r.runAt ?? r.startedAt) >= RUN_SEEN_STEP_MS ? { ...r, seenAt: now } : r
  }
  return r.paused ? r : { ...r, busyMs: dispatchRunMs(r, now, grace), paused: true }
}

/** 畫面用的總執行（見 runOf）。 */
export type RunShown = { runMs: number; runFrom?: number; runUntil?: number }

/**
 * 畫面用的總執行：runMs 是這條分支已結束的，加上還沒結束那次派工收起來的幾段；runFrom～runUntil 是它現在這段在跑的時段
 * （停下等人、已結束就沒有），畫面上再加 min(now, runUntil) - runFrom，跟著每秒的重畫動，封頂跟存進去的一樣（見 stretchSpan）。
 */
export function runOf(jobs: RootJobs | undefined, branch: string | undefined, grace: number): RunShown {
  const done = runMsOn(jobs, branch)
  const last = jobs?.last
  if (!last || last.ended) return { runMs: done }
  const span = stretchSpan(last, grace)
  return { runMs: done + (last.busyMs ?? 0), ...(span ? { runFrom: span.from, runUntil: span.until } : {}) }
}

/** 這條分支已結束的總執行毫秒：記的是別條分支（同一個資料夾換了分支）就是 0。 */
export function runMsOn(jobs: RootJobs | undefined, branch: string | undefined): number {
  if (!jobs?.runMs) return 0
  return jobs.runBranch && branch && jobs.runBranch !== branch ? 0 : jobs.runMs
}

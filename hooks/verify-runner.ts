// 完成檢查（Verify）佇列與執行排程。
import { atom, read, update } from 'claude-code'
import type { Case, Verify } from '../types'
import { DEMO_ONLY } from './theme'
import { isApproved, trustedChecks, unapprovedText } from './approve-check'
import { containers, loadSettings, verifyResult } from './probes'
import { missingServices } from './containers'
import { feedPush, tellPanel, me, loadChains, loadJobs, saveChain, VERIFIES_KEY, JOBS_KEY } from './desk-io'
import { paused } from './chain'
import { isMerged, pipeline, finalState } from './pipeline'
import { MISSING_CHECK_NEXT, MISSING_CHECK_WHY } from './dispatch'
import { writeStats } from './run-stats'
import { addRunTime } from './run-time'
import { normalizeRoot } from './settings'
import { stateOf } from './model'
import { errorText } from './text'
import { optionsRef, notify, restage, spin, refreshSoon, tutorial } from './register'
import { busyRefused } from './dispatch-runner'

const snapshot = atom({ plugin: 'desk', key: 'snapshot' } as const, null)
const verifiesAtom = atom({ plugin: 'desk', key: 'verifies' } as const, {})
const verifyingAtom = atom({ plugin: 'desk', key: 'verifying' } as const, {})
const queueAtom = atom({ plugin: 'desk', key: 'checkQueue' } as const, [])

/** 完成檢查：只跑核准過的指令（面板按兩次 v／g 或確認規格時核准）；結果記在 $.store，重開也在。 */
/** 排隊等著跑的檢查（同一時間只跑一個：測試共用主工作區的容器與資料庫，同時跑會互相干擾）。 */
export const checkQueue: { statusPath: string; auto: boolean }[] = []

/**
 * 正在跑檢查的那一件。判斷「有沒有人在跑」與佔位之間不能有 await：同一輪重新整理裡兩件的實作一起結束時，
 * 流程會連著叫兩次 runVerify，讀 verifyingAtom 再寫回會兩件都以為沒人在跑。
 */
export let checking: string | null = null
export const isQueued = (statusPath: string) => checkQueue.some(q => q.statusPath === statusPath)

/** 這件的完成檢查正在跑或在檢查隊伍裡：派工隊伍先跳過它，不跟檢查搶 worktree。 */
export const verifyPending = (statusPath: string): boolean => checking === statusPath || isQueued(statusPath)

export function resetCheckingState() {
  checking = null
  checkQueue.length = 0
}

/** 回傳有沒有接手：開跑或排進隊伍是 true；沒跑（卡片沒檢查、還沒核准、已經在跑或在排）是 false。 */
export async function runVerify($: any, c: Case, auto = false, fromQueue = false): Promise<boolean> {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return false }
  if (!c.verify) { $.ui.toast(`${c.name}：無法執行測試（${MISSING_CHECK_WHY}）；${MISSING_CHECK_NEXT}`); return false }
  if (checking === c.statusPath) { if (!auto) $.ui.toast(`${c.name}：測試在跑；跑完結果會列在測試列`); return false }
  if (!fromQueue && isQueued(c.statusPath)) { if (!auto) $.ui.toast(`${c.name}：測試已排隊；前面跑完自動開始`); return false }
  // 沒核准的不跑也不問：面板按兩次 v 才核准（第一次在檢查列列出全文）。
  if (!isApproved(await trustedChecks($), c)) { if (!auto) $.ui.toast(unapprovedText(c)); return false }
  // 讀核准紀錄之後再看一次：這段時間它可能已經被排進隊伍或開始跑了。
  if (checking === c.statusPath || (!fromQueue && isQueued(c.statusPath))) return false
  // 已經有別的檢查在跑：排隊，跑完一個再接下一個。
  if (checking !== null) {
    checkQueue.push({ statusPath: c.statusPath, auto })
    await update($, queueAtom, () => checkQueue.map(q => q.statusPath))
    await restage($, c.statusPath)
    if (!auto) $.ui.toast(`${c.name}：已排隊，前面還有 ${checkQueue.length} 件`)
    return true
  }
  checking = c.statusPath
  try {
    const ran = await executeVerify($, c, auto)
    // 你按 v 跑完的：流程停在檢查段就接著走。
    if (ran && !auto) await resumeAtCheck($, c)
  }
  catch (error) {
    // 記錄出錯的那段自己也出錯（例如狀態層一直拒寫）：至少讓你看到，不變成沒人接的 rejection。
    await verifyBroke($, c, auto, error).catch(again => $.ui.toast(`${c.name}：測試中斷，原因也記不下來（${errorText(again)}）`, { timeoutMs: 10_000 }))
  }
  // 不管跑成怎樣都放掉位子、接下一件：出錯也不能讓排隊的任務永遠等下去。
  finally { checking = null; void nextInQueue($) }
  return true
}

/** 檢查途中出錯（不是測試沒過，是記不下結果）：清掉「測試中」、寫進動態；流程停下並寫明原因，不再自動重跑。 */
export async function verifyBroke($: any, c: Case, auto: boolean, error: unknown) {
  const reason = `測試中斷：${errorText(error)}`
  $.ui.toast(`${c.name}：${reason}`, { timeoutMs: 10_000 })
  const now = await $.clock.now()
  await feedPush($, [{ at: now, text: `${c.name} ${reason}`, tone: 'error', card: c.statusPath }])
  await tellPanel($, now, reason, { name: c.name, skip: auto || tutorial })
  await update($, verifyingAtom, v => Object.fromEntries(Object.entries(v).filter(([k]) => k !== c.statusPath)))
  if (auto && await saveChain($, normalizeRoot(c.root), r => r ? paused(r, reason, true) : r)) notify($, `${c.name}：流程已暫停，${reason}`)
  await restage($, c.statusPath)
  await spin($, false)
}

/** 佔到位子之後真正跑檢查：容器沒起來就不跑；跑完記結果、更新六段。回傳有沒有跑完、記下結果。 */
export async function executeVerify($: any, c: Case, auto: boolean): Promise<boolean> {
  // 檢查要用的容器沒在跑：不執行，也不記成「未通過」，直接說要先啟動哪個。
  const box = await containers($, optionsRef!)
  const missing = missingServices(c.verify, box, (await loadSettings($, optionsRef!)).checkServices)
  if (missing.length) {
    const reason = `容器 ${missing.join('、')} 未啟動，請先在主工作區執行 docker compose up -d ${missing.join(' ')}`
    $.ui.toast(`${c.name}：${reason}`, { timeoutMs: 10_000 })
    const now = await $.clock.now()
    await feedPush($, [{ at: now, text: `${c.name} 測試未執行：${reason}`, tone: 'warning', card: c.statusPath }])
    await tellPanel($, now, `測試未執行：${reason}`, { name: c.name, skip: auto || tutorial })
    if (auto && await saveChain($, normalizeRoot(c.root), r => r ? paused(r, reason, true) : r)) notify($, `${c.name}：流程已暫停，${reason}`)
    await update($, snapshot, s => s ? { ...s, containers: box } : s)
    await restage($, c.statusPath)
    return false
  }
  const startedAt = await $.clock.now()
  await update($, verifyingAtom, v => ({ ...v, [c.statusPath]: startedAt }))
  await restage($, c.statusPath)
  await spin($, true)
  const result = await verifyResult($, c)
  await update($, verifyingAtom, v => Object.fromEntries(Object.entries(v).filter(([k]) => k !== c.statusPath)))
  const all = await update($, verifiesAtom, v => ({ ...v, [c.statusPath]: result }))
  await $.store.set(VERIFIES_KEY, all).catch(() => {})
  await addCheckTime($, c, result.at - startedAt)
  const outcome = result.ok ? '測試通過' : `測試未通過（exit ${result.exitCode}）`
  await feedPush($, [{ at: result.at, text: `${c.name} ${outcome}`, tone: result.ok ? 'success' : 'error', card: c.statusPath }])
  await tellPanel($, result.at, outcome, { name: c.name, skip: auto || tutorial })
  $.ui.toast(`${c.name}：${result.ok ? '測試通過' : '測試未通過'}`, { timeoutMs: 6000 })
  // 你按 v 的檢查沒過送一次通知（每按一次 v 送一則，同一句不去重）；自動流程的沒過直接派修正，修到上限停下時另有「流程已暫停」通知。
  if (!result.ok && !auto) notify($, `${c.name}：${outcome}`, true)
  await update($, snapshot, s => s ? { ...s, cases: s.cases.map(x => { if (x.statusPath !== c.statusPath) return x; const y = { ...x, state: stateOf(x, result) }; const z = { ...y, pipeline: pipeline(y, result) }; return { ...z, state: finalState(z) } }) } : s)
  await spin($, false)
  if (auto) refreshSoon($, optionsRef!)
  return true
}

/** 檢查跑完：這次花的時間加進這件的總執行時間，統計檔跟著重寫。記不下來只少算這一次，不擋檢查結果。 */
async function addCheckTime($: any, c: Case, ms: number) {
  const key = normalizeRoot(c.root)
  const all = await loadJobs($)
  const saved = await $.store.set(JOBS_KEY, { ...all, [key]: addRunTime(all[key], ms, c.git?.branch) }).then(() => true, () => false)
  if (saved) await writeStats($, key)
}

/**
 * 流程停在檢查段（指令未核准、容器沒啟動、檢查中斷），你排除後按 v 跑完了：解除暫停，
 * 讓流程把剛跑完的結果當成這次實作的檢查往下走（通過派審查、沒過派修正，輪數照算）。別的對話開的流程不動。
 */
export async function resumeAtCheck($: any, c: Case) {
  // 已經合併：流程不再往下走，檢查結果記下就好，流程與派工紀錄都不動。
  if (isMerged(c)) return
  const key = normalizeRoot(c.root)
  const run = (await loadChains($))[key]
  if (!run?.stopped || !run.heldAtCheck || run.owner !== (await me($))) return
  // 寫入被別的對話蓋掉、放棄：流程沒解除暫停，不說「流程繼續」。
  const resumed = await saveChain($, key, r => {
    if (!r) return r
    const { stopped: _s, heldAtCheck: _h, ...rest } = r
    return rest
  })
  if (!resumed) return
  // 停下時流程已把那次實作記成處理過（指令未核准的那種）：改回未處理，流程才會接手。
  // 同時記成流程已接手（chained）、拿掉 cardAsked：這是你重開的，不是那次 Agent 剛做完；「等你」這時有題目也不是它寫的，流程照舊往下走。
  const all = await loadJobs($)
  const last = all[key]?.last
  if (last?.handled) {
    const { handled: _, cardAsked: _c, ...open } = last
    await $.store.set(JOBS_KEY, { ...all, [key]: { ...all[key], last: { ...open, chained: true } } })
  }
  await feedPush($, [{ at: await $.clock.now(), text: `${c.name} 流程繼續：測試跑完了，接著自動往下走`, tone: 'suggestion', card: c.statusPath }])
  refreshSoon($, optionsRef!)
}

/** 排隊的那件輪到時接手出錯（不是測試沒過）：toast 的那句。 */
export const queuedBrokeText = (name: string, error: unknown) => `${name}：排隊的測試沒跑成（${errorText(error)}）`

export async function nextInQueue($: any) {
  if (checking !== null) return
  const next = checkQueue.shift()
  await update($, queueAtom, () => checkQueue.map(q => q.statusPath))
  if (!next) return
  const c = (await read($, snapshot))?.cases.find(x => x.statusPath === next.statusPath)
  if (!c) { void nextInQueue($); return }
  // 排隊期間這件的 Agent 開始跑了（派工不看隊伍）：不跟它搶 worktree，當成沒接手、換下一件。
  const took = await busyRefused($, c, '測試') ? false : await runVerify($, c, next.auto, true).catch(error => {
    $.ui.toast(queuedBrokeText(c.name, error), { timeoutMs: 10_000 })
    return false
  })
  // 輪到它卻沒接手（排隊期間卡片的檢查改了或清掉、還沒授權、按了取消）：這件不跑了，六段不再寫「排隊中」，換下一件，後面的不用一直等。
  if (!took) { await restage($, next.statusPath); void nextInQueue($) }
}

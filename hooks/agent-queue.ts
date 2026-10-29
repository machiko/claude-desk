// 派工隊伍：同時在跑的工作桌 Agent 達到上限（dispatch.json 的 maxAgents）時，再派的排在這裡，有空位依序派出。
// 手動派工與自動流程共用一條隊伍、先來先派；只存在這個對話的記憶體裡，重新載入就清空。
// 吃 $ 的函式一律寫成 function 宣告（$ 跨檔規則）；派工與重算六段從 ./register 匯入（循環匯入是既有做法）。
import { atom, read, update } from 'claude-code'
import type { PluginOptions } from 'claude-code'
import type { Case, Snapshot } from '../types'
import { KIND_LABEL, markRefusal, normalizeRoot, queueRefusal, runningDeskAgents } from './dispatch'
import type { DispatchKind, QueueEntry, QueueOpts, RawAgent } from './dispatch'
import { paused } from './chain'
import { feedPush, loadChains, loadJobs, me, saveChain } from './desk-io'
import { loadSettings, worktreeMark } from './probes'
import { trustedChecks } from './approve-check'
import { dispatch, launchingCount, notify, restage, verifyPending } from './register'

/** 畫面用：排隊中的卡片路徑，依序。 */
const agentQueueAtom = atom({ plugin: 'desk', key: 'agentQueue' } as const, [])
let agentQueue: readonly QueueEntry[] = []

const CANCELLED = '派工排隊已取消'

/** 這件在派工隊伍的第幾位（1 起）；不在隊伍是 0。 */
export const queuePosition = (statusPath: string): number => agentQueue.findIndex(e => e.statusPath === statusPath) + 1
export const isAgentQueued = (statusPath: string): boolean => queuePosition(statusPath) > 0
export const hasAgentQueue = (): boolean => agentQueue.length > 0

/** 隊伍裡這筆派的是什麼：修正第幾輪、資安審查，其他照派工種類。 */
const labelOf = (kind: DispatchKind, opts: QueueOpts) => opts.fix ? `修正第 ${opts.fix.round} 輪` : opts.security ? '資安審查' : KIND_LABEL[kind]

async function setQueue($: any, next: readonly QueueEntry[]) {
  agentQueue = next
  await update($, agentQueueAtom, () => next.map(e => e.statusPath))
}

/** 面板與摘要列讀的排隊清單（卡片路徑）。 */
export async function readAgentQueue($: any): Promise<string[]> {
  return await read($, agentQueueAtom)
}

/** 排到隊尾：手動的跳 toast 說第幾位；動態都記一筆。這件已經排著（同時派了兩次）就不再排，回傳 false。 */
export async function enqueueDispatch($: any, c: Case, kind: DispatchKind, opts: QueueOpts, max: number): Promise<boolean> {
  const now = await $.clock.now()
  // 判斷到寫入隊伍之間沒有 await（setQueue 先同步改清單）：同時派兩次只會排一筆。
  if (isAgentQueued(c.statusPath)) return false
  await setQueue($, [...agentQueue, { statusPath: c.statusPath, kind, opts, at: now }])
  await restage($, c.statusPath)
  const at = queuePosition(c.statusPath)
  const label = labelOf(kind, opts)
  const text = opts.auto ? `${c.name} 自動派${label}排隊中（第 ${at} 位）` : `${c.name} 派${label}排隊中（第 ${at} 位）：同時執行的 Agent 已達上限 ${max} 個`
  await feedPush($, [{ at: now, text, tone: 'suggestion', card: c.statusPath }])
  if (!opts.auto) $.ui.toast(`${c.name}：同時執行的 Agent 已達上限 ${max} 個，已排隊（第 ${at} 位）`, { timeoutMs: 6000 })
  return true
}

/** 從隊伍取出要派、名額卻被搶走：不出聲放回原來的位置。 */
export async function requeue($: any, c: Case, kind: DispatchKind, opts: QueueOpts, index: number) {
  if (isAgentQueued(c.statusPath)) return
  const entry: QueueEntry = { statusPath: c.statusPath, kind, opts, at: await $.clock.now() }
  await setQueue($, [...agentQueue.slice(0, index), entry, ...agentQueue.slice(index)])
}

/**
 * 自動排的那筆沒派出：把流程停下寫原因。流程紀錄跨對話共用，只停這個對話的、還沒停的那輪；
 * 別的對話接手的流程不動，已經停下的不改原因（也不清掉停在檢查的標記）。回傳這次有沒有真的停下。
 */
async function pauseOwnChain($: any, c: Case, mine: string, why: string): Promise<boolean> {
  let stopped = false
  await saveChain($, normalizeRoot(c.root), r => {
    if (!r || r.owner !== mine || r.stopped) return r
    stopped = true
    return paused(r, why)
  })
  return stopped
}

/**
 * 從隊伍取出卻沒派出（已不在隊伍裡）：寫動態說原因；自動排的另把流程停下寫同一個原因。
 * `alert`：要人處理的原因（worktree 被別的對話改了），流程真的停下時跟自動流程一樣跳提示並發系統通知。
 */
export async function notSent($: any, c: Case | undefined, entry: Pick<QueueEntry, 'statusPath' | 'kind' | 'opts'>, why: string, now: number, mine: string, alert = false) {
  const name = c?.name ?? entry.statusPath
  await feedPush($, [{ at: now, text: `${name} 排隊的${labelOf(entry.kind, entry.opts)}沒有派出：${why}`, tone: 'warning', card: entry.statusPath }])
  if (!entry.opts.auto || !c) return
  if (!(await pauseOwnChain($, c, mine, why)) || !alert) return
  $.ui.toast(`${name}：流程已暫停，${why}`, { timeoutMs: 10_000 })
  notify($, `${name}：流程已暫停，${why}`)
}

/** 移出隊伍、說為什麼沒派（見 notSent），重算那件的六段。 */
async function drop($: any, entry: QueueEntry, c: Case | undefined, why: string, now: number, mine: string, alert = false) {
  await setQueue($, agentQueue.filter(e => e !== entry))
  await notSent($, c, entry, why, now, mine, alert)
  await restage($, entry.statusPath)
}

/**
 * 排隊期間 worktree 有了不是上一個 Agent 留下的未提交改動（別的對話在改）：不派。排進隊伍時看過的那次可能是很久以前，
 * 派出前再看一次；同步不改程式、推送只推已 commit 的，不看。
 */
async function foreignChanges($: any, c: Case, entry: QueueEntry): Promise<string> {
  if (entry.kind === 'sync' || entry.kind === 'publish') return ''
  return markRefusal(await worktreeMark($, c.root), (await loadJobs($))[normalizeRoot(c.root)])
}

/** 手動排的繼續：排隊時核准的完成檢查跟卡片現在的不同，就不替你派。 */
function approvalChanged(c: Case, entry: QueueEntry, trusted: Record<string, string>): string {
  if (entry.kind !== 'continue' || entry.opts.auto || !c.verify) return ''
  return trusted[c.statusPath] === c.verify ? '' : '完成檢查在排隊期間改了，要重新核准：按 g 再派一次'
}

/**
 * 有空位就照順序派出排隊的：用這一輪重新整理的清單與快照算名額，每派出一件就重算，直到滿或隊伍空。
 * 輪到的那件現在不能派就移出並說原因；完成檢查正在跑或在檢查隊伍裡就先跳過、留在原位。回傳有沒有派出任何一件。
 */
export async function drainAgentQueue($: any, options: PluginOptions, s: Snapshot, list: readonly RawAgent[] | null): Promise<boolean> {
  if (!agentQueue.length) return false
  const max = (await loadSettings($, options)).maxAgents
  const chains = await loadChains($)
  const mine = await me($)
  const trusted = await trustedChecks($)
  let running = (list ? runningDeskAgents(list) : 0) + launchingCount()
  let launched = false
  for (const entry of [...agentQueue]) {
    if (max > 0 && running >= max) break
    const c = s.cases.find(x => x.statusPath === entry.statusPath)
    const why = !c ? '任務已不在登錄表' : queueRefusal(c, entry, chains[normalizeRoot(c.root)], mine) || approvalChanged(c, entry, trusted)
    if (why) { await drop($, entry, c, why, s.at, mine); continue }
    if (verifyPending(entry.statusPath)) continue
    const foreign = await foreignChanges($, c!, entry)
    if (foreign) { await drop($, entry, c, foreign, s.at, mine, true); continue }
    const index = agentQueue.indexOf(entry)
    await setQueue($, agentQueue.filter(e => e !== entry))
    const sent = await dispatch($, options, entry.opts.auto ? { ...c!, state: 'ready' } : c!, entry.kind, { ...entry.opts, fromQueue: index })
    // 名額被別處搶走：dispatch 已把它放回原位，這一輪不再派。
    if (isAgentQueued(entry.statusPath)) break
    if (sent) { running++; launched = true }
    else await restage($, entry.statusPath)
  }
  return launched
}

/** 面板的「■ 取消排隊」：移出隊伍、寫動態；自動排的把流程停下。 */
export async function cancelQueued($: any, c: Case) {
  const entry = agentQueue.find(e => e.statusPath === c.statusPath)
  if (!entry) return
  await setQueue($, agentQueue.filter(e => e !== entry))
  await feedPush($, [{ at: await $.clock.now(), text: `${c.name} 已取消排隊`, tone: 'suggestion', card: c.statusPath }])
  if (entry.opts.auto) await pauseOwnChain($, c, await me($), CANCELLED)
  $.ui.toast(`${c.name}：已取消排隊`)
  await restage($, c.statusPath)
}

/** 新對話與 /desk off：隊伍清空，不補派。 */
export async function clearAgentQueue($: any) {
  await setQueue($, [])
}

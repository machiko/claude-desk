// 派工隊伍：同時在跑的工作桌 Agent 達到上限（dispatch.json 的 maxAgents）時，再派的排在這裡，有空位依序派出。
// 手動派工與自動流程共用一條隊伍、先來先派；只存在這個對話的記憶體裡，重新載入就清空。
// 吃 $ 的函式一律寫成 function 宣告（$ 跨檔規則）；派工與重算六段從 ./register 匯入（循環匯入是既有做法）。
import { atom, read, update } from 'claude-code'
import type { PluginOptions } from 'claude-code'
import type { Case, Snapshot } from '../types'
import { KIND_LABEL, markRefusalStop, pushRequest, queueRefusal } from './dispatch'
import { normalizeRoot } from './settings'
import { runningDeskAgents } from './agents'
import type { DispatchKind, QueueEntry, QueueOpts } from './dispatch'
import type { DispatchSettings } from './settings'
import type { RawAgent } from './agents'
import { paused } from './chain'
import type { ChainRun, QuotaResume } from './chain'
import { feedPush, loadChains, loadJobs, me, saveChain } from './desk-io'
import { loadSettings, worktreeMark } from './probes'
import { quotaHold, quotaLow } from './model'
import { causeText } from './stop-reason'
import type { StopCause, StopReason } from './stop-reason'
import { trustedChecks } from './approve-check'
import { dispatch, launchingCount, notify, restage, verifyPending } from './register'
import { pauseUnsentReviewFix } from './auto-chain'
import { t } from './i18n'

/** 畫面用：排隊中的卡片路徑，依序。 */
const agentQueueAtom = atom({ plugin: 'desk', key: 'agentQueue' } as const, [])
let agentQueue: readonly QueueEntry[] = []

const CANCELLED = t('agentQueue.cancelled')

/** 這件在派工隊伍的第幾位（1 起）；不在隊伍是 0。 */
export const queuePosition = (statusPath: string): number => agentQueue.findIndex(e => e.statusPath === statusPath) + 1
export const isAgentQueued = (statusPath: string): boolean => queuePosition(statusPath) > 0
export const hasAgentQueue = (): boolean => agentQueue.length > 0

/** 隊伍裡這筆派的是什麼：修正第幾輪、資安審查，其他照派工種類。 */
export const labelOf = (kind: DispatchKind, opts: QueueOpts): string => opts.fix ? t('word.fixRound', { round: opts.fix.round }) : opts.security ? t('word.securityReview') : KIND_LABEL[kind]

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
  const text = opts.auto && !opts.resumed ? t('agentQueue.queuedAuto', { name: c.name, label, n: at }) : t('agentQueue.queued', { name: c.name, label, n: at, max })
  await feedPush($, [{ at: now, text, tone: 'suggestion', card: c.statusPath }])
  if (!opts.auto || opts.resumed) $.ui.toast(t('agentQueue.queuedToast', { name: c.name, max, n: at }), { timeoutMs: 6000 })
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
async function pauseOwnChain($: any, c: Case, mine: string, why: StopCause, resume?: QuotaResume): Promise<boolean> {
  // 看 saveChain 的回傳值：閉包在重套時會再跑，寫入被別的對話蓋掉、放棄時也不算停下。
  return saveChain($, normalizeRoot(c.root), r => !r || r.owner !== mine || r.stopped ? r : paused(r, why, false, resume))
}

/** 排隊的自動流程派工被額度擋下時記下那一步（按 g 直接派它）；推送、解衝突不在流程裡，不記。 */
function queuedResume(entry: Pick<QueueEntry, 'kind' | 'opts'>, run: ChainRun | undefined): QuotaResume | undefined {
  if (entry.kind !== 'continue' && entry.kind !== 'review') return undefined
  const fix = entry.opts.fix
  return { dispatch: entry.kind, round: fix?.round ?? run?.round ?? 0, ...(entry.opts.security ? { security: true } : {}), ...(fix?.from ? { reason: fix.from } : {}) }
}

/** 自動排的這筆沒派出時要不要停下流程：推送是審查過關後才排的，沒派出流程仍是過關，合併段照舊可以按「⇡ 開 PR」。 */
const pausesChain = (entry: Pick<QueueEntry, 'kind' | 'opts'>) => !!entry.opts.auto && entry.kind !== 'publish'

/**
 * 從隊伍取出卻沒派出（已不在隊伍裡）：寫動態說原因；自動排的（推送除外）另把流程停下寫同一個原因。
 * `alert`：要人處理的原因（worktree 被別的對話改了），流程真的停下時跟自動流程一樣跳提示並發系統通知。
 */
export async function notSent($: any, c: Case | undefined, entry: Pick<QueueEntry, 'statusPath' | 'kind' | 'opts'>, cause: StopCause, now: number, mine: string, alert = false, resume?: QuotaResume) {
  const name = c?.name ?? entry.statusPath
  const why = causeText(cause)
  await feedPush($, [{ at: now, text: t('agentQueue.notSent', { name, label: labelOf(entry.kind, entry.opts), why }), tone: 'warning', card: entry.statusPath }])
  if (!pausesChain(entry) || !c) return
  if (!(await pauseOwnChain($, c, mine, cause, resume)) || !alert) return
  const say = t('toast.chainPaused', { name, why })
  $.ui.toast(say, { timeoutMs: 10_000 })
  notify($, say)
}

/** 移出隊伍、說為什麼沒派（見 notSent），重算那件的六段。 */
async function drop($: any, entry: QueueEntry, c: Case | undefined, why: StopCause, now: number, mine: string, alert = false, resume?: QuotaResume) {
  await setQueue($, agentQueue.filter(e => e !== entry))
  await notSent($, c, entry, why, now, mine, alert, resume)
  await restage($, entry.statusPath)
}

/**
 * 排隊期間 worktree 有了不是上一個 Agent 留下的未提交改動（別的對話在改）：不派。排進隊伍時看過的那次可能是很久以前，
 * 派出前再看一次；同步不改程式、推送只推已 commit 的，不看。
 */
async function foreignChanges($: any, c: Case, entry: QueueEntry): Promise<StopCause | null> {
  if (entry.kind === 'sync' || entry.kind === 'publish') return null
  return markRefusalStop(await worktreeMark($, c.root), (await loadJobs($))[normalizeRoot(c.root)])
}

/** 手動排的繼續：排隊時核准的完成檢查跟卡片現在的不同，就不替你派。 */
function approvalChanged(c: Case, entry: QueueEntry, trusted: Record<string, string>): string {
  if (entry.kind !== 'continue' || entry.opts.auto || !c.verify) return ''
  return trusted[c.statusPath] === c.verify ? '' : t('agentQueue.approvalChanged')
}

/** 自動排的開 PR 排隊期間 PR 已經開了（例如你按了「⇡ 開 PR」）：改成只 push，不再要求開第二個。 */
function queuedOpts(c: Case, entry: QueueEntry): QueueEntry['opts'] {
  if (entry.kind !== 'publish' || !entry.opts.auto || c.pr?.state !== 'OPEN') return entry.opts
  return { ...entry.opts, text: pushRequest(c.git?.branch ?? '分支', c.pr.id) }
}

/**
 * 排隊的自動項目被額度煞車擋下的原因：推送寫要推請按哪個鈕（不暫停流程）；解衝突照直接派被擋時的結尾（合併段沒有 g，在對話處理）；其他按 g 重開。
 */
function queuedHold(entry: QueueEntry, c: Case | undefined, hold: StopReason, s: Snapshot, threshold: number): StopCause {
  // 推送不暫停流程（不寫進流程紀錄），原因只進動態，照舊是句子。
  if (entry.kind === 'publish') return t('agentQueue.quotaPush', { low: quotaLow(s.limits, threshold, s.at), button: c?.pr?.state === 'OPEN' ? t('word.pushButton') : t('word.openPrButton') })
  // 會停下流程的一律存代碼：hold 是呼叫端算好的審查段煞車，解衝突換成合併段那種（同一份額度，一定也低於門檻）。
  return entry.kind === 'catchup' ? quotaHold(s.limits, threshold, s.at, true) ?? hold : hold
}

/**
 * 有空位就照順序派出排隊的：用這一輪重新整理的清單與快照算名額，每派出一件就重算，直到滿或隊伍空。
 * 輪到的那件現在不能派就移出並說原因；完成檢查正在跑或在檢查隊伍裡就先跳過、留在原位。回傳有沒有派出任何一件。
 * preloaded：重新整理這一輪已讀好的設定，有就不再讀 dispatch.json。
 */
export async function drainAgentQueue($: any, options: PluginOptions, s: Snapshot, list: readonly RawAgent[] | null, preloaded?: DispatchSettings): Promise<boolean> {
  if (!agentQueue.length) return false
  const settings = await loadSettings($, options, preloaded)
  const max = settings.maxAgents
  // 額度煞車：自動流程排的（含自動推送）輪到時額度低於門檻就不派；你手動排的不看額度。
  const hold = quotaHold(s.limits, settings.chainQuotaStop, s.at)
  const chains = await loadChains($)
  const mine = await me($)
  const trusted = await trustedChecks($)
  let running = (list ? runningDeskAgents(list) : 0) + launchingCount()
  let launched = false
  for (const entry of [...agentQueue]) {
    if (max > 0 && running >= max) break
    const c = s.cases.find(x => x.statusPath === entry.statusPath)
    const why = !c ? t('agentQueue.gone') : queueRefusal(c, entry, chains[normalizeRoot(c.root)], mine) || approvalChanged(c, entry, trusted)
    if (why) { await drop($, entry, c, why, s.at, mine); continue }
    // 推送不在流程裡、沒派出流程仍是過關：原因不寫按 g 重開，改寫要推請按哪個鈕（跟過關時直接派被擋的說法一樣）。
    // 你按 g 接續的那筆（resumed）是手動派的：不看額度。
    if (hold && entry.opts.auto && !entry.opts.resumed) { await drop($, entry, c, queuedHold(entry, c, hold, s, settings.chainQuotaStop), s.at, mine, true, queuedResume(entry, chains[normalizeRoot(c.root)])); continue }
    if (verifyPending(entry.statusPath)) continue
    const foreign = await foreignChanges($, c!, entry)
    if (foreign) { await drop($, entry, c, foreign, s.at, mine, true); continue }
    const index = agentQueue.indexOf(entry)
    await setQueue($, agentQueue.filter(e => e !== entry))
    const sent = await dispatch($, options, entry.opts.auto ? { ...c!, state: 'ready' } : c!, entry.kind, { ...queuedOpts(c!, entry), fromQueue: index })
    // 名額被別處搶走：dispatch 已把它放回原位，這一輪不再派。
    if (isAgentQueued(entry.statusPath)) break
    if (sent) { running++; launched = true }
    else {
      // 自動排的審查修正從隊伍派出卻沒派成：跟直接派一樣停下這個對話的流程（不在隊伍、不是已啟動未列出才停）。
      if (entry.opts.auto && entry.opts.fix?.from === 'review') await pauseUnsentReviewFix($, c!, mine, s.at)
      await restage($, entry.statusPath)
    }
  }
  return launched
}

/** 取消自動流程排的派工：流程跟著停下，說清楚要按 g 重開。 */
const CANCELLED_PAUSED = t('agentQueue.unqueuedPaused')
/** 取消自動排的解衝突：合併段沒有 g 可按，照解衝突被擋下時的說法，在對話處理。 */
const CANCELLED_PAUSED_CATCHUP = t('agentQueue.unqueuedPausedCatchup')

/** 面板的「■ 取消排隊」：移出隊伍、寫動態；自動排的（推送除外）把這個對話的流程停下，提示與動態說流程已暫停。 */
export async function cancelQueued($: any, c: Case) {
  const entry = agentQueue.find(e => e.statusPath === c.statusPath)
  if (!entry) return
  await setQueue($, agentQueue.filter(e => e !== entry))
  // 流程是別的對話的（pauseOwnChain 不動它）就不說暫停。
  const paused = pausesChain(entry) && await pauseOwnChain($, c, await me($), CANCELLED)
  const said = !paused ? t('agentQueue.unqueued') : entry.kind === 'catchup' ? CANCELLED_PAUSED_CATCHUP : CANCELLED_PAUSED
  await feedPush($, [{ at: await $.clock.now(), text: t('feed.named', { name: c.name, text: said }), tone: 'suggestion', card: c.statusPath }])
  $.ui.toast(t('toast.named', { name: c.name, text: said }))
  await restage($, c.statusPath)
}

/** 新對話與 /desk off：隊伍清空，不補派。 */
export async function clearAgentQueue($: any) {
  await setQueue($, [])
}

// 背景 Agent 派工與執行排程。
import { atom, read, update } from 'claude-code'
import type { PluginOptions } from 'claude-code'
import type { AgentInfo, Case } from '../types'
import { DEMO_ONLY } from './card-actions'
import { KIND_LABEL, REVIEW_FILE, SECURITY_FILE, buildPrompt, dispatchRefusal, launchName, markRefusal, modelFor, normalizeRoot, pitfallsFor, runningDeskAgents } from './dispatch'
import type { DispatchKind, JobRecord, QueueOpts, RawAgent, RootJobs, ReviewOpts } from './dispatch'
import { isApproved, trustedChecks, unapprovedText } from './approve-check'
import { loadSettings, deskPaths, diffBase, gitProbe, home, originRemote, worktreeMark } from './probes'
import { me, loadJobs, loadChains, saveChain, confirmed, feedPush, tellPanel, launch, JOBS_KEY } from './desk-io'
import { hasAgentQueue, isAgentQueued, notSent, queuePosition, enqueueDispatch, requeue } from './agent-queue'
import { startSim } from './tutorial-run'
import { rawAgents, supersede, agentInfo, agentsByRoot } from './model'
import { isBusy } from './turn'
import { WORD } from './theme'
import { lastLaunches } from './stale-agents'
import { restage, spin, tutorial, lastAgents } from './register'

const snapshot = atom({ plugin: 'desk', key: 'snapshot' } as const, null)
const launchingAtom = atom({ plugin: 'desk', key: 'launching' } as const, {})

/** 按下時再問一次背景 agent 清單的上限：查不到就照快照，不讓按鈕卡太久。 */
export const PRESS_AGENTS_MS = 10_000

/**
 * 這個對話佔了名額、還沒派完的派工（卡片路徑）：通過名額判斷就同步佔位，派完（成功、失敗或拋錯）才放掉。
 * 「啟動中」佔位要等幾個 await 之後才寫，只看它的話，同時派好幾件會都看到有空位。
 */
export const slots = new Set<string>()
export const LAUNCHING = '上一次派工仍在啟動'

/** 派工啟動中的那幾件派的是什麼：「啟動中」佔位帶著它，流程派審查的那一刻六段不退回實作。 */
export let launchKinds: Record<string, NonNullable<AgentInfo['kind']>> = {}
let launchSeq = 0

/** 這個對話正在啟動中的派工有幾件。 */
export const launchingCount = (): number => slots.size

export function resetDispatchState() {
  slots.clear()
  launchKinds = {}
  launchSeq = 0
}

/**
 * 面板上的檢查、確認規格、上線確認、歸檔按下時才看最新狀態：按鈕可能是 Agent 開始前畫的，
 * 那件現在執行中或等批准就不動 worktree 與卡片、也不待確認，toast 說明。自動流程的檢查不經過這裡。
 */
export async function busyRefused($: any, c: Case, doing: string, live = true): Promise<boolean> {
  if (!(await busyNow($, c, live))) return false
  $.ui.toast(`${c.name}：${WORD.busyRefused}${doing}`)
  return true
}

/**
 * 那件現在是不是執行中或等批准：先看最新快照；live 再問一次 claude agents（約 0.7 秒）。
 * 要按兩次的動作第一次只看快照，免得查詢拖過確認時限；真的要做的那一次才 live。
 */
export async function busyNow($: any, c: Case, live: boolean): Promise<boolean> {
  const latest = (await read($, snapshot))?.cases.find(x => x.statusPath === c.statusPath) ?? c
  if (isBusy(latest)) return true
  return live && await startedSince($, latest)
}

/** 按兩次確認的動作：第一次只看快照就待確認，第二次（真的要做）才即時查 Agent。 */
export async function confirmedIdle($: any, c: Case, key: string, doing: string): Promise<boolean> {
  if (await busyRefused($, c, doing, false)) return false
  return await confirmed($, `${c.statusPath}\n${key}`) && !(await busyRefused($, c, doing))
}

/** 快照之後才開始跑的 Agent：下一輪重新整理前快照還不知道，按下時直接問 claude agents。 */
export async function startedSince($: any, c: Case): Promise<boolean> {
  if (tutorial || c.demo) return false
  const out = await $.process.run(['claude', 'agents', '--json', '--all'], { timeoutMs: PRESS_AGENTS_MS }).catch(() => null)
  if (!out || out.exitCode !== 0) return false
  const agent = agentsByRoot(supersede(rawAgents(out.stdout), lastLaunches(await loadJobs($))).list)[c.root]
  return !!agent && isBusy({ ...c, agent })
}

/** 現在在跑的工作桌 Agent（整台機器）：即時問 claude agents，問不到用上一輪的清單，也沒有就當 0（不擋派工）。 */
async function runningDeskNow($: any): Promise<number> {
  const out = await $.process.run(['claude', 'agents', '--json', '--all'], { timeoutMs: PRESS_AGENTS_MS }).catch(() => null)
  const list = out && out.exitCode === 0 ? rawAgents(out.stdout) : lastAgents
  return list ? runningDeskAgents(list) : 0
}

/** 這件有派工還在啟動（已佔名額或已寫「啟動中」佔位）。 */
export async function starting($: any, statusPath: string): Promise<boolean> {
  return statusPath in (await read($, launchingAtom)) || slots.has(statusPath)
}

/** 這件有派工還在啟動，這次不派：從隊伍取出的寫動態說原因（隊伍裡已經拿掉，不默默不見），其他的跳提示。 */
async function refuseStarting($: any, c: Case, kind: DispatchKind, opts: QueueOpts & { fromQueue?: number }) {
  if (opts.fromQueue !== undefined) await notSent($, c, { statusPath: c.statusPath, kind, opts }, LAUNCHING, await $.clock.now(), await me($))
  else $.ui.toast(`${c.name}：${LAUNCHING}`)
}

/** 同一件已經排著時，手動派工回的那句（額度煞車後的接續也用）。 */
export const alreadyQueued = (c: Case) => `${c.name}：已在派工隊伍（第 ${queuePosition(c.statusPath)} 位），k 取消排隊`

/**
 * 派工：`claude --bg --name <唯一名> [--resume <任務的 session>] [--model] [--effort] <提示>` 在任務根目錄啟動，
 * 從啟動後的 agents 清單用名字對回完整 session id 才算成功；審查與（設了同步模型的）同步開新 session，不改任務的 session。
 * 同時在跑的工作桌 Agent 已達上限（maxAgents）就排進派工隊伍，有空位再依序派出。
 * `fromQueue`：從派工隊伍取出來派的，值是它原本在隊伍的位置；名額被搶走就放回那裡。
 * 回傳有沒有接手：派出或排進隊伍是 true；被拒、按了取消、啟動失敗、名額被搶走放回隊伍是 false。
 */
export async function dispatch($: any, options: PluginOptions, c: Case, kind: DispatchKind, opts: QueueOpts & { fromQueue?: number } = {}): Promise<boolean> {
  const text = opts.text ?? ''
  const fromQueue = opts.fromQueue !== undefined
  if (c.demo) { $.ui.toast(DEMO_ONLY); return false }
  const refusal = opts.auto ? '' : dispatchRefusal(c, kind)
  if (refusal) { $.ui.toast(`${c.name}：目前無法${KIND_LABEL[kind]}（${refusal}）`); return false }
  if (await starting($, c.statusPath)) { await refuseStarting($, c, kind, opts); return false }
  if (!fromQueue && isAgentQueued(c.statusPath)) { if (!opts.auto) $.ui.toast(alreadyQueued(c)); return false }
  // 派實作要先核准完成檢查（面板第二次按 g 就核准）；從隊伍派出的排隊前已核准過，排隊期間檢查改了的在隊伍那邊就擋下。
  if (kind === 'continue' && !opts.auto && !fromQueue && !isApproved(await trustedChecks($), c)) { $.ui.toast(unapprovedText(c)); return false }
  const settings = await loadSettings($, options)
  const { model, effort, fresh } = modelFor(settings, c.root, kind)
  const jobs = await loadJobs($)
  const rootKey = normalizeRoot(c.root)
  const own: RootJobs = jobs[rootKey] ?? {}
  // worktree 有不是上一個 Agent 留下的未提交改動（別的對話在改）：不派，免得把它的東西清掉。
  // 同步不改程式、推送只推已 commit 的，不擋；自動流程在派之前已經看過。
  if (kind !== 'sync' && kind !== 'publish' && !opts.auto && !tutorial) {
    const foreign = markRefusal(await worktreeMark($, c.root), own)
    if (foreign) { $.ui.toast(`${c.name}：目前無法${KIND_LABEL[kind]}（${foreign}）`, { timeoutMs: 10_000 }); return false }
  }
  const now = await $.clock.now()
  // 同時在跑的工作桌 Agent 已達上限（教學與 maxAgents 0 不限）：排進隊伍；隊伍裡已經有人在等時也排，先來先派。
  // 名額＝在跑的（整台機器）＋這個對話已佔的。問完在跑的之後，到佔位或排進隊伍之間不能有 await：同時派好幾件才不會都看到有空位。
  const { fromQueue: at, ...queued } = opts
  const full = !tutorial && settings.maxAgents > 0 && ((!fromQueue && hasAgentQueue()) || await runningDeskNow($) + slots.size >= settings.maxAgents)
  // 同一件同時派了兩次：開頭檢查時先到的還沒佔位，到這裡才擋得下後到的。
  if (slots.has(c.statusPath)) { await refuseStarting($, c, kind, opts); return false }
  if (full) {
    if (fromQueue) { await requeue($, c, kind, queued, at!); return false }
    if (await enqueueDispatch($, c, kind, queued, settings.maxAgents)) return true
    if (!opts.auto) $.ui.toast(alreadyQueued(c))
    return false
  }
  slots.add(c.statusPath)
  // 佔位之後的準備（審查要讀 git 與流程紀錄）也在 try 裡：拋錯時一樣放掉名額、說派工失敗。
  try {
    const sessionId = fresh ? undefined : kind === 'reply' && own.last?.sessionId ? own.last.sessionId : own.sessionId
    const name = launchName(now, launchSeq++)
    let review: ReviewOpts | undefined
    const probed = kind === 'review' ? (await gitProbe($, c.root)).git : undefined
    if (kind === 'review') {
      const run = (await loadChains($))[rootKey]
      const round = opts.auto ? run?.round ?? 0 : 0
      // 舊紀錄存的是分支名稱，拿來 diff 會是空的：當作沒有基準，整條分支重審。
      const recorded = opts.security ? run?.securityHead : run?.reviewHead
      const base = recorded && recorded !== c.git?.branch ? recorded : undefined
      const paths = await deskPaths($, options)
      const pitfalls = pitfallsFor(settings, paths.pitfalls, await home($))
      const template = settings.review.template || `${$.plugin.root}/templates/review.md`
      const recheck = !!opts.auto && !!run?.recheck && !opts.security
      const target = tutorial ? undefined : (await diffBase($, c, settings.cardBase))?.target
      review = { round, template, ...(target ? { target } : {}), ...((round > 0 || recheck) && base ? { base } : {}), ...(recheck ? { recheck: true } : {}), ...(opts.security ? { security: true } : {}), pitfalls: (await $.fs.exists(pitfalls).catch(() => false)) ? pitfalls : '', history: paths.reviews }
    }
    const prompt = buildPrompt(c, kind, text, opts.fix, review, settings, name)
    const doing: NonNullable<AgentInfo['kind']> = opts.fix ? 'fix' : kind
    launchKinds = { ...launchKinds, [c.statusPath]: doing }
    await update($, launchingAtom, v => ({ ...v, [c.statusPath]: now }))
    await spin($, true)
    // Bitbucket 的推送 Agent 要用 MCP 的 bb_post 開 PR：這一種派工就算沒設 mcp 也載入；專案有 pr.open 覆寫就照全域設定。
    const mcp = settings.mcp || (kind === 'publish' && !settings.prOpen && (await originRemote($, c.root))?.host === 'bitbucket')
    const confirmed = tutorial ? startSim($, options, c, kind, name, now, opts) : await launch($, c, prompt, { model, effort, sessionId, name, mcp })
    const record: JobRecord = { launchName: name, nativeId: String(confirmed.id ?? name), sessionId: confirmed.sessionId!, kind, startedAt: now, fresh, owner: await me($), ...(opts.fix ? { round: opts.fix.round } : {}), ...(opts.security ? { security: true } : {}) }
    // 手動按繼續或審查就開一輪新的流程；自動派的接續原本那輪。
    if (!opts.auto && (kind === 'continue' || kind === 'review')) await saveChain($, rootKey, r => ({ owner: record.owner!, startedAt: now, round: 0, ...(r?.judgedHead ? { judgedHead: r.judgedHead, ...(r.judgedBranch ? { judgedBranch: r.judgedBranch } : {}) } : {}) }))
    // 派審查時的 HEAD 連同它所在的分支一起記：合併辨識只認「這條分支」看過的 HEAD。
    if (kind === 'review' && probed) await saveChain($, rootKey, r => r ? { ...r, ...(opts.security ? { securityHead: probed.head, securityBranch: probed.branch } : { reviewHead: probed.head, reviewBranch: probed.branch }) } : r)
    // 自動派的解衝突真的派出去了，才記這個 HEAD 試過（同一個 HEAD 只自動試一次）。
    const tried = c.git?.head
    if (kind === 'catchup' && opts.auto && tried) await saveChain($, rootKey, r => r ? { ...r, catchupHead: tried } : r)
    const next: RootJobs = { ...(fresh ? { sessionId: own.sessionId } : { sessionId: confirmed.sessionId! }), ...(own.mark !== undefined ? { mark: own.mark } : {}), last: record }
    await $.store.set(JOBS_KEY, { ...jobs, [rootKey]: next })
    const agent: AgentInfo = { ...agentInfo(confirmed), status: 'busy', kind: doing }
    await restage($, c.statusPath, x => ({ ...x, agent, state: 'running' }))
    const label = opts.fix ? `修正第 ${opts.fix.round} 輪` : opts.security ? '資安審查' : KIND_LABEL[kind]
    const sent = `派${label}（${model || '預設模型'}${fresh ? '・新對話' : ''}）`
    await feedPush($, [{ at: now, text: `${c.name} ${opts.auto ? '自動' : ''}${sent}`, tone: 'suggestion', card: c.statusPath }])
    await tellPanel($, now, sent, { name: c.name, skip: opts.auto || tutorial })
    $.ui.toast(`${c.name}：${label}已派出`, { timeoutMs: 6000 })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await feedPush($, [{ at: now, text: `${c.name} ${KIND_LABEL[kind]}失敗：${message}`, tone: 'error', card: c.statusPath }])
    await tellPanel($, now, `${KIND_LABEL[kind]}失敗：${message}`, { name: c.name, skip: opts.auto || tutorial })
    $.ui.toast(`${c.name}：${KIND_LABEL[kind]}失敗，${message}`, { timeoutMs: 8000 })
    return false
  } finally {
    slots.delete(c.statusPath)
    launchKinds = Object.fromEntries(Object.entries(launchKinds).filter(([k]) => k !== c.statusPath))
    await update($, launchingAtom, v => Object.fromEntries(Object.entries(v).filter(([k]) => k !== c.statusPath)))
    await spin($, false)
  }
}

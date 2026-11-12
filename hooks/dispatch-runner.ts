// 背景 Agent 派工與執行排程。
import { atom, read, update } from 'claude-code'
import type { PluginOptions } from 'claude-code'
import type { AgentInfo, Case, Verify } from '../types'
import { KIND_LABEL, LaunchError, REVIEW_FILE, SECURITY_FILE, buildPrompt, fixesByG, markRefusal, refusalOf, refusalText, untrustedSteps, readsPitfalls } from './dispatch'
import { addRunTime, dispatchRunMs } from './run-time'
import { modelFor, normalizeRoot, pitfallsFor } from './settings'
import type { DispatchKind, JobRecord, QueueOpts, RootJobs, ReviewOpts, UntrustedHold } from './dispatch'
import type { DispatchSettings } from './settings'
import type { RawAgent } from './agents'
import { isApproved, trustedChecks, unapprovedText } from './approve-check'
import { loadSettings, deskPaths, diffBase, diffFiles, gitProbe, home, originRemote, riskOf, worktreeMark } from './probes'
import { me, loadJobs, loadChains, saveChain, confirmed, feedPush, tellPanel, launch, runGraceMs, JOBS_KEY } from './desk-io'
import { hasAgentQueue, isAgentQueued, labelOf, notSent, queuePosition, enqueueDispatch, requeue } from './agent-queue'
import { startSim } from './tutorial-run'
import { rawAgents, supersede, agentInfo, agentsByRoot, launchName, runningDeskAgents } from './agents'
import { isBusy, untrustedKey } from './turn'
import { WORD, DEMO_ONLY } from './theme'
import { lastLaunches } from './stale-agents'
import { restage, spin, tutorial, lastAgents, lastAgentsAt } from './register'
import { carriedFix, carriedReview, countedFix } from './chain'
import { checkStands } from './pipeline'
import { fixesReview } from './prompts/fix'
import { t } from './i18n'

const snapshot = atom({ plugin: 'desk', key: 'snapshot' } as const, null)
const launchingAtom = atom({ plugin: 'desk', key: 'launching' } as const, {})
const verifiesAtom = atom({ plugin: 'desk', key: 'verifies' } as const, {} as Record<string, Verify>)
/** 派工因為 repo 還沒信任而開不了的那幾件（卡片路徑 → 擋下原因）：面板的「輪到你」改說三步；派工開頭與成功派出時清掉。 */
const untrustedAtom = atom({ plugin: 'desk', key: 'untrusted' } as const, {} as Record<string, UntrustedHold>)

/** 三步說明比一般失敗長：toast 留久一點。 */
const UNTRUSTED_TOAST_MS = 15_000

/** 拿掉這件的「還沒信任」紀錄。 */
async function clearUntrusted($: any, statusPath: string) {
  await update($, untrustedAtom, v => (statusPath in v ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== statusPath)) : v))
}

/**
 * 啟動失敗是因為 repo 還沒信任：記下這件派的是哪一種，動態、toast 與對話說三步（③ 跟「輪到你」同一個鍵：手動派的是剛按的鍵，自動流程派的照原本「輪到你」的派工鍵）。
 * 鍵用快照裡這件的樣子算（跟面板同一份）：自動流程派工傳進來的是 state 改成 ready 的複本，檢查失敗那種會算錯鍵。
 */
async function holdUntrusted($: any, c: Case, kind: DispatchKind, now: number, auto: boolean, skipPanel: boolean) {
  const hold: UntrustedHold = { kind: 'untrusted', root: c.root, at: now, dispatch: kind, auto }
  await update($, untrustedAtom, v => ({ ...v, [c.statusPath]: hold }))
  const shown = (await read($, snapshot))?.cases.find(x => x.statusPath === c.statusPath) ?? c
  const steps = untrustedSteps(c.root, untrustedKey(shown, hold))
  const named = t('toast.named', { name: c.name, text: steps })
  await feedPush($, [{ at: now, text: named, tone: 'error', card: c.statusPath }])
  await tellPanel($, now, steps, { name: c.name, skip: skipPanel })
  $.ui.toast(named, { timeoutMs: UNTRUSTED_TOAST_MS })
}

/** 按下時再問一次背景 agent 清單的上限：查不到就照快照，不讓按鈕卡太久。 */
export const PRESS_AGENTS_MS = 10_000

/**
 * 這個對話佔了名額、還沒派完的派工（卡片路徑）：通過名額判斷就同步佔位，派完（成功、失敗或拋錯）才放掉。
 * 「啟動中」佔位要等幾個 await 之後才寫，只看它的話，同時派好幾件會都看到有空位。
 */
export const slots = new Set<string>()
export const LAUNCHING = t('dispatchRunner.launching')

/** 派工啟動中的那幾件派的是什麼：「啟動中」佔位帶著它，流程派審查的那一刻六段不退回實作。 */
export let launchKinds: Record<string, NonNullable<AgentInfo['kind']>> = {}
let launchSeq = 0

/** 這個對話正在啟動中的派工有幾件。 */
export const launchingCount = (): number => slots.size

/** 最近一次派工「已啟動、但 agents 清單還沒列出」的那幾件（卡片路徑）：Agent 可能已經在跑，自動重派前要看這裡。派出成功時拿掉。 */
export const unconfirmed = new Set<string>()

export function resetDispatchState() {
  slots.clear()
  unconfirmed.clear()
  launchKinds = {}
  launchSeq = 0
  lastLaunchAt = -Infinity
}

/**
 * 面板上的檢查、確認規格、上線確認、歸檔按下時才看最新狀態：按鈕可能是 Agent 開始前畫的，
 * 那件現在執行中或等批准就不動 worktree 與卡片、也不待確認，toast 說明。自動流程的檢查不經過這裡。
 */
export async function busyRefused($: any, c: Case, doing: string, live = true): Promise<boolean> {
  if (!(await busyNow($, c, live))) return false
  $.ui.toast(t('toast.named', { name: c.name, text: `${WORD.busyRefused}${doing}` }))
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

/** 重新整理讀到的 agents 清單在這麼久之內，派工直接沿用（算名額、當啟動前的清單），不再跑一次 claude agents。 */
export const AGENTS_FRESH_MS = 5_000

/**
 * 這個對話最近一次派工啟動的時間：呼叫 claude --bg 之前記一次，launch 回來或丟錯之後再記一次。
 * 晚於它送出的清單才算數：啟動前、或 claude --bg 還沒回來時送出的清單可能看不到剛派出的 Agent，名額會少算。
 */
let lastLaunchAt = -Infinity

/** `at`（含）之後這個對話有派工啟動或啟動結束（lastLaunchAt）：那時送出的 agents 清單可能看不到剛派出的 Agent。從沒派過就是 false。 */
export function launchedSince(at: number): boolean {
  return lastLaunchAt !== -Infinity && lastLaunchAt >= at
}

/**
 * 可以沿用的 agents 清單：重新整理在 AGENTS_FRESH_MS 內送出、而且送出的時間晚於 lastLaunchAt（同一毫秒不算）；
 * 不符合（太舊、從沒讀到、在派工啟動前或啟動中送出）就回 undefined，照舊即時問。
 */
function recentAgents(now: number): readonly RawAgent[] | undefined {
  if (!lastAgents || launchedSince(lastAgentsAt)) return undefined
  return now - lastAgentsAt < AGENTS_FRESH_MS ? lastAgents : undefined
}

/**
 * 現在在跑的工作桌 Agent（整台機器）：清單剛讀過就沿用（recentAgents），不然即時問 claude agents；
 * 問不到用上一輪的清單，也沒有就當 0（不擋派工）。
 */
async function runningDeskNow($: any): Promise<number> {
  const recent = recentAgents(await $.clock.now())
  if (recent) return runningDeskAgents(recent)
  const out = await $.process.run(['claude', 'agents', '--json', '--all'], { timeoutMs: PRESS_AGENTS_MS }).catch(() => null)
  const list = out && out.exitCode === 0 ? rawAgents(out.stdout) : lastAgents
  return list ? runningDeskAgents(list) : 0
}

/**
 * 呼叫 launch，前後各記一次 lastLaunchAt：claude --bg 還沒回來時送出的清單也不沿用。
 * 丟錯也記（確認不到、確認時出錯的 Agent 可能已經在跑）。
 */
async function launchMarked($: any, c: Case, prompt: string, o: Parameters<typeof launch>[3], recent: readonly RawAgent[] | undefined) {
  launchEvents++
  lastLaunchAt = await $.clock.now()
  try {
    return await launch($, c, prompt, o, recent)
  } finally {
    launchEvents++
    lastLaunchAt = await $.clock.now()
  }
}

/** 這個對話派工啟動開始與結束的次數（各算一次）；重新整理比對問清單前後的值，看清單送出後有沒有派工動過。 */
let launchEvents = 0
export const launchEventCount = (): number => launchEvents

/** 這件有派工還在啟動（已佔名額或已寫「啟動中」佔位）。 */
export async function starting($: any, statusPath: string): Promise<boolean> {
  return statusPath in (await read($, launchingAtom)) || slots.has(statusPath)
}

/** 這件有派工還在啟動，這次不派：從隊伍取出的寫動態說原因（隊伍裡已經拿掉，不默默不見），其他的跳提示。 */
async function refuseStarting($: any, c: Case, kind: DispatchKind, opts: QueueOpts & { fromQueue?: number }) {
  if (opts.fromQueue !== undefined) await notSent($, c, { statusPath: c.statusPath, kind, opts }, LAUNCHING, await $.clock.now(), await me($))
  else $.ui.toast(t('toast.named', { name: c.name, text: LAUNCHING }))
}

/** 啟動失敗的錯誤只留最後一行、截到這麼多字（多的換成「…」）。 */
export const LAUNCH_ERROR_MAX = 80

/**
 * 換上新派工前這個根目錄要留下的紀錄（不含 last、sessionId，由呼叫端換上新的）。上一次派工還沒記結束（例如停著等回覆、按 y 回覆）：
 * 它在跑的時間先加進總執行時間，換掉之後就不會再算到它。
 */
export function carriedJobs(cur: RootJobs | undefined, now: number, grace: number, branch: string | undefined): RootJobs {
  const prev = cur?.last
  const kept = prev && !prev.ended ? addRunTime(cur, dispatchRunMs(prev, now, grace), branch) : cur ?? {}
  const { last: _, sessionId: _s, ...rest } = kept
  return rest
}

/** 派工沒做成：「無法派<種類>（<錯誤最後一行>）；<怎麼重試>」；toast、動態與下一則對話提示共用。 */
export function launchFailed(label: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const last = message.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop() ?? t('dispatchRunner.noError')
  const shown = [...last].length > LAUNCH_ERROR_MAX ? `${[...last].slice(0, LAUNCH_ERROR_MAX).join('')}…` : last
  return t('dispatchRunner.launchFailed', { label, error: shown })
}

/** 同一件已經排著時，手動派工回的那句（額度煞車後的接續也用）。 */
export const alreadyQueued = (c: Case): string => t('dispatchRunner.alreadyQueued', { name: c.name, n: queuePosition(c.statusPath) })

/**
 * 審查看的範圍與省略：diff 的基準分支；工作桌的完成檢查在派審查時的 HEAD 通過（指令沒變）就帶 verifiedHead，審查不重跑整套；
 * 設了 review.preflightMinFiles 才數 diff 檔數；設了 review.combineSecurity、分支是高風險、這次是程式碼審查時帶 securityFocus。
 */
async function reviewScope($: any, c: Case, probed: Case['git'], settings: DispatchSettings, security: boolean): Promise<Pick<ReviewOpts, 'target' | 'verifiedHead' | 'files' | 'securityFocus'>> {
  const at = { ...c, ...(probed ? { git: probed } : {}) }
  const found = (settings.review.preflightMinFiles ?? 0) > 0 ? await diffFiles($, at, settings.cardBase) : await diffBase($, at, settings.cardBase)
  const verify = ((await read($, verifiesAtom)) as Record<string, Verify>)[c.statusPath]
  // HEAD 要對得上（不只是沒移動）：讀不到 HEAD、舊紀錄沒記 HEAD 都照舊重跑。
  const verifiedHead = checkStands(at, verify) === true && verify?.head && verify.head === at.git?.head ? verify.head : undefined
  const securityFocus = !security && !!settings.review.combineSecurity && (await riskOf($, at, settings.riskHigh, settings.cardBase)).level === 'high'
  return {
    ...(found ? { target: found.target } : {}),
    ...(verifiedHead ? { verifiedHead } : {}),
    ...(found && 'files' in found ? { files: found.files.length } : {}),
    ...(securityFocus ? { securityFocus: true } : {}),
  }
}

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
  // 自動派工跳過手動的拒絕檢查，較新格式的卡另外擋：自動的不跳 toast（動態已警告過一次）。
  if (opts.auto && c.newerFormat) return false
  const refusal = opts.auto ? null : refusalOf(c, kind)
  if (refusal) { $.ui.toast(refusalText(c.name, KIND_LABEL[kind], refusal)); return false }
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
    if (foreign) { $.ui.toast(t('toast.cantDispatch', { name: c.name, what: KIND_LABEL[kind], why: foreign }), { timeoutMs: 10_000 }); return false }
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
  await clearUntrusted($, c.statusPath)
  // 佔位之後的準備（審查要讀 git 與流程紀錄）也在 try 裡：拋錯時一樣放掉名額、說派工失敗。
  try {
    const sessionId = fresh ? undefined : kind === 'reply' && own.last?.sessionId ? own.last.sessionId : own.sessionId
    const name = launchName(now, launchSeq++)
    let review: ReviewOpts | undefined
    const probed = kind === 'review' ? (await gitProbe($, c.root)).git : undefined
    // 常犯錯誤清單：審查、實作與回覆讀，修正（自動修正輪與按 g 的修正）不讀、不查檔；檔案不在就不給。
    const paths = kind === 'review' || readsPitfalls(c, kind, opts.fix) ? await deskPaths($, options) : undefined
    const pitfallsPath = paths ? pitfallsFor(settings, paths.pitfalls, await home($)) : ''
    const pitfalls = pitfallsPath && (await $.fs.exists(pitfallsPath).catch(() => false)) ? pitfallsPath : ''
    if (kind === 'review' && paths) {
      const run = (await loadChains($))[rootKey]
      const round = opts.auto ? run?.round ?? 0 : 0
      // 舊紀錄存的是分支名稱，拿來 diff 會是空的：當作沒有基準，整條分支重審。
      const recorded = opts.security ? run?.securityHead : run?.reviewHead
      const base = recorded && recorded !== c.git?.branch ? recorded : undefined
      const template = settings.review.template || `${$.plugin.root}/templates/review.md`
      const recheck = !!opts.auto && !!run?.recheck && !opts.security
      review = { round, template, ...(tutorial ? {} : await reviewScope($, c, probed, settings, !!opts.security)), ...((round > 0 || recheck) && base ? { base } : {}), ...(recheck ? { recheck: true } : {}), ...(opts.security ? { security: true } : {}), pitfalls }
    }
    const prompt = buildPrompt(c, kind, text, opts.fix, review, settings, name, pitfalls)
    const doing: NonNullable<AgentInfo['kind']> = opts.fix ? 'fix' : kind
    launchKinds = { ...launchKinds, [c.statusPath]: doing }
    await update($, launchingAtom, v => ({ ...v, [c.statusPath]: now }))
    await spin($, true)
    // Bitbucket 的推送 Agent 要用 MCP 的 bb_post 開 PR：這一種派工就算沒設 mcp 也載入；專案有 pr.open 覆寫就照全域設定。
    const mcp = settings.mcp || (kind === 'publish' && !settings.prOpen && (await originRemote($, c.root))?.host === 'bitbucket')
    // 剛讀過的 agents 清單當啟動前的清單（不再跑一次）；先取再記這次啟動的時間，之後的派工才不會沿用看不到這個 Agent 的清單。
    const recent = tutorial ? undefined : recentAgents(await $.clock.now())
    const confirmed = tutorial ? startSim($, options, c, kind, name, now, opts) : await launchMarked($, c, prompt, { model, effort, sessionId, name, mcp }, recent)
    const record: JobRecord = { launchName: name, nativeId: String(confirmed.id ?? name), sessionId: confirmed.sessionId!, kind, startedAt: now, fresh, owner: await me($), ...(opts.fix ? { round: opts.fix.round } : {}), ...(opts.security ? { security: true } : {}) }
    // 手動按繼續或審查就開一輪新的流程；自動派的接續原本那輪。同一條分支累計的修正數照帶（不歸零）；
    // 「這條分支審查過」也照帶：按 g 改完只跑測試、不複審（按 w 照樣派審查）。
    // 你按 g 派的修正不受上限擋，但照樣算一輪；Agent 被停掉後重開、停在檢查段時按 g 不是修正，不算（fixesByG）。
    const fixed = kind === 'continue' && fixesByG(c)
    if (!opts.auto && (kind === 'continue' || kind === 'review')) await saveChain($, rootKey, r => ({ owner: record.owner!, startedAt: now, round: 0, ...carriedFix(r, c.git?.branch, fixed), ...carriedReview(r, c.git?.branch), ...((fixed && fixesReview(c)) || (r?.reviewFix && !r.passed) ? { reviewFix: true } : {}), ...(r?.judgedHead ? { judgedHead: r.judgedHead, ...(r.judgedBranch ? { judgedBranch: r.judgedBranch } : {}) } : {}) }))
    // 自動流程的修正（含從隊伍派出的）真的派出去了才算一輪：排隊後被額度煞車或別的原因丟掉的不算。
    if (opts.auto && opts.fix) await saveChain($, rootKey, r => r ? { ...r, ...countedFix(r, c.git?.branch) } : r)
    // 派審查時的 HEAD 連同它所在的分支一起記：合併辨識只認「這條分支」看過的 HEAD。
    if (kind === 'review' && probed) await saveChain($, rootKey, r => r ? { ...r, ...(opts.security ? { securityHead: probed.head, securityBranch: probed.branch } : { reviewHead: probed.head, reviewBranch: probed.branch }) } : r)
    // 自動派的解衝突真的派出去了，才記這個 HEAD 試過（同一個 HEAD 只自動試一次）。
    const tried = c.git?.head
    if (kind === 'catchup' && opts.auto && tried) await saveChain($, rootKey, r => r ? { ...r, catchupHead: tried } : r)
    unconfirmed.delete(c.statusPath)
    // 派工一開始讀的紀錄已經過了好幾秒（算指紋、派出）：重讀一次，這段時間別處記下的結束、檢查時間、指紋才不會被蓋掉。
    const latest = await loadJobs($)
    const next: RootJobs = { ...carriedJobs(latest[rootKey], now, runGraceMs(options), c.git?.branch), sessionId: fresh ? latest[rootKey]?.sessionId : confirmed.sessionId!, last: record }
    await $.store.set(JOBS_KEY, { ...latest, [rootKey]: next })
    const agent: AgentInfo = { ...agentInfo(confirmed), status: 'busy', kind: doing }
    await restage($, c.statusPath, x => ({ ...x, agent, state: 'running' }))
    const label = labelOf(kind, opts)
    const sent = t('dispatchRunner.sent', { label, model: model || t('paneCard.defaultModel'), fresh: fresh ? t('pane.freshSession') : '' })
    await feedPush($, [{ at: now, text: opts.auto ? t('dispatchRunner.sentAuto', { name: c.name, sent }) : t('feed.named', { name: c.name, text: sent }), tone: 'suggestion', card: c.statusPath }])
    await tellPanel($, now, sent, { name: c.name, skip: opts.auto || tutorial })
    await clearUntrusted($, c.statusPath)
    $.ui.toast(t('dispatchRunner.sentToast', { name: c.name, label }), { timeoutMs: 6000 })
    return true
  } catch (error) {
    if (error instanceof LaunchError && error.unconfirmed) unconfirmed.add(c.statusPath)
    else unconfirmed.delete(c.statusPath)
    if (error instanceof LaunchError && error.untrusted) { await holdUntrusted($, c, kind, now, !!opts.auto, !!opts.auto || tutorial); return false }
    const failed = launchFailed(KIND_LABEL[kind], error)
    await feedPush($, [{ at: now, text: t('feed.named', { name: c.name, text: failed }), tone: 'error', card: c.statusPath }])
    await tellPanel($, now, failed, { name: c.name, skip: opts.auto || tutorial })
    $.ui.toast(t('toast.named', { name: c.name, text: failed }), { timeoutMs: 8000 })
    return false
  } finally {
    slots.delete(c.statusPath)
    launchKinds = Object.fromEntries(Object.entries(launchKinds).filter(([k]) => k !== c.statusPath))
    await update($, launchingAtom, v => Object.fromEntries(Object.entries(v).filter(([k]) => k !== c.statusPath)))
    await spin($, false)
  }
}

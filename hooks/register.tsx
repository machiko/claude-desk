// desk：工作桌。讀登錄表與每件任務的 DESK 卡，摘要列一行、/desk 面板一張；決策按鍵填入、完成檢查一鍵、開啟卡片，
// 以及派工：繼續／同步／審查／回覆都是 `claude --bg` 在任務根目錄開一個背景 agent，session 對應記在 $.store。
// 不寫卡、不碰正式環境。教學模式的執行在 tutorial-run.tsx，不依賴模組狀態的 I/O 小工具在 desk-io.ts。
import { atom, read, update } from 'claude-code'
import type { Register, PluginOptions } from 'claude-code'
import type { AgentInfo, Case, Snapshot, Verify } from '../types'
import { parseRegistry, saysNone } from './card'
import { agentsByRoot, buildCase, caseNamed, demoCases, endedAlive, endedHow, events, feedOnDesk, rawAgents, supersede, asksFor, agentInfo, stateOf, settleMergedAsk, askClearedOnCard, plain, errorText, quotaHold, QUOTA_RESTART_CATCHUP, quotaLow } from './model'
import { archiveReview, clearProbeCaches, commitTime, conflictProbe, containers, deskPaths, diffBase, gitProbe, gitStatus, home, lastLine, loadSettings, logTail, mergedProbe, models, prProbe, riskOf, versions, verifyResult, worktreeMark } from './probes'
import { deploySteps, historyEntries, mediumToFix, parseReminders, preflightLine, reviewTop } from './extras'
import { layoutBand, renderBand } from './band'
import { renderPane, picksKey, moreKeyOf } from './pane'
import type { PaneActions, PaneView } from './pane'
import { KIND_LABEL, REVIEW_FILE, SECURITY_FILE, buildPrompt, dispatchRefusal, launchName, markRefusal, modelFor, normalizeRoot, pitfallsFor, replyRefusal, runningDeskAgents, specBlocks, specGapReason } from './dispatch'
import type { DispatchKind, FixReason, JobRecord, QueueOpts, RawAgent, RootJobs, ReviewOpts } from './dispatch'
import { awaitsSpecOk, blocking, canArchive, checkStands, finalState, isMerged, isReleaseLine, movedSince, parseVerdict, pipeline, runningKind } from './pipeline'
import { catchupFeed, catchupHold } from './catchup'
import { MAX_FIX_ROUNDS, handedOver, judgedAt, nextStep, paused, seenHeads } from './chain'
import { isApproved, trustCheck, trustedChecks, unapprovedText } from './approve-check'
import { missingServices } from './containers'
import { compactStatus, textKey } from './digest-status'
import type { ChainRun, ChainStep } from './chain'
import { TUTORIAL_RELEASE, tutorialPaths } from './tutorial'
import type { TutorialState } from './tutorial'
import { tutorial, TUTORIAL_KEY, setTutorial, cancelSim, simAgents, startSim, resumeTutorial, tutorialAct, tutorialStart, tutorialEnd } from './tutorial-run'
export { tutorial } from './tutorial-run'
import { checkQueue, checking, isQueued, verifyPending, runVerify, resetCheckingState } from './verify-runner'
export { checkQueue, verifyPending, runVerify } from './verify-runner'
import { slots, launchKinds, launchingCount, starting, busyNow, busyRefused, confirmedIdle, startedSince, dispatch, resetDispatchState } from './dispatch-runner'
export { dispatch, launchingCount, busyRefused, confirmedIdle } from './dispatch-runner'
import { JOBS_KEY, MAX_REFRESH_S, MIN_REFRESH_S, SESSIONS_KEY, SPIN_MS, VERIFIES_KEY, confirmed, feedPush, launch, loadChains, loadJobs, loadSummaries, me, missingRegistry, confirmThen, openPath, registryError, saveChain, statusLine, summarizeStatuses, tellPanel, toggleLogs } from './desk-io'
import { isEmpty } from './layout'
import type { Timer } from './desk-io'
import { noticeOf, versionStateOf } from './update'
import { autoUpdateCheck, isUpdating, loadUpdateCheck, markLoaded, runUpdate } from './update-run'
import { noteReleased, noteReleasedNow } from './release-update'
import { isBusy, sentState } from './turn'
import { WORD } from './theme'
import { cancelPromptSync, readSent, registerPromptSync, resetPromptSync } from './prompt-sync'
import { lastLaunches, noteCardAsks, stopEnded, stopSuperseded } from './stale-agents'
import { cancelQueued, clearAgentQueue, drainAgentQueue, enqueueDispatch, hasAgentQueue, isAgentQueued, notSent, queuePosition, readAgentQueue, requeue } from './agent-queue'
import { DEMO_ONLY, archiveCase, autoPublish, confirmShipped, confirmSpec, createRegistry, fillDecision, fillRelease, publishPr, publishPush, openCard, reply, stopAgent } from './card-actions'
import { autoPrApplies, autoPrPlan, passWords } from './auto-pr'
import type { AutoPrPlan } from './auto-pr'

const PANE = 'desk'
/** 自動派解衝突卻沒派出（不是排進隊伍）時流程停下的原因；失敗原因在動態「解衝突失敗：…」那筆。 */
const CATCHUP_NOT_SENT = '解衝突沒派出（失敗原因見動態），排除後在對話合併基準分支、解衝突'
const snapshot = atom({ plugin: 'desk', key: 'snapshot' } as const, null)
const isPaneOpen = atom({ plugin: 'desk', key: 'isPaneOpen' } as const, false)
const isBandHidden = atom({ plugin: 'desk', key: 'isBandHidden' } as const, false)
const selected = atom({ plugin: 'desk', key: 'selected' } as const, null)
const feedAtom = atom({ plugin: 'desk', key: 'feed' } as const, [])
const picksAtom = atom({ plugin: 'desk', key: 'picks' } as const, {})
const verifiesAtom = atom({ plugin: 'desk', key: 'verifies' } as const, {})
const verifyingAtom = atom({ plugin: 'desk', key: 'verifying' } as const, {})
const tick = atom({ plugin: 'desk', key: 'tick' } as const, 0)
const isExpanded = atom({ plugin: 'desk', key: 'isExpanded' } as const, false)
const contentOffset = atom({ plugin: 'desk', key: 'contentOffset' } as const, 0)
const launchingAtom = atom({ plugin: 'desk', key: 'launching' } as const, {})
const queueAtom = atom({ plugin: 'desk', key: 'checkQueue' } as const, [])
const armedAtom = atom({ plugin: 'desk', key: 'armed' } as const, null)
const logsOpenAtom = atom({ plugin: 'desk', key: 'logsOpen' } as const, null)
const logViewAtom = atom({ plugin: 'desk', key: 'logView' } as const, {})
const helpAtom = atom({ plugin: 'desk', key: 'isHelp' } as const, false)
/** 「更多動作」（m）展開當下現在卡的卡片路徑（沒有現在卡是空字串）；收合是 null。現在卡換人就不算展開。 */
const showAllAtom = atom({ plugin: 'desk', key: 'showAllActions' } as const, null)
/** 最近一次畫面 content 最多能捲到第幾列；捲動 hook 用它夾住位置（模組變數，重載後下一次畫就補上）。 */
let maxOffset = 0

let refreshTimer: Timer
let spinTimer: Timer
let active = false
let generation = 0
export let refreshing: Promise<void> | null = null
let launchSeq = 0
/** 這個對話最近一次請求的模型與 effort（turn.step 帶的）；重新載入後要等下一次請求。 */
let turnModel: { model?: string; effort?: string } = {}
let forcePr = false
/** 登錄表與每張卡片的路徑（上一輪讀到的）：對話改到它們就馬上重讀。 */
let knownPaths: string[] = []
/** 上一輪重新整理讀到的背景 agent 清單；派工時即時問不到 claude agents 就用它算名額。 */
export let lastAgents: readonly RawAgent[] | null = null
export let optionsRef: PluginOptions | undefined
const cardParseCache = new Map<string, { raw: string; steps: string[]; history: any[] }>()
const reviewTextCache = new Map<string, { raw: string; top: any[]; preflight: string | undefined }>()

const refreshMs = (options: PluginOptions) => {
  const n = Number(options.refreshSeconds)
  return (Number.isFinite(n) && n > 0 ? Math.min(MAX_REFRESH_S, Math.max(MIN_REFRESH_S, n)) : 30) * 1000
}

/** 讀一輪：登錄表 → 每張卡＋檔案時間 → 背景 agent → 快照；差異進動態與 toast。 */
export async function refresh($: any, options: PluginOptions) {
  if (refreshing) return refreshing
  refreshing = (async () => {
    const mine = generation
    const now = await $.clock.now()
    const paths = tutorial ? null : await deskPaths($, options)
    const path = tutorial ? tutorialPaths(await home($)).registry : paths!.registry
    const text = path ? await $.fs.read(path).catch(() => null) : null
    // 專案資料夾裡的登錄表還不存在：面板給「建立空的登錄表」。
    const missing = text === null && !tutorial ? await missingRegistry($, paths!) : null
    const error = text !== null ? null : tutorial ? `無法讀取教學的登錄表 ${path}；輸入 /desk tutorial end 回到你的任務` : registryError(paths!, missing)
    const rows = parseRegistry(text ?? '', await home($))
    knownPaths = [...(path ? [path] : []), ...rows.map(r => r.statusPath)]
    // desk 自己發版的待辦要在探測之前記：同回合的 archive --cleanup 會刪掉 worktree。
    if (!tutorial) await noteReleased($, rows).catch(() => { /* 只是記下 desk 發版的待辦，下一輪重新整理再看 */ })
    // 教學不看真的背景 agent，只看模擬的那一個。
    const agentsOut = tutorial ? null : await $.process.run(['claude', 'agents', '--json', '--all'], { timeoutMs: 60_000 }).catch(() => null)
    const jobs = await loadJobs($)
    // 被後來派工取代、還停在提問的工作桌 Agent 不代表任務：拿掉它們再挑（狀態照卡片走），之後停掉。
    const { list, superseded } = supersede(agentsOut && agentsOut.exitCode === 0 ? rawAgents(agentsOut.stdout) : [], lastLaunches(jobs))
    const agents: Record<string, AgentInfo> = tutorial ? simAgents() : agentsOut && agentsOut.exitCode === 0 ? agentsByRoot(list) : {}
    if (!tutorial && agentsOut && agentsOut.exitCode === 0) lastAgents = list
    const verifies = await read($, verifiesAtom)
    const chains = await loadChains($)
    const summaries = await loadSummaries($)
    const launching = await read($, launchingAtom)
    const verifying = await read($, verifyingAtom)
    const settings = tutorial ? null : await loadSettings($, options)
    const self = await me($)
    const cardBase = settings?.cardBase ?? ''
    const cases: Case[] = await Promise.all(rows.map(async row => {
      const [card, stat] = await Promise.all([
        $.fs.read(row.statusPath).catch(() => null) as Promise<string | null>,
        $.fs.stat(row.statusPath).catch(() => null) as Promise<{ mtimeMs?: number } | null>,
      ])
      const base = buildCase(row, card, typeof stat?.mtimeMs === 'number' ? stat.mtimeMs : null, agents, verifies[row.statusPath])
      const last = jobs[normalizeRoot(base.root)]?.last
      // 最後一次派工停在提問、題目寫進卡片「等你」後已在對話處理（清成「無」）：那個 Agent 不再代表任務，同一輪就照卡片算。
      const cleared = askClearedOnCard(last, base.ask)
      const { agent: found, ...rest } = base
      let agent: AgentInfo | undefined = cleared && found?.name === last?.launchName && found?.waitsFor === 'question' ? undefined : found
      if (!agent && last && !last.answered && !cleared) agent = asksFor(list, last.launchName) ?? undefined
      if (!agent && row.statusPath in launching) agent = { name: '啟動中', state: 'starting', status: 'busy', ...(launchKinds[row.statusPath] ? { kind: launchKinds[row.statusPath] } : {}) }
      if (agent && agent.id && !tutorial && (agent.status === 'busy' || agent.asks)) agent = { ...agent, last: await lastLine($, agent.id) }
      // 對得上最後一次派工：帶著它在做什麼（審查、同步在跑時六段不退回實作）。
      if (agent && last && agent.name === last.launchName) agent = { ...agent, kind: last.round ? 'fix' : last.kind }
      const probe = await gitProbe($, base.root)
      const pr = tutorial ? (tutorial.merged ? { id: 1, state: 'MERGED' as const, ci: 'none' as const, dest: TUTORIAL_RELEASE } : undefined) : probe.git ? await prProbe($, options, base.root, probe.git.branch, now, forcePr) : undefined
      const run = chains[normalizeRoot(base.root)]
      const stale = movedSince(run?.judgedHead, probe.git)
      // 卡片上有無阻擋的審查結論，但沒有任何 desk 派的審查判過它（沒有流程紀錄，或流程只派過實作）：自審。
      const verdict = parseVerdict(base.gate)
      const selfReview = !tutorial && !!verdict && blocking(verdict) === 0 && !run?.judgedHead && !run?.reviewHead
      // 這個對話的流程還沒處理剛做完的實作：檢查通過後會自動派審查。
      const autoReview = !!run && run.owner === self && !!last && !last.handled && (last.kind === 'continue' || last.kind === 'reply')
      const chain = run
        ? { round: run.round, ...(stale ? { stale: true } : {}), ...(run.stopped ? { stopped: run.stopped, ...(run.heldAtCheck ? { heldAtCheck: true } : {}) } : {}), ...(run.owner !== self ? { foreign: true } : {}), ...(run.passed ? { passed: true } : {}), ...(run.mediumFix && !run.passed ? { mediumFix: run.mediumFix } : {}), ...(run.needsHuman ? { needsHuman: run.needsHuman } : {}), ...(run.skippedReview ? { skippedReview: true } : {}), ...(selfReview ? { selfReview: true } : {}), ...(autoReview ? { autoReview: true } : {}), ...(last ? { lastKind: (last.round ? 'fix' : last.kind) as any } : {}), ...(run.catchupHead && run.catchupHead === probe.git?.head ? { catchupTried: true } : {}) }
        : selfReview ? { round: 0, selfReview: true } : undefined
      const gitState = probe.git ? await gitStatus($, base.root) : undefined
      // 最後一次 commit 比卡片新：提示按 s 同步。教學的卡片由腳本寫，不提示。
      const commit = probe.git && !tutorial ? await commitTime($, base.root, probe.git.head) : undefined
      let steps: string[] = []
      let history: any[] = []
      if (card !== null) {
        const cached = cardParseCache.get(row.statusPath)
        if (cached && cached.raw === card) {
          steps = cached.steps
          history = cached.history
        } else {
          steps = deploySteps(card)
          history = historyEntries(card)
          cardParseCache.set(row.statusPath, { raw: card, steps, history })
        }
      }
      // 審查檔只讀一次：CRITICAL、HIGH 前幾條與第一行的前置結果。
      const reviewText = parseVerdict(base.gate) || run ? await $.fs.read(`${base.root}/${REVIEW_FILE}`).catch(() => null) : null
      let top: any[] = []
      let preflight: string | undefined
      if (reviewText !== null) {
        const cached = reviewTextCache.get(base.root)
        if (cached && cached.raw === reviewText) {
          top = cached.top
          preflight = cached.preflight
        } else {
          top = reviewTop(reviewText)
          preflight = preflightLine(reviewText)
          reviewTextCache.set(base.root, { raw: reviewText, top, preflight })
        }
      }
      const withAgent = { ...rest, ...(agent ? { agent } : {}), ...probe, ...(pr ? { pr } : {}), ...(chain ? { chain } : {}), ...(gitState ? { gitState } : {}), ...(commit ? { commitAt: commit.at, changedAt: commit.changedAt } : {}), ...(steps.length ? { deploySteps: steps } : {}), ...(history.length ? { history } : {}), ...(top.length ? { reviewTop: top } : {}), ...(preflight ? { preflight } : {}) }
      const withState = { ...withAgent, state: stateOf(withAgent, verifies[row.statusPath]) }
      const short = withState.status ? summaries[textKey(withState.status)] ?? compactStatus(withState.status) : undefined
      const stages = (x: Case) => pipeline(x, verifies[row.statusPath], row.statusPath in verifying, isQueued(row.statusPath))
      // 合併段、沒有已合併的 PR：問 git 分支 HEAD 是不是已經在基準分支裡（GitLab、沒裝 gh、本機合併都靠這個）。
      // 審查後又有 commit 的（六段退回檢查）也要問：可能是改完直接合併了。
      const atMerge = !tutorial && (stages(withState).current === 'merge' || !!withState.chain?.stale) && withState.pr?.state !== 'MERGED'
      // 分叉點路徑只認工作桌在這條分支看過的 HEAD（審查時、判定時的 HEAD，且記下的分支是現在的分支）。
      const seen = seenHeads(run, probe.git?.branch)
      const into = atMerge ? await mergedProbe($, withState, cardBase, forcePr, seen) : undefined
      const merged = into ? { ...withState, mergedInto: into } : withState
      // 合併段、還沒合併、沒有 Agent 在跑（含啟動中）：fetch 基準分支、試合併，有衝突就放進 case 再算六段。按 r 時 fetch 不等五分鐘。
      const atMergeNow = !tutorial && !into && merged.pr?.state !== 'MERGED' && stages(merged).current === 'merge' && !runningKind(merged)
      const conflict = atMergeNow ? await conflictProbe($, merged, cardBase, now, forcePr) : undefined
      const probed = conflict ? { ...merged, conflict } : merged
      const piped = { ...probed, ...(short ? { statusShort: short } : {}), pipeline: stages(probed) }
      // 已合併之後，最後一次派工殘留的提問不再讓任務等回覆。
      const settled = settleMergedAsk(piped, verifies[row.statusPath])
      return { ...settled, state: finalState(settled) }
    }))
    const usage = await $.session.usage().catch(() => null)
    const limits = (usage?.rateLimits ?? []).map((l: any) => ({ kind: String(l.kind), remaining: 100 - (Number(l.percentUsed) || 0), ...(l.resetsAt ? { resetsAt: String(l.resetsAt) } : {}) }))
    const deskVersions = await versions($, cases)
    // 檢查關閉時當作沒查過：沒有提示，版本格是「檢查並更新」。
    const check = settings && settings.updateCheck !== 'off' ? await loadUpdateCheck($) : null
    const notice = noticeOf(check, deskVersions.desk)
    const versionState = isUpdating() ? 'updating' as const : versionStateOf(check, deskVersions.desk)
    // 教學模式：示範任務接在後面當「全部任務」的背景（只能看）；版本、轉圈等仍只看真的任務。
    const cur: Snapshot = { at: now, cases: tutorial ? [...cases, ...demoCases(now)] : cases, error, ...(paths?.project ? { project: paths.project.key } : {}), ...(missing ? { missingRegistry: missing } : {}), contextPercent: typeof usage?.context?.percent === 'number' ? Math.round(usage.context.percent) : null, limits, versions: deskVersions, models: await models($, options, turnModel, cases.map(c => c.root), settings ?? undefined), containers: await containers($, options, settings ?? undefined), reminders: parseReminders(text ?? '', now), ...(notice ? { update: notice } : {}), versionState, ...(tutorial ? { tutorial: true } : {}) }
    if (mine !== generation) return
    // 選取的任務已不在登錄表（歸檔、換專案）：取消選取，提示不再附它的卡。讀到空的登錄表（正在被改寫）不算。
    if (!error && rows.length) {
      await update($, selected, v => (v && !cur.cases.some(c => c.statusPath === v) ? null : v))
      await update($, feedAtom, list => feedOnDesk(list, cur.cases))
    }
    const prev = await read($, snapshot)
    const fresh = events(prev, cur)
    await update($, snapshot, () => cur)
    await collapseMoreIfMoved($)
    await feedPush($, fresh)
    for (const e of fresh) if (e.tone === 'warning' || e.tone === 'error') { $.ui.toast(e.text, { timeoutMs: 8000 }); notify($, e.text) }
    const openLogs = await read($, logsOpenAtom)
    const logCase = openLogs ? cases.find(c => c.statusPath === openLogs) : undefined
    if (logCase?.agent?.id) { const lines = await logTail($, logCase.agent.id); await update($, logViewAtom, v => ({ ...v, [logCase.statusPath]: lines })) }
    forcePr = false
    statusLine($, cur)
    await spin($, cases.some(c => c.state === 'running'))
    await stopSuperseded($, cases, superseded, now)
    // 清單是真的（不是教學、claude agents 沒失敗）才看得出誰結束了。
    if (!tutorial && agentsOut && agentsOut.exitCode === 0) {
      // 做完、程序還活著的工作桌 Agent 要停掉：它們的根目錄（含別的專案、已歸檔的）也先記結束，
      // 最後一次派工才先記成做完，停掉後那邊的流程不會當成被人停掉。
      const ended = settings?.stopDone !== false ? endedAlive(list) : []
      await noteEnded($, list, [...cases.filter(c => !c.demo).map(c => c.root), ...ended.map(a => a.root)])
      await stopEnded($, cases, ended, now)
      await noteCardAsks($, list, cases, now)
    }
    // 先補派排隊的（同一輪的清單），流程這一輪新派的排在它們後面：先來先派。派出了就用重算過的快照，流程才看得到它在跑。
    const drained = !tutorial && await drainAgentQueue($, options, cur, agentsOut && agentsOut.exitCode === 0 ? list : null)
    await autoChain($, options, drained ? (await read($, snapshot)) ?? cur : cur)
    void summarizeStatuses($, options, cur, summaries)
    if (settings && settings.updateCheck !== 'off' && !tutorial) void autoUpdateCheck($, now)
  })().catch(async (error: unknown) => {
    const message = `工作桌讀取失敗：${error instanceof Error ? error.message : String(error)}`
    // 讀取失敗不代表登錄表不存在：拿掉建立按鈕，錯誤照樣是紅字。
    await update($, snapshot, prev => prev ? { ...prev, error: message, missingRegistry: undefined } : { at: 0, cases: [], error: message, contextPercent: null })
  }).finally(() => { refreshing = null })
  return refreshing
}

/**
 * 這幾個根目錄（登錄表上的卡，加上要停掉的做完 Agent 所在的，可能是別的專案）最後一次派工的 Agent 剛結束（做完或被停掉）：記下怎麼結束；會改程式的那種（繼續、回覆、修正）再記下這時 worktree 的未提交指紋，
 * 之後派工用它分辨「現在的改動是上一個 Agent 留下的」還是別的對話在改。每一次派工只記一次，審查與同步不動指紋。
 */
async function noteEnded($: any, list: readonly any[], roots: readonly string[]) {
  for (const key of new Set(roots.map(normalizeRoot))) {
    const last = (await loadJobs($))[key]?.last
    if (!last || last.ended) continue
    const how = endedHow(list, last.launchName)
    if (!how) continue
    const codeAgent = last.kind === 'continue' || last.kind === 'reply' || last.kind === 'catchup'
    const mark = codeAgent ? await worktreeMark($, key) : undefined
    // 算指紋的這段時間可能剛派了新工：只改還是同一筆的紀錄。
    const all = await loadJobs($)
    const cur = all[key]?.last
    if (!cur || cur.launchName !== last.launchName || cur.ended) continue
    await $.store.set(JOBS_KEY, { ...all, [key]: { ...all[key], ...(mark ? { mark: mark.hash } : {}), last: { ...cur, ended: { how } } } })
  }
}

/**
 * 別的對話開的流程，這個對話可以接手的前提：流程沒停下、沒過關、沒合併，規格沒擋，最後一次是審查、
 * 卡片上的審查結論沒有 CRITICAL／HIGH、修正輪數還有，題目也沒在對話處理。
 * 審查檔有沒有要修的 MEDIUM 要讀檔後由 nextStep 決定：要派的是帶 MEDIUM 的審查修正才真的接手。
 */
function mayTakeOver(c: Case, run: ChainRun, last: JobRecord): boolean {
  const verdict = parseVerdict(c.gate)
  return last.kind === 'review' && !run.stopped && !run.passed && run.round < MAX_FIX_ROUNDS && !!verdict && blocking(verdict) === 0 && !isMerged(c) && !specBlocks(c) && !askClearedOnCard(last, c.ask)
}

/** 把別的對話開的流程改成這個對話的（輪數與其他紀錄照舊）；流程在這之間被改過（擁有者換了、停下或過關）就不接，回 false。 */
async function takeOver($: any, key: string, from: ChainRun, mine: string): Promise<boolean> {
  await saveChain($, key, r => r && r.owner === from.owner && !r.stopped && !r.passed ? { ...r, owner: mine } : r)
  return (await loadChains($))[key]?.owner === mine
}

/**
 * 自動流程（第二到第四段）：只處理這個對話自己派出去、剛結束、還沒處理過的那一次；
 * 別的對話開的流程，剛做完的審查只剩要修的 MEDIUM（沒有 CRITICAL／HIGH、修正輪數還有）時由這個對話接手。
 * 做完實作 → 跑完成檢查 → 綠了派審查 → 有 CRITICAL／HIGH 或影響行為的 MEDIUM（審查檔裡沒標「不修」「等你決定」的）派修正，
 * 最多兩輪；停下來就寫進動態並提醒。
 */
async function autoChain($: any, options: PluginOptions, s: Snapshot) {
  const mine = await me($)
  const jobs = await loadJobs($)
  const chains = await loadChains($)
  const verifies = await read($, verifyingAtom)
  const trusted = await trustedChecks($)
  let acted = false
  for (const c of s.cases) {
    const key = normalizeRoot(c.root)
    const run = chains[key]
    const last = jobs[key]?.last
    const agentBusy = !!c.agent && !c.agent.asks
    // 規格沒有驗收情境、六段停在規格段：跟面板一樣不重新檢查、不派審查或修正，流程停下寫原因（停過就不再寫）。
    // 停下後也要跳過：下面審查通過後有新 commit 的重新檢查不看 stopped。
    if (run && run.owner === mine && specBlocks(c)) {
      if (!run.stopped) {
        const reason = specGapReason(c)
        await saveChain($, key, r => r ? paused(r, reason) : r)
        await feedPush($, [{ at: s.at, text: `${c.name} 流程停下：${reason}`, tone: 'warning', card: c.statusPath }])
        acted = true
      }
      continue
    }
    // 已經合併：不再自動檢查、審查或修正（之後的 commit 進不了這次合併）。
    const merged = isMerged(c)
    if (!merged && run && await autoCatchup($, options, c, run, mine, s.at, agentBusy, s.limits)) { acted = true; continue }
    if (!merged && run?.passed && c.chain?.stale && run.owner === mine && !agentBusy && !c.agent?.asks && !(c.statusPath in verifies) && !isAgentQueued(c.statusPath) && !(c.statusPath in (await read($, launchingAtom)))) {
      await recheck($, key, run, last, mine, s.at)
      await feedPush($, [{ at: s.at, text: `${c.name} 審查通過後有新 commit，自動重新檢查與審查`, tone: 'suggestion', card: c.statusPath }])
      acted = true
      continue
    }
    if (!run || !last || last.handled || agentBusy || c.agent?.asks || c.statusPath in verifies || checking === c.statusPath || isQueued(c.statusPath) || isAgentQueued(c.statusPath) || c.statusPath in (await read($, launchingAtom))) continue
    // 別的對話開的流程：只有剛做完、只剩 MEDIUM 的審查可能接手（下面確定要派的是帶 MEDIUM 的修正才接），其他照舊不碰。
    const foreignRun = run.owner !== mine
    if (foreignRun && !mayTakeOver(c, run, last)) continue
    const markHandled = async () => { const all = await loadJobs($); if (all[key]?.last) await $.store.set(JOBS_KEY, { ...all, [key]: { ...all[key], last: { ...all[key]!.last!, handled: true } } }) }
    // 合併前派出、合併後才結束的那次：照樣收尾（審查檔歸檔、標成已處理），但不接著派任何工作。
    if (merged) {
      if (last.kind === 'review' && !tutorial) await archiveReview($, options, c, !!last.security, s.at)
      await markHandled()
      acted = true
      continue
    }
    const verify = (await read($, verifiesAtom))[c.statusPath]
    const fresh = verify && verify.at >= last.startedAt ? verify : undefined
    const finished: DispatchKind | null = last.kind === 'sync' ? null : last.kind
    const settings = finished ? await loadSettings($, options) : undefined
    const risk = settings ? await riskOf($, c, settings.riskHigh, settings.cardBase) : undefined
    const stoppedAgent = last.ended?.how === 'stopped'
    // 額度煞車：要派下一個 Agent 前看 5 小時額度。停在提問、題目已在對話處理的那次本來就不派，不看。
    const handed = askClearedOnCard(last, c.ask)
    const hold = settings && !tutorial && !handed ? quotaHold(s.limits, settings.chainQuotaStop, s.at) : ''
    // 剛結束的審查：審查檔裡沒標「不修」「等你決定」的 MEDIUM 要跟 CRITICAL／HIGH 一起修（程式碼審查看 REVIEW.md、資安審查看 SECURITY.md）。
    const mediumFix = finished === 'review' && !stoppedAgent ? mediumToFix(await $.fs.read(`${c.root}/${last.security ? SECURITY_FILE : REVIEW_FILE}`).catch(() => null)) : 0
    const planned = nextStep(run, finished, checkStands(c, fresh), parseVerdict(c.gate), trusted[c.statusPath] === c.verify && !!c.verify, { ...(risk ? { risk } : {}), lastWasSecurity: !!last.security, changed: c.statusPath in trusted, stopped: stoppedAgent, ...(mediumFix ? { mediumFix } : {}), ...(hold ? { quotaHold: hold } : {}) })
    if (!planned) continue
    // 接手：先把擁有者寫進流程紀錄（輪數照舊），再照這個對話自己的流程往下走；流程在這之間被別人改過就不接。
    if (foreignRun) {
      // 額度煞車把帶 MEDIUM 的審查修正改成停下（stop 帶 medium）：一樣接手，接著照停下處理（暫停、寫原因、記 MEDIUM 數），
      // 不然額度恢復後下一次重新整理就會自己接手派修正。
      const fixesMedium = planned.kind === 'dispatch' ? planned.reason === 'review' && !!planned.medium : planned.kind === 'stop' && !!hold && !!planned.medium
      if (!fixesMedium || !planned.medium) continue
      if (!(await takeOver($, key, run, mine))) continue
      await feedPush($, [{ at: s.at, text: `${c.name} 接手別的對話開的流程：審查只剩 MEDIUM ${planned.medium} 條要修，${planned.kind === 'dispatch' ? '自動派修正' : '額度不足，流程暫停'}`, tone: 'suggestion', card: c.statusPath }])
    }
    acted = true
    // 被停掉的審查沒寫完：不歸檔、不算判過。
    if (finished === 'review' && !stoppedAgent && planned.kind !== 'verify' && !tutorial) await archiveReview($, options, c, !!last.security, s.at)
    // 這次審查看的是派審查時的 HEAD；之後有新 commit，結論就不算數。
    if (finished === 'review' && !stoppedAgent) await saveChain($, key, r => r ? { ...r, ...judgedAt(r, !!last.security, c.git) } : r)
    // 停在提問、題目已在對話處理的那次：結論照記，不替它跑檢查或派 Agent（也就不會因為被取代而停掉它）。
    const next = handed ? handedOver(planned) : planned
    if (!next) { await markHandled(); continue }
    if (next.kind === 'verify') { void runVerify($, c, true); continue }
    await markHandled()
    // 要派下一步之前先看 worktree：有不是上一個 Agent 留下的未提交改動（別的對話在改），停下來說原因，不派。
    const foreign = next.kind === 'dispatch' && !tutorial ? markRefusal(await worktreeMark($, c.root), jobs[key]) : ''
    const step: ChainStep = foreign ? { kind: 'stop', reason: foreign } : next
    // 這輪修正要修的 MEDIUM（沒派成、停下來的也記著：停下時按 g 才修得到；額度煞車擋下的修正也帶著）；沒帶就把上一輪的拿掉。
    const medium = planned.kind === 'dispatch' || planned.kind === 'stop' ? planned.medium : undefined
    const withMedium = (r: ChainRun): ChainRun => { const { mediumFix: _, ...rest } = r; return medium ? { ...rest, mediumFix: medium } : rest }
    if (step.kind === 'stop') {
      await saveChain($, key, r => r ? paused(withMedium(r), step.reason, step.atCheck) : r)
      await feedPush($, [{ at: s.at, text: `${c.name} 流程已暫停：${step.reason}`, tone: 'error', card: c.statusPath }])
      $.ui.toast(`${c.name}：流程已暫停，${step.reason}`, { timeoutMs: 10_000 })
      notify($, `${c.name}：流程已暫停，${step.reason}`)
    } else if (step.kind === 'pass') {
      const judged = step.skipped ? fresh?.head ?? c.git?.head : undefined
      // 免審查過關：判定的 HEAD 是檢查時的；跟現在的 HEAD 一樣才記得住它的分支。
      await saveChain($, key, r => r ? { ...r, passed: true, ...(step.needsHuman ? { needsHuman: step.needsHuman } : {}), ...(step.skipped ? { skippedReview: true } : {}), ...(judged ? { judgedHead: judged, judgedBranch: judged === c.git?.head ? c.git?.branch : undefined } : {}) } : r)
      // 專案設了 autoPr（高風險照舊停下等你看；發版線、detached HEAD 跟沒開一樣）：重讀一次 PR（不用快取，免得剛開的 PR 沒看到又開一個），決定開 PR、只 push 或不派。
      const auto = !step.needsHuman && !tutorial && autoPrApplies(c) && (settings ?? await loadSettings($, options)).autoPr
      const pr = auto ? await prProbe($, options, c.root, c.git!.branch, s.at, true) : undefined
      const prPlan: AutoPrPlan | undefined = auto ? autoPrPlan({ ...c, pr }) : undefined
      // 額度煞車：要派推送前額度低於門檻就不派（流程照樣是過關），動態與提示寫原因。
      const low = prPlan && prPlan.kind !== 'skip' ? quotaLow(s.limits, (settings ?? await loadSettings($, options)).chainQuotaStop) : ''
      const plan: AutoPrPlan | undefined = low && prPlan ? { kind: 'skip', why: `${low}，沒有自動派推送；要推請按 ${prPlan.kind === 'open' ? '⇡ 開 PR' : '⇡ push'}` } : prPlan
      const words = passWords(c.name, plan, step.skipped)
      const text = step.needsHuman ? `${c.name} ${step.needsHuman}` : words.feed
      await feedPush($, [{ at: s.at, text, tone: step.needsHuman ? 'warning' : 'success', card: c.statusPath }])
      const say = step.needsHuman ? `${c.name}：${step.needsHuman}` : words.say
      $.ui.toast(say, { timeoutMs: 10_000 })
      notify($, say)
      if (plan) await autoPublish($, options, { ...c, pr }, plan)
    } else {
      await saveChain($, key, r => r ? { ...withMedium(r), round: step.round } : r)
      // 審查修正帶著剛結束的是不是資安審查：提示只寫那一份審查檔（SECURITY.md 或 REVIEW.md）。
      const fix: FixReason | undefined = step.reason ? { from: step.reason as 'check' | 'review', round: step.round, ...(step.reason === 'check' ? { tail: fresh?.tail ?? [] } : {}), ...(step.reason === 'review' && last.security ? { security: true } : {}) } : undefined
      await dispatch($, options, { ...c, state: 'ready' }, step.dispatch, { fix, auto: true, ...(step.security ? { security: true } : {}) })
    }
  }
  if (acted) refreshSoon($, options)
}

/**
 * 合併段跟基準分支有衝突、這個對話的流程已過關：自動派解衝突 Agent（同一個 HEAD 只試一次）。不自動派的原因（catchupHold）由面板寫在「輪到你」。
 * 等你有內容、有 Agent 在跑或排隊或啟動中、檢查在跑都先不派。派之前再看一次 worktree 乾淨，滿了照派工規則排隊。
 * 這個 HEAD 試過了（catchupHead）在 dispatch 真的派出 Agent 時才記：排隊中、隊伍被清空、派不出去都不算。
 * 派不出去（不在隊伍裡）就把流程停下寫原因，不然每次重新整理都會再派一次。
 * 回傳有沒有動作（派出、排進隊伍或停下流程）。合併 commit 之後由「審查通過後有新 commit」的重新檢查與審查接手。
 */
async function autoCatchup($: any, options: PluginOptions, c: Case, run: ChainRun, mine: string, at: number, agentBusy: boolean, limits: Snapshot['limits']): Promise<boolean> {
  const conflict = c.conflict
  if (!conflict || run.owner !== mine || !run.passed || c.chain?.stale || catchupHold(c) || !saysNone(c.ask) || !c.git) return false
  if (agentBusy || c.agent?.asks || c.statusPath in (await read($, verifyingAtom)) || verifyPending(c.statusPath) || isAgentQueued(c.statusPath) || await starting($, c.statusPath)) return false
  if (tutorial || (await worktreeMark($, c.root)).files) return false
  // 額度煞車：額度低於門檻不派解衝突，流程停下寫原因（停過之後 catchupHold 回額度原因，不會再來）。合併段沒有 g 可按，
  // 原因句的結尾改成叫你在對話合併基準分支、解衝突，「輪到你」也照這句。
  const hold = quotaHold(limits, (await loadSettings($, options)).chainQuotaStop, at, QUOTA_RESTART_CATCHUP)
  if (hold) {
    await saveChain($, normalizeRoot(c.root), r => r && r.owner === mine && !r.stopped ? paused(r, hold) : r)
    await feedPush($, [{ at, text: `${c.name} 流程已暫停：${hold}`, tone: 'error', card: c.statusPath }])
    $.ui.toast(`${c.name}：流程已暫停，${hold}`, { timeoutMs: 10_000 })
    notify($, `${c.name}：流程已暫停，${hold}`)
    return true
  }
  await feedPush($, [{ at, text: catchupFeed(c.name, conflict.into, conflict.files.length), tone: 'suggestion', card: c.statusPath }])
  const sent = await dispatch($, options, { ...c, state: 'ready' }, 'catchup', { auto: true, text: conflict.ref })
  if (!sent && !isAgentQueued(c.statusPath)) {
    await saveChain($, normalizeRoot(c.root), r => r && r.owner === mine && !r.stopped ? paused(r, CATCHUP_NOT_SENT) : r)
    await feedPush($, [{ at, text: `${c.name} 流程已暫停：${CATCHUP_NOT_SENT}`, tone: 'error', card: c.statusPath }])
    notify($, `${c.name}：流程已暫停，${CATCHUP_NOT_SENT}`)
  }
  return true
}

/**
 * 審查通過後分支又有新 commit（你決定要改、或在面板外改了）：開新的一輪流程（不算修正輪數），
 * 排一次「做完了」讓流程照常走：完成檢查 → 審查只看上次審查之後的 diff。
 * 這筆是合成的、不是真的派工，直接記成已結束：noteEnded 不會再對它重算指紋（這時 worktree 的改動多半是人在面板外改的），
 * 派審查前照樣拿上一個程式 Agent 結束時的指紋比對。
 */
async function recheck($: any, key: string, run: ChainRun, last: JobRecord | undefined, owner: string, now: number) {
  await saveChain($, key, () => ({ owner, startedAt: now, round: 0, recheck: true, ...(run.reviewHead ? { reviewHead: run.reviewHead, ...(run.reviewBranch ? { reviewBranch: run.reviewBranch } : {}) } : {}), ...(run.judgedHead ? { judgedHead: run.judgedHead, ...(run.judgedBranch ? { judgedBranch: run.judgedBranch } : {}) } : {}) }))
  const all = await loadJobs($)
  const record: JobRecord = { launchName: last?.launchName ?? 'recheck', nativeId: last?.nativeId ?? 'recheck', sessionId: last?.sessionId ?? '', kind: 'continue', startedAt: now, fresh: false, answered: true, owner, recheck: true, ended: { how: 'finished' } }
  await $.store.set(JOBS_KEY, { ...all, [key]: { ...all[key], last: record } })
}

let soonTimer: Timer
/** 流程動作後兩秒再看一次，讓剛派出去的工作或剛跑完的檢查盡快反映。 */
export function refreshSoon($: any, options: PluginOptions) {
  soonTimer?.cancel()
  soonTimer = $.clock.after(2000, () => { soonTimer = undefined; void refresh($, options) })
}

/** 有東西在跑才轉；沒有就停，不浪費重繪。 */
export async function spin($: any, wanted: boolean) {
  const busy = wanted || Object.keys(await read($, verifyingAtom)).length > 0 || Object.keys(await read($, launchingAtom)).length > 0
  if (busy && !spinTimer) spinTimer = $.clock.every(SPIN_MS, async () => { await update($, tick, n => (n + 1) % 1000) })
  if (!busy && spinTimer) { spinTimer.cancel(); spinTimer = undefined }
}

async function start($: any, options: PluginOptions, remember: boolean) {
  if (!active) {
    active = true
    generation++
    const stored = (await $.store.get(VERIFIES_KEY).catch(() => null)) as Record<string, Verify> | null
    const lesson = (await $.store.get(TUTORIAL_KEY).catch(() => null)) as TutorialState | null
    setTutorial(lesson && typeof lesson.dir === 'string' ? lesson : null)
    await resumeTutorial($, options)
    if (stored && typeof stored === 'object') await update($, verifiesAtom, () => stored)
    refreshTimer?.cancel()
    refreshTimer = $.clock.every(refreshMs(options), () => refresh($, options))
  }
  if (remember) {
    const id = await $.session.id().catch(() => null)
    if (typeof id === 'string') {
      const list = ((await $.store.get(SESSIONS_KEY).catch(() => null)) as string[] | null) ?? []
      if (!list.includes(id)) await $.store.set(SESSIONS_KEY, [...list.slice(-19), id])
    }
  }
}

async function stop($: any) {
  active = false
  cancelSim()
  generation++
  refreshTimer?.cancel(); refreshTimer = undefined
  spinTimer?.cancel(); spinTimer = undefined
  soonTimer?.cancel(); soonTimer = undefined
  cancelPromptSync()
  await clearAgentQueue($)
  $.ui.status(undefined)
  await update($, snapshot, () => null)
  await $.ui.close({ id: PANE }).catch(() => {})
  const id = await $.session.id().catch(() => null)
  const list = ((await $.store.get(SESSIONS_KEY).catch(() => null)) as string[] | null) ?? []
  if (typeof id === 'string' && list.includes(id)) await $.store.set(SESSIONS_KEY, list.filter(x => x !== id))
}

/** 現在卡換人（選別件、取消選取、自動挑選改了）就收回「更多動作」：換回原本那件也是收合的。 */
async function collapseMoreIfMoved($: any) {
  const shownFor = await read($, showAllAtom)
  if (shownFor === null) return
  if (shownFor !== moreKeyOf(await read($, snapshot), await read($, selected))) await update($, showAllAtom, () => null)
}

export async function openPane($: any) {
  await update($, isPaneOpen, () => true)
  // 重新開啟面板一律從精簡動作開始。
  await update($, showAllAtom, () => null)
  const opened = await $.ui.open({ id: PANE, title: 'desk', focus: true, closeOnEscape: true, rows: 18, columns: 72 })
  if (opened && opened.isPlaced === false) $.ui.toast(`工作桌面板尚未顯示（${plain(String(opened.reason ?? ''))}）；輸入 /desk 開啟`)
}

/** 摘要列按鈕：開或關看引擎的實際狀態（畫出且在最前面才算看得到），不看 isPaneOpen；引擎卸下面板時 ui.close hook 不會執行，那個值會停在 true。 */
async function togglePane($: any) {
  const pane = ((await $.ui.panes().catch(() => [])) as { id: string; isPlaced: boolean; isShown: boolean }[]).find(p => p.id === PANE)
  if (pane?.isPlaced && pane.isShown) { await update($, isPaneOpen, () => false); await $.ui.close({ id: PANE }).catch(() => {}) }
  else await openPane($)
}



/**
 * 檢查開始、排隊、沒跑成，或剛派出 Agent 時重算那件的六段（`patch` 先套上新的 agent、state）：
 * 不等下一輪重新整理，現在卡與全部任務表格立刻一致。
 */
export async function restage($: any, statusPath: string, patch: (c: Case) => Case = c => c) {
  const verifies = await read($, verifiesAtom)
  const verifying = await read($, verifyingAtom)
  const again = (c: Case) => ({ ...c, pipeline: pipeline(c, verifies[statusPath], statusPath in verifying, isQueued(statusPath)) })
  await update($, snapshot, s => s ? { ...s, cases: s.cases.map(x => x.statusPath === statusPath ? again(patch(x)) : x) } : s)
}



const notified = new Set<string>()
/** 系統通知：同一句只送一次（流程暫停、等你這類每次重新整理都會重算的事）；repeat 是你每做一次就該通知一次的（按 v 檢查沒過）。 */
export function notify($: any, text: string, repeat = false) {
  if (!active || tutorial || (!repeat && notified.has(text))) return
  notified.add(text)
  void Promise.resolve().then(() => $.ui.notify(text, { title: 'desk' })).catch(() => {})
}

/** 卡片或登錄表剛被改過（卡片腳本、對話、回合結束）後重新整理：已有一輪在跑（可能在改之前就讀過）就等它結束再讀一輪。 */
export async function refreshAfterWrite($: any, options: PluginOptions) {
  if (refreshing) {
    // 進行中那輪可能在改之前就讀過登錄表：desk 發版的待辦先記，不等它跑完探測（同回合的 archive --cleanup 會刪掉 worktree）。
    if (!tutorial) await noteReleasedNow($, options).catch(() => { /* 下一輪重新整理再看 */ })
    await refreshing.catch(() => {})
  }
  return refresh($, options)
}

const KIND_ARG: Record<string, DispatchKind> = { go: 'continue', continue: 'continue', sync: 'sync', review: 'review', reply: 'reply' }

export const register: Register = (on, options) => {
  optionsRef = options
  on('session.start', async ($, e, next) => {
    active = false
    clearProbeCaches()
    cardParseCache.clear()
    reviewTextCache.clear()
    setTutorial(null)
    cancelSim()
    refreshTimer?.cancel(); refreshTimer = undefined
    spinTimer?.cancel(); spinTimer = undefined
    await update($, verifyingAtom, () => ({}))
    await update($, launchingAtom, () => ({}))
    // 新對話（含 /clear）：重附卡片全文，之前送出的決策不帶著鎖進來。
    await resetPromptSync($)
    resetCheckingState()
    resetDispatchState()
    lastAgents = null
    await update($, queueAtom, () => [])
    await clearAgentQueue($)
    // 載入計數：更新後 /reload-plugins 被拒時，看新版是不是其實已經載入了。
    await markLoaded($)
    await $.command.register({ name: 'desk', description: '工作桌：/desk 開啟面板並取得焦點（面板裡 Esc 收起）；close 收起；refresh 重新整理；go|sync|review|reply <任務名> [回覆] 派工；verify|open <任務名> 執行檢查／開啟卡片；bar 摘要列；update 把 desk 更新到 GitHub 最新版本；tutorial [end] 教學（含示範任務）；off 關閉', argumentHint: '[close|refresh|go|sync|review|reply|verify|open <任務名>|bar|update|tutorial [end]|off]' })
    if (e.isInteractive === false) { await update($, snapshot, () => null); return next(e) }
    const id = await $.session.id().catch(() => null)
    const list = ((await $.store.get(SESSIONS_KEY).catch(() => null)) as string[] | null) ?? []
    const always = String(options.activation ?? 'auto') === 'always'
    if (always || (typeof id === 'string' && list.includes(id))) { await start($, options, false); void refresh($, options) }
    else await update($, snapshot, () => null)
    return next(e)
  })

  // 主對話每次送請求時記下模型與 effort，面板的「模型」一列就跟著 /model 與 effort 的切換走。
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      const effort = e.effort === undefined ? undefined : String(e.effort)
      if (e.model !== turnModel.model || effort !== turnModel.effort) {
        turnModel = { model: e.model, ...(effort ? { effort } : {}) }
        if (active) await update($, snapshot, s => s ? { ...s, models: { ...s.models, session: e.model, ...(effort ? { effort } : { effort: undefined }) } } : s).catch(() => {})
      }
    }
    return yield* next(e)
  })

  registerPromptSync(on, { isActive: () => active, isTutorial: () => !!tutorial, knownPaths: () => knownPaths, options })

  on('command.run', { command: 'desk' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off') {
      if (!active) return { text: '此對話未開啟工作桌。' }
      await stop($)
      return { text: '工作桌已關閉：停止更新並隱藏摘要列。輸入 /desk 可重新開啟。' }
    }
    if (!active) await start($, options, true)
    if (arg === 'tutorial') return { text: await tutorialStart($, options) }
    if (arg === 'tutorial end') return { text: await tutorialEnd($, options) }
    if (arg === 'refresh') { forcePr = true; await refresh($, options); return { text: '工作桌已重新整理。' } }
    if (arg === 'update') return { text: await runUpdate($) }
    if (arg === 'band' || arg === 'bar') { const hidden = await update($, isBandHidden, v => !v); return { text: hidden ? '摘要列已隱藏，輸入 /desk bar 可重新顯示。' : '摘要列已顯示。' } }
    const m = arg.match(/^(verify|open|go|continue|sync|review|reply)\s+(\S+)\s*(.*)$/)
    if (m) {
      const s = await read($, snapshot) ?? (await refresh($, options), await read($, snapshot))
      // 回覆示範任務要說清楚是示範任務，不只是找不到。
      const c = caseNamed(s, m[2]!) ?? (m[1] === 'reply' ? s?.cases.find(x => x.demo && x.name.includes(m[2]!)) ?? null : null)
      if (!c) return { text: `找不到任務「${m[2]}」。` }
      // 沒核准的檢查不跑、也不派實作（做完會自動跑它），不彈框：說去面板按兩次。
      if ((m[1] === 'verify' || KIND_ARG[m[1]!] === 'continue') && !isApproved(await trustedChecks($), c)) return { text: unapprovedText(c) }
      if (m[1] === 'verify') {
        // 跟面板的 v 同一個鎖：Agent 在跑就不在它的 worktree 上跑檢查。
        if (await busyNow($, c, true)) return { text: `${c.name}：${WORD.busyRefused}檢查` }
        void runVerify($, c)
        return { text: `${c.name}：完成檢查已開始。` }
      }
      if (m[1] === 'open') { await openCard($, c); return { text: `${c.name}：已開啟 ${c.statusPath}` } }
      if (m[1] === 'reply') {
        const why = replyRefusal(c)
        if (why) return { text: `${c.name}：目前無法回覆（${why}）。` }
        void reply($, options, c, m[3])
        return { text: `${c.name}：回覆派送中。` }
      }
      const kind = KIND_ARG[m[1]!]!
      void dispatch($, options, c, kind)
      return { text: `${c.name}：${KIND_LABEL[kind]}派送中。` }
    }
    if (arg === 'close') { await update($, isPaneOpen, () => false); await $.ui.close({ id: PANE }).catch(() => {}); return { text: '工作桌已收起。' } }
    if (arg) return { text: '可用：/desk、close、refresh、go|sync|review <任務名>、reply <任務名> [回覆]、verify|open <任務名>、bar、update、tutorial [end]、off' }
    if (!(await read($, snapshot))) void refresh($, options)
    // 從輸入框打 /desk 時鍵盤一定在輸入框：開著就把焦點移到面板，不關閉；收起用面板裡的 Esc 或 /desk close。
    const wasOpen = await read($, isPaneOpen)
    await openPane($)
    return { text: wasOpen ? '已切到面板（Esc 收起）' : '工作桌已開（Esc 收起）' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.hasSurvey || !s || (await read($, isBandHidden))) return next(e)
    await read($, tick)
    const ui = $.ui.resolve(e)
    const columns = Math.max(0, Math.floor(e.props.bodyColumns ?? 80))
    const verifying = await read($, verifyingAtom)
    const queue = await read($, queueAtom)
    const launching = await read($, launchingAtom)
    const sent = await readSent($)
    const agentQueue = await readAgentQueue($)
    const ctxOf = (c: Case) => ({ verifying: c.statusPath in verifying, queued: queue.includes(c.statusPath), launching: c.statusPath in launching, agentQueued: agentQueue.indexOf(c.statusPath) + 1 || undefined, tutorial: !!s.tutorial, sent: sentState(sent, c) })
    const mine = renderBand(ui, layoutBand(s, columns, await read($, isPaneOpen), ctxOf, await read($, selected)), columns, () => {})
    const below = await next(e).catch(() => null)
    const { Box } = ui as any
    return isEmpty(below) ? mine : <Box flexDirection="column">{mine}{below}</Box>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e) as any
    const { Text } = ui
    const s = await read($, snapshot)
    if (!s) return <Text color="subtle">{active ? '讀取任務中…' : '此對話未開啟工作桌；輸入 /desk refresh 開啟。'}</Text>
    const base: PaneView = {
      s, now: await $.clock.now(), columns: Math.max(20, e.props.bodyColumns ?? 80), isFocused: !!e.props.isFocused,
      bodyRows: e.props.scroll?.bodyRows, placement: e.props.placement, offset: await read($, contentOffset),
      selected: await read($, selected), feed: await read($, feedAtom), picks: await read($, picksAtom),
      verifies: await read($, verifiesAtom), verifying: await read($, verifyingAtom), tick: await read($, tick), isExpanded: await read($, isExpanded),
      launching: await read($, launchingAtom),
      queue: await read($, queueAtom),
      agentQueue: await readAgentQueue($),
      armed: await read($, armedAtom),
      trusted: await trustedChecks($),
      logsOpen: await read($, logsOpenAtom),
      logView: await read($, logViewAtom),
      isHelp: await read($, helpAtom),
      showAll: false,
      sent: await readSent($),
    }
    // 展開只對展開當下那件有效；舊版存的 true／false 不是路徑，一律當收合。
    const focusKey = moreKeyOf(base.s, base.selected)
    const shownFor = await read($, showAllAtom)
    const view: PaneView = { ...base, showAll: typeof shownFor === 'string' && shownFor === focusKey }
    const act: PaneActions = {
      // 點已經在現在卡的那件不動作；取消選取走區段標題列或「更多動作」的 deselect。
      select: path => void (async () => {
        if ((await read($, selected)) === path) return
        await update($, selected, () => path); await update($, contentOffset, () => 0); await collapseMoreIfMoved($)
      })(),
      deselect: () => void (async () => { await update($, selected, () => null); await update($, contentOffset, () => 0); await collapseMoreIfMoved($) })(),
      pick: (c, index, key) => void update($, picksAtom, all => {
        const k = picksKey(c)
        const mine = all[k] ?? {}
        const others = Object.fromEntries(Object.entries(all).filter(([x]) => !x.startsWith(c.statusPath + '\n')))
        return { ...others, [k]: mine[String(index)] === key ? Object.fromEntries(Object.entries(mine).filter(([i]) => i !== String(index))) : { ...mine, [String(index)]: key } }
      }),
      fill: c => void fillDecision($, c),
      verify: c => void (async () => {
        if (isApproved(await trustedChecks($), c)) { if (!(await busyRefused($, c, '檢查'))) await runVerify($, c); return }
        // 還沒核准（或指令改過）：按兩次，第一次在檢查列列出全文，第二次核准並執行。
        if (await confirmedIdle($, c, 'verify', '檢查') && await trustCheck($, c)) await runVerify($, c)
      })(),
      open: c => void openCard($, c),
      dispatch: (c, kind) => void (async () => {
        if (kind === 'reply') return reply($, options, c)
        if (!(await confirmed($, `${c.statusPath}\n${kind}`))) return
        // 第二次按 g 就核准這張卡的完成檢查（沒核准時第一次已在檢查列列出全文）。
        if (kind === 'continue') await trustCheck($, c)
        await dispatch($, options, c, kind)
      })(),
      stop: c => void (async () => { if (await confirmed($, `${c.statusPath}\nstop`)) await stopAgent($, c) })(),
      // 還沒派出去，按一次就取消，不用確認。
      unqueue: c => void cancelQueued($, c),
      ship: c => void (async () => { if (await confirmedIdle($, c, 'ship', '確認上線')) await confirmShipped($, c) })(),
      specOk: c => void (async () => { if (!tutorial && awaitsSpecOk(c) && await confirmedIdle($, c, 'spec-ok', '確認規格')) await confirmSpec($, options, c) })(),
      archive: c => void (async () => { if (!tutorial && canArchive(c) && await confirmedIdle($, c, 'archive', '歸檔')) await archiveCase($, options, c) })(),
      release: c => void (tutorial ? undefined : fillRelease($, c)),
      tutorial: c => void tutorialAct($, options, c),
      logs: c => void toggleLogs($, c),
      openReview: c => void openPath($, `${c.root}/${REVIEW_FILE}`, '審查檔'),
      openPr: c => void (c.pr?.url ? openPath($, c.pr.url, ' PR') : undefined),
      publishPr: c => void confirmThen($, `${c.statusPath}\nopen-pr`, () => publishPr($, options, c)),
      publishPush: c => void confirmThen($, `${c.statusPath}\npush`, () => publishPush($, options, c)),
      help: () => void update($, helpAtom, v => !v),
      more: () => void update($, showAllAtom, () => view.showAll ? null : focusKey),
      refresh: () => { forcePr = true; void refresh($, options) },
      toggleBand: () => void update($, isBandHidden, v => !v),
      update: () => void runUpdate($),
      createRegistry: () => { if (s.missingRegistry) void createRegistry($, options, s.missingRegistry) },
      expand: () => void update($, isExpanded, v => !v),
      window: w => { maxOffset = w.maxOffset },
    }
    return renderPane(ui, view, act)
  })

  // 摘要列的面板按鈕在 ui.press 處理：用這次按壓自己的 $，引擎才把重開算成使用者親自開的（任何寬度都畫）；
  // 畫摘要列時抓的 $ 開面板會被當成主動開啟，窄於 144 欄就不畫。
  on('ui.press', { plugin: 'desk', component: 'AbovePrompt', element: 'pane' }, async ($, e) => {
    await togglePane($)
    return { element: e.element }
  })

  // header 與 footer 常駐：面板的捲動由 desk 自己移動 content 的列，不交給引擎捲整棵樹。
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (e.component !== 'Pane') return next(e)
    await update($, contentOffset, v => Math.max(0, Math.min(maxOffset, Math.min(v, maxOffset) + e.by)))
    return {}
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, isPaneOpen, () => false).catch(() => {})
    return next(e)
  })
}

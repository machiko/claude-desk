// desk：工作桌。讀登錄表與每件任務的 DESK 卡，摘要列一行、/desk 面板一張；決策按鍵填入、完成檢查一鍵、開啟卡片，
// 以及派工：繼續／同步／審查／回覆都是 `claude --bg` 在任務根目錄開一個背景 agent，session 對應記在 $.store。
// 不寫卡、不碰正式環境。教學模式的執行在 tutorial-run.tsx，不依賴模組狀態的 I/O 小工具在 desk-io.ts。
import { atom, read, update } from 'claude-code'
import type { Register, PluginOptions } from 'claude-code'
import type { AgentInfo, Case, Snapshot, Verify } from '../types'
import { parseRegistry } from './card'
import { agentsByRoot, buildCase, caseNamed, demoCases, endedHow, events, feedOnDesk, rawAgents, supersede, asksFor, agentInfo, stateOf, settleMergedAsk, askClearedOnCard, plain, errorText } from './model'
import { archiveReview, commitTime, containers, deskPaths, diffBase, gitProbe, gitStatus, home, lastLine, loadSettings, logTail, mergedProbe, models, prProbe, riskOf, versions, verifyResult, worktreeMark } from './probes'
import { deploySteps, parseReminders, reviewTop } from './extras'
import { layoutBand, renderBand } from './band'
import { renderPane, picksKey, moreKeyOf } from './pane'
import type { PaneActions, PaneView } from './pane'
import { KIND_LABEL, REVIEW_FILE, buildPrompt, dispatchRefusal, launchName, markRefusal, modelFor, normalizeRoot, replyRefusal, runningDeskAgents, specBlocks, specGapReason } from './dispatch'
import type { DispatchKind, FixReason, JobRecord, QueueOpts, RawAgent, RootJobs, ReviewOpts } from './dispatch'
import { awaitsSpecOk, blocking, canArchive, checkStands, finalState, isMerged, isReleaseLine, movedSince, parseVerdict, pipeline } from './pipeline'
import { handedOver, judgedAt, nextStep, paused, seenHeads } from './chain'
import { approveCheck, trustedChecks } from './approve-check'
import { missingServices } from './containers'
import { compactStatus, textKey } from './digest-status'
import type { ChainRun, ChainStep } from './chain'
import { TUTORIAL_RELEASE, tutorialPaths } from './tutorial'
import type { TutorialState } from './tutorial'
import { tutorial, TUTORIAL_KEY, setTutorial, cancelSim, simAgents, startSim, resumeTutorial, tutorialAct, tutorialStart, tutorialEnd } from './tutorial-run'
import { JOBS_KEY, MAX_REFRESH_S, MIN_REFRESH_S, SESSIONS_KEY, SPIN_MS, TRUST_KEY, VERIFIES_KEY, confirmed, feedPush, launch, loadChains, loadJobs, loadSummaries, me, missingRegistry, confirmThen, openPath, registryError, saveChain, statusLine, summarizeStatuses, tellPanel, toggleLogs } from './desk-io'
import { isEmpty } from './layout'
import type { Timer } from './desk-io'
import { noticeOf, versionStateOf } from './update'
import { autoUpdateCheck, isUpdating, loadUpdateCheck, markLoaded, runUpdate } from './update-run'
import { isBusy, sentState } from './turn'
import { WORD } from './theme'
import { cancelPromptSync, readSent, registerPromptSync, resetPromptSync } from './prompt-sync'
import { lastLaunches, noteCardAsks, stopSuperseded } from './stale-agents'
import { cancelQueued, clearAgentQueue, drainAgentQueue, enqueueDispatch, hasAgentQueue, isAgentQueued, notSent, queuePosition, readAgentQueue, requeue } from './agent-queue'
import { DEMO_ONLY, archiveCase, autoPublish, confirmShipped, confirmSpec, createRegistry, fillDecision, fillRelease, publishPr, publishPush, openCard, reply, stopAgent } from './card-actions'
import { autoPrApplies, autoPrPlan, passWords } from './auto-pr'
import type { AutoPrPlan } from './auto-pr'

const PANE = 'desk'
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
let lastAgents: readonly RawAgent[] | null = null

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
        ? { round: run.round, ...(stale ? { stale: true } : {}), ...(run.stopped ? { stopped: run.stopped, ...(run.heldAtCheck ? { heldAtCheck: true } : {}) } : {}), ...(run.owner !== self ? { foreign: true } : {}), ...(run.passed ? { passed: true } : {}), ...(run.needsHuman ? { needsHuman: run.needsHuman } : {}), ...(run.skippedReview ? { skippedReview: true } : {}), ...(selfReview ? { selfReview: true } : {}), ...(autoReview ? { autoReview: true } : {}), ...(last ? { lastKind: (last.round ? 'fix' : last.kind) as any } : {}) }
        : selfReview ? { round: 0, selfReview: true } : undefined
      const gitState = probe.git ? await gitStatus($, base.root) : undefined
      // 最後一次 commit 比卡片新：提示按 s 同步。教學的卡片由腳本寫，不提示。
      const commit = probe.git && !tutorial ? await commitTime($, base.root, probe.git.head) : undefined
      const steps = deploySteps(card)
      const top = parseVerdict(base.gate) || run ? reviewTop(await $.fs.read(`${base.root}/${REVIEW_FILE}`).catch(() => null)) : []
      const withAgent = { ...rest, ...(agent ? { agent } : {}), ...probe, ...(pr ? { pr } : {}), ...(chain ? { chain } : {}), ...(gitState ? { gitState } : {}), ...(commit ? { commitAt: commit.at, changedAt: commit.changedAt } : {}), ...(steps.length ? { deploySteps: steps } : {}), ...(top.length ? { reviewTop: top } : {}) }
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
      const piped = { ...merged, ...(short ? { statusShort: short } : {}), pipeline: stages(merged) }
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
    const cur: Snapshot = { at: now, cases: tutorial ? [...cases, ...demoCases(now)] : cases, error, ...(paths?.project ? { project: paths.project.key } : {}), ...(missing ? { missingRegistry: missing } : {}), contextPercent: typeof usage?.context?.percent === 'number' ? Math.round(usage.context.percent) : null, limits, versions: deskVersions, models: await models($, options, turnModel, cases.map(c => c.root)), containers: await containers($, options), reminders: parseReminders(text ?? '', now), ...(notice ? { update: notice } : {}), versionState, ...(tutorial ? { tutorial: true } : {}) }
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
      await noteEnded($, list, cases)
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
 * 最後一次派工的 Agent 剛結束（做完或被停掉）：記下怎麼結束；會改程式的那種（繼續、回覆、修正）再記下這時 worktree 的未提交指紋，
 * 之後派工用它分辨「現在的改動是上一個 Agent 留下的」還是別的對話在改。每一次派工只記一次，審查與同步不動指紋。
 */
async function noteEnded($: any, list: readonly any[], cases: readonly Case[]) {
  for (const c of cases) {
    if (c.demo) continue
    const key = normalizeRoot(c.root)
    const last = (await loadJobs($))[key]?.last
    if (!last || last.ended) continue
    const how = endedHow(list, last.launchName)
    if (!how) continue
    const codeAgent = last.kind === 'continue' || last.kind === 'reply'
    const mark = codeAgent ? await worktreeMark($, c.root) : undefined
    // 算指紋的這段時間可能剛派了新工：只改還是同一筆的紀錄。
    const all = await loadJobs($)
    const cur = all[key]?.last
    if (!cur || cur.launchName !== last.launchName || cur.ended) continue
    await $.store.set(JOBS_KEY, { ...all, [key]: { ...all[key], ...(mark ? { mark: mark.hash } : {}), last: { ...cur, ended: { how } } } })
  }
}

/**
 * 自動流程（第二到第四段）：只處理這個對話自己派出去、剛結束、還沒處理過的那一次。
 * 做完實作 → 跑完成檢查 → 綠了派審查 → 有 CRITICAL／HIGH 派修正，最多兩輪；停下來就寫進動態並提醒。
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
    if (!merged && run?.passed && c.chain?.stale && run.owner === mine && !agentBusy && !c.agent?.asks && !(c.statusPath in verifies) && !isAgentQueued(c.statusPath) && !(c.statusPath in (await read($, launchingAtom)))) {
      await recheck($, key, run, last, mine, s.at)
      await feedPush($, [{ at: s.at, text: `${c.name} 審查通過後有新 commit，自動重新檢查與審查`, tone: 'suggestion', card: c.statusPath }])
      acted = true
      continue
    }
    if (!run || run.owner !== mine || !last || last.handled || agentBusy || c.agent?.asks || c.statusPath in verifies || checking === c.statusPath || isQueued(c.statusPath) || isAgentQueued(c.statusPath) || c.statusPath in (await read($, launchingAtom))) continue
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
    const planned = nextStep(run, finished, checkStands(c, fresh), parseVerdict(c.gate), trusted[c.statusPath] === c.verify && !!c.verify, { ...(risk ? { risk } : {}), lastWasSecurity: !!last.security, changed: c.statusPath in trusted, stopped: stoppedAgent })
    if (!planned) continue
    acted = true
    // 被停掉的審查沒寫完：不歸檔、不算判過。
    if (finished === 'review' && !stoppedAgent && planned.kind !== 'verify' && !tutorial) await archiveReview($, options, c, !!last.security, s.at)
    // 這次審查看的是派審查時的 HEAD；之後有新 commit，結論就不算數。
    if (finished === 'review' && !stoppedAgent) await saveChain($, key, r => r ? { ...r, ...judgedAt(r, !!last.security, c.git) } : r)
    // 停在提問、題目已在對話處理的那次：結論照記，不替它跑檢查或派 Agent（也就不會因為被取代而停掉它）。
    const next = askClearedOnCard(last, c.ask) ? handedOver(planned) : planned
    if (!next) { await markHandled(); continue }
    if (next.kind === 'verify') { void runVerify($, c, true); continue }
    await markHandled()
    // 要派下一步之前先看 worktree：有不是上一個 Agent 留下的未提交改動（別的對話在改），停下來說原因，不派。
    const foreign = next.kind === 'dispatch' && !tutorial ? markRefusal(await worktreeMark($, c.root), jobs[key]) : ''
    const step: ChainStep = foreign ? { kind: 'stop', reason: foreign } : next
    if (step.kind === 'stop') {
      await saveChain($, key, r => r ? paused(r, step.reason, step.atCheck) : r)
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
      const plan: AutoPrPlan | undefined = auto ? autoPrPlan({ ...c, pr }) : undefined
      const words = passWords(c.name, plan, step.skipped)
      const text = step.needsHuman ? `${c.name} ${step.needsHuman}` : words.feed
      await feedPush($, [{ at: s.at, text, tone: step.needsHuman ? 'warning' : 'success', card: c.statusPath }])
      const say = step.needsHuman ? `${c.name}：${step.needsHuman}` : words.say
      $.ui.toast(say, { timeoutMs: 10_000 })
      notify($, say)
      if (plan) await autoPublish($, options, { ...c, pr }, plan)
    } else {
      await saveChain($, key, r => r ? { ...r, round: step.round } : r)
      const fix: FixReason | undefined = step.reason ? { from: step.reason as 'check' | 'review', round: step.round, ...(step.reason === 'check' ? { tail: fresh?.tail ?? [] } : {}) } : undefined
      await dispatch($, options, { ...c, state: 'ready' }, step.dispatch, { fix, auto: true, ...(step.security ? { security: true } : {}) })
    }
  }
  if (acted) refreshSoon($, options)
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
function refreshSoon($: any, options: PluginOptions) {
  soonTimer?.cancel()
  soonTimer = $.clock.after(2000, () => { soonTimer = undefined; void refresh($, options) })
}

/** 有東西在跑才轉；沒有就停，不浪費重繪。 */
async function spin($: any, wanted: boolean) {
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

/** 按下時再問一次背景 agent 清單的上限：查不到就照快照，不讓按鈕卡太久。 */
const PRESS_AGENTS_MS = 10_000

/**
 * 面板上的檢查、確認規格、上線確認、歸檔按下時才看最新狀態：按鈕可能是 Agent 開始前畫的，
 * 那件現在執行中或等批准就不動 worktree 與卡片、也不待確認，toast 說明。自動流程的檢查不經過這裡。
 */
async function busyRefused($: any, c: Case, doing: string, live = true): Promise<boolean> {
  if (!(await busyNow($, c, live))) return false
  $.ui.toast(`${c.name}：${WORD.busyRefused}${doing}`)
  return true
}

/**
 * 那件現在是不是執行中或等批准：先看最新快照；live 再問一次 claude agents（約 0.7 秒）。
 * 要按兩次的動作第一次只看快照，免得查詢拖過確認時限；真的要做的那一次才 live。
 */
async function busyNow($: any, c: Case, live: boolean): Promise<boolean> {
  const latest = (await read($, snapshot))?.cases.find(x => x.statusPath === c.statusPath) ?? c
  if (isBusy(latest)) return true
  return live && await startedSince($, latest)
}

/** 按兩次確認的動作：第一次只看快照就待確認，第二次（真的要做）才即時查 Agent。 */
async function confirmedIdle($: any, c: Case, key: string, doing: string): Promise<boolean> {
  if (await busyRefused($, c, doing, false)) return false
  return await confirmed($, `${c.statusPath}\n${key}`) && !(await busyRefused($, c, doing))
}

/** 快照之後才開始跑的 Agent：下一輪重新整理前快照還不知道，按下時直接問 claude agents。 */
async function startedSince($: any, c: Case): Promise<boolean> {
  if (tutorial || c.demo) return false
  const out = await $.process.run(['claude', 'agents', '--json', '--all'], { timeoutMs: PRESS_AGENTS_MS }).catch(() => null)
  if (!out || out.exitCode !== 0) return false
  const agent = agentsByRoot(supersede(rawAgents(out.stdout), lastLaunches(await loadJobs($))).list)[c.root]
  return !!agent && isBusy({ ...c, agent })
}

/** 完成檢查：第一次跑某條指令先問；之後同一條直接跑。結果記在 $.store，重開也在。 */
/** 排隊等著跑的檢查（同一時間只跑一個：測試共用主工作區的容器與資料庫，同時跑會互相干擾）。 */
const checkQueue: { statusPath: string; auto: boolean }[] = []
/**
 * 正在跑檢查的那一件。判斷「有沒有人在跑」與佔位之間不能有 await：同一輪重新整理裡兩件的實作一起結束時，
 * 流程會連著叫兩次 runVerify，讀 verifyingAtom 再寫回會兩件都以為沒人在跑。
 */
let checking: string | null = null
const isQueued = (statusPath: string) => checkQueue.some(q => q.statusPath === statusPath)
/** 這件的完成檢查正在跑或在檢查隊伍裡：派工隊伍先跳過它，不跟檢查搶 worktree。 */
export const verifyPending = (statusPath: string): boolean => checking === statusPath || isQueued(statusPath)
/** 派工啟動中的那幾件派的是什麼：「啟動中」佔位帶著它，流程派審查的那一刻六段不退回實作。 */
let launchKinds: Record<string, NonNullable<AgentInfo['kind']>> = {}

/** 回傳有沒有接手：開跑或排進隊伍是 true；沒跑（卡片沒檢查、還沒核准、按了取消、已經在跑或在排）是 false。 */
async function runVerify($: any, c: Case, auto = false, fromQueue = false): Promise<boolean> {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return false }
  if (!c.verify) { $.ui.toast(`${c.name}：卡片尚缺完成檢查`); return false }
  if (checking === c.statusPath) { if (!auto) $.ui.toast(`${c.name}：檢查仍在執行`); return false }
  if (!fromQueue && isQueued(c.statusPath)) { if (!auto) $.ui.toast(`${c.name}：已在排隊`); return false }
  const trusted = await trustedChecks($)
  if (trusted[c.statusPath] !== c.verify) {
    if (auto) return false
    const answer = await $.ui.ask(`在 ${c.root} 執行完成檢查：\n${c.verify}\n之後同一條指令不再問，自動流程也會用它。`, { header: `${c.name} 檢查`, options: ['執行', '取消'] }).catch(() => '')
    if (answer !== '執行') return false
    await $.store.set(TRUST_KEY, { ...trusted, [c.statusPath]: c.verify })
    // 對話框可能開了很久：回答的這段時間 Agent 開始跑了，就不在它的 worktree 上跑檢查。
    if (await busyRefused($, c, '檢查')) return false
  }
  // 問完之後再看一次：等你回答的這段時間，它可能已經被排進隊伍或開始跑了。
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
    await verifyBroke($, c, auto, error).catch(again => $.ui.toast(`${c.name}：檢查中斷，原因也記不下來（${errorText(again)}）`, { timeoutMs: 10_000 }))
  }
  // 不管跑成怎樣都放掉位子、接下一件：出錯也不能讓排隊的任務永遠等下去。
  finally { checking = null; void nextInQueue($) }
  return true
}

/** 檢查途中出錯（不是測試沒過，是記不下結果）：清掉「測試執行中」、寫進動態；流程停下並寫明原因，不再自動重跑。 */
async function verifyBroke($: any, c: Case, auto: boolean, error: unknown) {
  const reason = `檢查中斷：${errorText(error)}`
  $.ui.toast(`${c.name}：${reason}`, { timeoutMs: 10_000 })
  const now = await $.clock.now()
  await feedPush($, [{ at: now, text: `${c.name} ${reason}`, tone: 'error', card: c.statusPath }])
  await tellPanel($, now, reason, { name: c.name, skip: auto || tutorial })
  await update($, verifyingAtom, v => Object.fromEntries(Object.entries(v).filter(([k]) => k !== c.statusPath)))
  if (auto) await saveChain($, normalizeRoot(c.root), r => r ? paused(r, reason, true) : r)
  await restage($, c.statusPath)
  await spin($, false)
}

/** 佔到位子之後真正跑檢查：容器沒起來就不跑；跑完記結果、更新六段。回傳有沒有跑完、記下結果。 */
async function executeVerify($: any, c: Case, auto: boolean): Promise<boolean> {
  // 檢查要用的容器沒在跑：不執行，也不記成「未通過」，直接說要先啟動哪個。
  const box = await containers($, optionsRef!)
  const missing = missingServices(c.verify, box, (await loadSettings($, optionsRef!)).checkServices)
  if (missing.length) {
    const reason = `容器 ${missing.join('、')} 未啟動，請先在主工作區執行 docker compose up -d ${missing.join(' ')}`
    $.ui.toast(`${c.name}：${reason}`, { timeoutMs: 10_000 })
    const now = await $.clock.now()
    await feedPush($, [{ at: now, text: `${c.name} 檢查未執行：${reason}`, tone: 'warning', card: c.statusPath }])
    await tellPanel($, now, `檢查未執行：${reason}`, { name: c.name, skip: auto || tutorial })
    if (auto) await saveChain($, normalizeRoot(c.root), r => r ? paused(r, reason, true) : r)
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
  const outcome = result.ok ? '檢查通過' : `檢查未通過（exit ${result.exitCode}）`
  await feedPush($, [{ at: result.at, text: `${c.name} ${outcome}`, tone: result.ok ? 'success' : 'error', card: c.statusPath }])
  await tellPanel($, result.at, outcome, { name: c.name, skip: auto || tutorial })
  $.ui.toast(`${c.name}：${result.ok ? '檢查通過' : '檢查未通過'}`, { timeoutMs: 6000 })
  await update($, snapshot, s => s ? { ...s, cases: s.cases.map(x => { if (x.statusPath !== c.statusPath) return x; const y = { ...x, state: stateOf(x, result) }; const z = { ...y, pipeline: pipeline(y, result) }; return { ...z, state: finalState(z) } }) } : s)
  await spin($, false)
  if (auto) refreshSoon($, optionsRef!)
  return true
}

/**
 * 流程停在檢查段（指令未核准、容器沒啟動、檢查中斷），你排除後按 v 跑完了：解除暫停，
 * 讓流程把剛跑完的結果當成這次實作的檢查往下走（通過派審查、沒過派修正，輪數照算）。別的對話開的流程不動。
 */
async function resumeAtCheck($: any, c: Case) {
  // 已經合併：流程不再往下走，檢查結果記下就好，流程與派工紀錄都不動。
  if (isMerged(c)) return
  const key = normalizeRoot(c.root)
  const run = (await loadChains($))[key]
  if (!run?.stopped || !run.heldAtCheck || run.owner !== (await me($))) return
  await saveChain($, key, r => {
    if (!r) return r
    const { stopped: _s, heldAtCheck: _h, ...rest } = r
    return rest
  })
  // 停下時流程已把那次實作記成處理過（指令未核准的那種）：改回未處理，流程才會接手。
  const all = await loadJobs($)
  const last = all[key]?.last
  if (last?.handled) {
    const { handled: _, ...open } = last
    await $.store.set(JOBS_KEY, { ...all, [key]: { ...all[key], last: open } })
  }
  await feedPush($, [{ at: await $.clock.now(), text: `${c.name} 流程繼續：檢查跑完了，接著自動往下走`, tone: 'suggestion', card: c.statusPath }])
  refreshSoon($, optionsRef!)
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

/** 接著跑排隊中的下一件；用快照裡最新的卡片內容。 */
async function nextInQueue($: any) {
  if (checking !== null) return
  const next = checkQueue.shift()
  await update($, queueAtom, () => checkQueue.map(q => q.statusPath))
  if (!next) return
  const c = (await read($, snapshot))?.cases.find(x => x.statusPath === next.statusPath)
  if (!c) { void nextInQueue($); return }
  // 排隊期間這件的 Agent 開始跑了（派工不看隊伍）：不跟它搶 worktree，當成沒接手、換下一件。
  const took = await busyRefused($, c, '檢查') ? false : await runVerify($, c, next.auto, true).catch(error => {
    $.ui.toast(`${c.name}：排隊的檢查沒跑成（${errorText(error)}）`, { timeoutMs: 10_000 })
    return false
  })
  // 輪到它卻沒接手（排隊期間卡片的檢查改了或清掉、還沒授權、按了取消）：這件不跑了，六段不再寫「排隊中」，換下一件，後面的不用一直等。
  if (!took) { await restage($, next.statusPath); void nextInQueue($) }
}
export let optionsRef: PluginOptions | undefined

/**
 * 這個對話佔了名額、還沒派完的派工（卡片路徑）：通過名額判斷就同步佔位，派完（成功、失敗或拋錯）才放掉。
 * 「啟動中」佔位要等幾個 await 之後才寫，只看它的話，同時派好幾件會都看到有空位。
 */
const slots = new Set<string>()
const LAUNCHING = '上一次派工仍在啟動'

/** 這個對話正在啟動中的派工有幾件。 */
export const launchingCount = (): number => slots.size

/** 現在在跑的工作桌 Agent（整台機器）：即時問 claude agents，問不到用上一輪的清單，也沒有就當 0（不擋派工）。 */
async function runningDeskNow($: any): Promise<number> {
  const out = await $.process.run(['claude', 'agents', '--json', '--all'], { timeoutMs: PRESS_AGENTS_MS }).catch(() => null)
  const list = out && out.exitCode === 0 ? rawAgents(out.stdout) : lastAgents
  return list ? runningDeskAgents(list) : 0
}

/** 這件有派工還在啟動（已佔名額或已寫「啟動中」佔位）。 */
async function starting($: any, statusPath: string): Promise<boolean> {
  return statusPath in (await read($, launchingAtom)) || slots.has(statusPath)
}

/** 這件有派工還在啟動，這次不派：從隊伍取出的寫動態說原因（隊伍裡已經拿掉，不默默不見），其他的跳提示。 */
async function refuseStarting($: any, c: Case, kind: DispatchKind, opts: QueueOpts & { fromQueue?: number }) {
  if (opts.fromQueue !== undefined) await notSent($, c, { statusPath: c.statusPath, kind, opts }, LAUNCHING, await $.clock.now(), await me($))
  else $.ui.toast(`${c.name}：${LAUNCHING}`)
}

const alreadyQueued = (c: Case) => `${c.name}：已在派工隊伍（第 ${queuePosition(c.statusPath)} 位），k 取消排隊`

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
  // 從隊伍派出的：排隊前已核准過，排隊期間檢查改了的在隊伍那邊就擋下，不再跳對話框。
  if (kind === 'continue' && !opts.auto && !fromQueue) {
    if (!(await approveCheck($, c))) return false
    // 等你回答的這段時間，可能已經從別處派出去了（例如又打了 /desk go）。
    if (await starting($, c.statusPath)) { await refuseStarting($, c, kind, opts); return false }
  }
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
      const pitfalls = paths.pitfalls
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
    const confirmed = tutorial ? startSim($, options, c, kind, name, now, opts) : await launch($, c, prompt, { model, effort, sessionId, name })
    const record: JobRecord = { launchName: name, nativeId: String(confirmed.id ?? name), sessionId: confirmed.sessionId!, kind, startedAt: now, fresh, owner: await me($), ...(opts.fix ? { round: opts.fix.round } : {}), ...(opts.security ? { security: true } : {}) }
    // 手動按繼續或審查就開一輪新的流程；自動派的接續原本那輪。
    if (!opts.auto && (kind === 'continue' || kind === 'review')) await saveChain($, rootKey, r => ({ owner: record.owner!, startedAt: now, round: 0, ...(r?.judgedHead ? { judgedHead: r.judgedHead, ...(r.judgedBranch ? { judgedBranch: r.judgedBranch } : {}) } : {}) }))
    // 派審查時的 HEAD 連同它所在的分支一起記：合併辨識只認「這條分支」看過的 HEAD。
    if (kind === 'review' && probed) await saveChain($, rootKey, r => r ? { ...r, ...(opts.security ? { securityHead: probed.head, securityBranch: probed.branch } : { reviewHead: probed.head, reviewBranch: probed.branch }) } : r)
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

const notified = new Set<string>()
export function notify($: any, text: string) {
  if (!active || tutorial || notified.has(text)) return
  notified.add(text)
  void Promise.resolve().then(() => $.ui.notify(text, { title: 'desk' })).catch(() => {})
}

/** 卡片或登錄表剛被改過（卡片腳本、對話、回合結束）後重新整理：已有一輪在跑（可能在改之前就讀過）就等它結束再讀一輪。 */
export async function refreshAfterWrite($: any, options: PluginOptions) {
  if (refreshing) await refreshing.catch(() => {})
  return refresh($, options)
}

const KIND_ARG: Record<string, DispatchKind> = { go: 'continue', continue: 'continue', sync: 'sync', review: 'review', reply: 'reply' }

export const register: Register = (on, options) => {
  optionsRef = options
  on('session.start', async ($, e, next) => {
    active = false
    setTutorial(null)
    cancelSim()
    refreshTimer?.cancel(); refreshTimer = undefined
    spinTimer?.cancel(); spinTimer = undefined
    await update($, verifyingAtom, () => ({}))
    await update($, launchingAtom, () => ({}))
    // 新對話（含 /clear）：重附卡片全文，之前送出的決策不帶著鎖進來。
    await resetPromptSync($)
    checkQueue.length = 0
    checking = null
    launchKinds = {}
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
      // 點已經在現在卡的那件不動作；取消選取只走「更多動作」的 deselect。
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
      verify: c => void (async () => { if (!(await busyRefused($, c, '檢查'))) await runVerify($, c) })(),
      open: c => void openCard($, c),
      dispatch: (c, kind) => void (async () => {
        if (kind === 'reply') return reply($, options, c)
        if (await confirmed($, `${c.statusPath}\n${kind}`)) await dispatch($, options, c, kind)
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

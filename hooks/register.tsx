// desk：工作桌。讀登錄表與每件任務的 DESK 卡，摘要列一行、/desk 面板一張；決策按鍵填入、完成檢查一鍵、開啟卡片，
// 以及派工：繼續／同步／審查／回覆都是 `claude --bg` 在任務根目錄開一個背景 agent，session 對應記在 $.store。
// 不寫卡、不碰正式環境。教學模式的執行在 tutorial-run.tsx，不依賴模組狀態的 I/O 小工具在 desk-io.ts。
import { atom, read, update } from 'claude-code'
import type { Register, PluginOptions } from 'claude-code'
import type { AgentInfo, Case, Snapshot, Verify } from '../types'
import { parseRegistry, parseDecisions, decisionAnswer, decisionPrompt, allPicked, confirmShip, ARCHIVE_WORD, CARD_CMD } from './card'
import { agentsByRoot, buildCase, caseNamed, demoCases, endedHow, events, feedOnDesk, liveCases, rawAgents, supersede, asksFor, agentInfo, stateOf, plain, errorLine, reasonLine, slugOf } from './model'
import { archiveReview, baseRefs, commitTime, containers, deskPaths, diffBase, gitProbe, gitStatus, home, lastLine, loadSettings, logTail, mergedProbe, models, prProbe, riskOf, versions, verifyResult, worktreeMark } from './probes'
import { deploySteps, nextCase, parseReminders, reviewTop } from './extras'
import { sorted } from './model'
import { layoutBand, renderBand } from './band'
import { renderPane, picksKey } from './pane'
import type { PaneActions, PaneView } from './pane'
import { KIND_LABEL, REVIEW_FILE, buildPrompt, dispatchRefusal, launchName, markRefusal, modelFor, normalizeRoot, replyRefusal, specBlocks, specGapReason } from './dispatch'
import type { DispatchKind, FixReason, JobRecord, RootJobs, ReviewOpts } from './dispatch'
import { awaitsSpecOk, blocking, canArchive, checkStands, finalState, isMerged, isReleaseLine, movedSince, parseVerdict, pipeline } from './pipeline'
import { AGENT_STOPPED, nextStep, paused } from './chain'
import { missingServices } from './containers'
import { compactStatus, textKey } from './digest-status'
import type { ChainRun, ChainStep } from './chain'
import { TUTORIAL_RELEASE, tutorialPaths } from './tutorial'
import type { TutorialState } from './tutorial'
import { tutorial, TUTORIAL_KEY, setTutorial, cancelSim, simAgents, startSim, resumeTutorial, tutorialDecision, tutorialAct, tutorialStart, tutorialEnd } from './tutorial-run'
import { JOBS_KEY, MAX_REFRESH_S, MIN_REFRESH_S, SESSIONS_KEY, SPIN_MS, TRUST_KEY, VERIFIES_KEY, confirmed, feedPush, launch, loadChains, loadJobs, loadSummaries, me, openPath, openWith, registryError, saveChain, statusLine, summarizeStatuses, toggleLogs } from './desk-io'
import type { Timer } from './desk-io'
import { noticeOf } from './update'
import { autoUpdateCheck, loadUpdateCheck, runUpdate } from './update-run'
import { sentState } from './turn'
import { cancelPromptSync, readSent, registerPromptSync, resetPromptSync } from './prompt-sync'
import { lastLaunches, stopSuperseded } from './stale-agents'

const PANE = 'desk'
const DEMO_ONLY = '示範任務只能看；請照教學那件的指示操作'
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
const showAllAtom = atom({ plugin: 'desk', key: 'showAllActions' } as const, false)
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
    const error = text !== null ? null : tutorial ? `無法讀取教學的登錄表 ${path}；輸入 /desk tutorial end 回到你的任務` : registryError(paths!)
    const rows = parseRegistry(text ?? '', await home($))
    knownPaths = [...(path ? [path] : []), ...rows.map(r => r.statusPath)]
    // 教學不看真的背景 agent，只看模擬的那一個。
    const agentsOut = tutorial ? null : await $.process.run(['claude', 'agents', '--json', '--all'], { timeoutMs: 60_000 }).catch(() => null)
    const jobs = await loadJobs($)
    // 被後來派工取代、還停在提問的工作桌 Agent 不代表任務：拿掉它們再挑（狀態照卡片走），之後停掉。
    const { list, superseded } = supersede(agentsOut && agentsOut.exitCode === 0 ? rawAgents(agentsOut.stdout) : [], lastLaunches(jobs))
    const agents: Record<string, AgentInfo> = tutorial ? simAgents() : agentsOut && agentsOut.exitCode === 0 ? agentsByRoot(list) : {}
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
      let agent: AgentInfo | undefined = base.agent
      if (!agent && last && !last.answered) agent = asksFor(list, last.launchName) ?? undefined
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
      const withAgent = { ...base, ...(agent ? { agent } : {}), ...probe, ...(pr ? { pr } : {}), ...(chain ? { chain } : {}), ...(gitState ? { gitState } : {}), ...(commit ? { commitAt: commit.at, changedAt: commit.changedAt } : {}), ...(steps.length ? { deploySteps: steps } : {}), ...(top.length ? { reviewTop: top } : {}) }
      const withState = { ...withAgent, state: stateOf(withAgent, verifies[row.statusPath]) }
      const short = withState.status ? summaries[textKey(withState.status)] ?? compactStatus(withState.status) : undefined
      const stages = (x: Case) => pipeline(x, verifies[row.statusPath], row.statusPath in verifying, isQueued(row.statusPath))
      // 合併段、沒有已合併的 PR：問 git 分支 HEAD 是不是已經在基準分支裡（GitLab、沒裝 gh、本機合併都靠這個）。
      // 審查後又有 commit 的（六段退回檢查）也要問：可能是改完直接合併了。
      const atMerge = !tutorial && (stages(withState).current === 'merge' || !!withState.chain?.stale) && withState.pr?.state !== 'MERGED'
      const into = atMerge ? await mergedProbe($, withState, cardBase, forcePr) : undefined
      const merged = into ? { ...withState, mergedInto: into } : withState
      const piped = { ...merged, ...(short ? { statusShort: short } : {}), pipeline: stages(merged) }
      return { ...piped, state: finalState(piped) }
    }))
    const usage = await $.session.usage().catch(() => null)
    const limits = (usage?.rateLimits ?? []).map((l: any) => ({ kind: String(l.kind), remaining: 100 - (Number(l.percentUsed) || 0), ...(l.resetsAt ? { resetsAt: String(l.resetsAt) } : {}) }))
    const deskVersions = await versions($, cases)
    const notice = settings && settings.updateCheck !== 'off' ? noticeOf(await loadUpdateCheck($), deskVersions.desk) : undefined
    // 教學模式：示範任務接在後面當「其他任務」的背景（只能看）；版本、轉圈等仍只看真的任務。
    const cur: Snapshot = { at: now, cases: tutorial ? [...cases, ...demoCases(now)] : cases, error, ...(paths?.project ? { project: paths.project.key } : {}), contextPercent: typeof usage?.context?.percent === 'number' ? Math.round(usage.context.percent) : null, limits, versions: deskVersions, models: await models($, options, turnModel), containers: await containers($, options), reminders: parseReminders(text ?? '', now), ...(notice ? { update: notice } : {}), ...(tutorial ? { tutorial: true } : {}) }
    if (mine !== generation) return
    // 選取的任務已不在登錄表（歸檔、換專案）：取消選取，提示不再附它的卡。讀到空的登錄表（正在被改寫）不算。
    if (!error && rows.length) {
      await update($, selected, v => (v && !cur.cases.some(c => c.statusPath === v) ? null : v))
      await update($, feedAtom, list => feedOnDesk(list, cur.cases))
    }
    const prev = await read($, snapshot)
    const fresh = events(prev, cur)
    await update($, snapshot, () => cur)
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
    if (!tutorial && agentsOut && agentsOut.exitCode === 0) await noteEnded($, list, cases)
    await autoChain($, options, cur)
    void summarizeStatuses($, options, cur, summaries)
    if (settings && settings.updateCheck !== 'off' && !tutorial) void autoUpdateCheck($, now)
  })().catch(async (error: unknown) => {
    const message = `工作桌讀取失敗：${error instanceof Error ? error.message : String(error)}`
    await update($, snapshot, prev => prev ? { ...prev, error: message } : { at: 0, cases: [], error: message, contextPercent: null })
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
    if (!merged && run?.passed && c.chain?.stale && run.owner === mine && !agentBusy && !c.agent?.asks && !(c.statusPath in verifies) && !(c.statusPath in (await read($, launchingAtom)))) {
      await recheck($, key, run, last, mine, s.at)
      await feedPush($, [{ at: s.at, text: `${c.name} 審查通過後有新 commit，自動重新檢查與審查`, tone: 'suggestion', card: c.statusPath }])
      acted = true
      continue
    }
    if (!run || run.owner !== mine || !last || last.handled || agentBusy || c.agent?.asks || c.statusPath in verifies || checking === c.statusPath || isQueued(c.statusPath) || c.statusPath in (await read($, launchingAtom))) continue
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
    if (finished === 'review' && !stoppedAgent) await saveChain($, key, r => r ? { ...r, judgedHead: (last.security ? r.securityHead : r.reviewHead) ?? c.git?.head ?? r.judgedHead } : r)
    if (planned.kind === 'verify') { void runVerify($, c, true); continue }
    await markHandled()
    // 要派下一步之前先看 worktree：有不是上一個 Agent 留下的未提交改動（別的對話在改），停下來說原因，不派。
    const foreign = planned.kind === 'dispatch' && !tutorial ? markRefusal(await worktreeMark($, c.root), jobs[key]) : ''
    const step: ChainStep = foreign ? { kind: 'stop', reason: foreign } : planned
    if (step.kind === 'stop') {
      await saveChain($, key, r => r ? paused(r, step.reason, step.atCheck) : r)
      await feedPush($, [{ at: s.at, text: `${c.name} 流程已暫停：${step.reason}`, tone: 'error', card: c.statusPath }])
      $.ui.toast(`${c.name}：流程已暫停，${step.reason}`, { timeoutMs: 10_000 })
      notify($, `${c.name}：流程已暫停，${step.reason}`)
    } else if (step.kind === 'pass') {
      const judged = step.skipped ? fresh?.head ?? c.git?.head : undefined
      await saveChain($, key, r => r ? { ...r, passed: true, ...(step.needsHuman ? { needsHuman: step.needsHuman } : {}), ...(step.skipped ? { skippedReview: true } : {}), ...(judged ? { judgedHead: judged } : {}) } : r)
      const text = step.needsHuman ? `${c.name} ${step.needsHuman}` : step.skipped ? `${c.name} 只動文件、檢查通過，免審查，可開 PR` : `${c.name} 審查通過，可開 PR`
      await feedPush($, [{ at: s.at, text, tone: step.needsHuman ? 'warning' : 'success', card: c.statusPath }])
      const say = step.needsHuman ? `${c.name}：${step.needsHuman}` : step.skipped ? `${c.name}：只動文件，免審查，可以開 PR` : `${c.name}：審查通過，可以開 PR`
      $.ui.toast(say, { timeoutMs: 10_000 })
      notify($, say)
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
  await saveChain($, key, () => ({ owner, startedAt: now, round: 0, recheck: true, ...(run.reviewHead ? { reviewHead: run.reviewHead } : {}), ...(run.judgedHead ? { judgedHead: run.judgedHead } : {}) }))
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
  $.ui.status(undefined)
  await update($, snapshot, () => null)
  await $.ui.close({ id: PANE }).catch(() => {})
  const id = await $.session.id().catch(() => null)
  const list = ((await $.store.get(SESSIONS_KEY).catch(() => null)) as string[] | null) ?? []
  if (typeof id === 'string' && list.includes(id)) await $.store.set(SESSIONS_KEY, list.filter(x => x !== id))
}

export async function openPane($: any) {
  await update($, isPaneOpen, () => true)
  const opened = await $.ui.open({ id: PANE, title: 'desk', focus: true, closeOnEscape: true, rows: 18, columns: 72 })
  if (opened && opened.isPlaced === false) $.ui.toast(`工作桌面板尚未顯示（${plain(String(opened.reason ?? ''))}）；輸入 /desk 開啟`)
}

/** 摘要列按鈕：開或關看引擎的實際狀態（畫出且在最前面才算看得到），不看 isPaneOpen；引擎卸下面板時 ui.close hook 不會執行，那個值會停在 true。 */
async function togglePane($: any) {
  const pane = ((await $.ui.panes().catch(() => [])) as { id: string; isPlaced: boolean; isShown: boolean }[]).find(p => p.id === PANE)
  if (pane?.isPlaced && pane.isShown) { await update($, isPaneOpen, () => false); await $.ui.close({ id: PANE }).catch(() => {}) }
  else await openPane($)
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
/** 派工啟動中的那幾件派的是什麼：「啟動中」佔位帶著它，流程派審查的那一刻六段不退回實作。 */
let launchKinds: Record<string, NonNullable<AgentInfo['kind']>> = {}

/** 這個對話核准過的完成檢查：卡片路徑 → 指令全文。 */
async function trustedChecks($: any): Promise<Record<string, string>> {
  return ((await $.store.get(TRUST_KEY).catch(() => null)) as Record<string, string> | null) ?? {}
}

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

const errorText = (error: unknown) => plain(error instanceof Error ? error.message : String(error))

/** 檢查途中出錯（不是測試沒過，是記不下結果）：清掉「測試執行中」、寫進動態；流程停下並寫明原因，不再自動重跑。 */
async function verifyBroke($: any, c: Case, auto: boolean, error: unknown) {
  const reason = `檢查中斷：${errorText(error)}`
  $.ui.toast(`${c.name}：${reason}`, { timeoutMs: 10_000 })
  await feedPush($, [{ at: await $.clock.now(), text: `${c.name} ${reason}`, tone: 'error', card: c.statusPath }])
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
    await feedPush($, [{ at: await $.clock.now(), text: `${c.name} 檢查未執行：${reason}`, tone: 'warning', card: c.statusPath }])
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
  await feedPush($, [{ at: result.at, text: `${c.name} ${result.ok ? '檢查通過' : `檢查未通過（exit ${result.exitCode}）`}`, tone: result.ok ? 'success' : 'error', card: c.statusPath }])
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
 * 不等下一輪重新整理，現在卡與其他任務表格立刻一致。
 */
async function restage($: any, statusPath: string, patch: (c: Case) => Case = c => c) {
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
  const took = await runVerify($, c, next.auto, true).catch(error => {
    $.ui.toast(`${c.name}：排隊的檢查沒跑成（${errorText(error)}）`, { timeoutMs: 10_000 })
    return false
  })
  // 輪到它卻沒接手（排隊期間卡片的檢查改了或清掉、還沒授權、按了取消）：這件不跑了，換下一件，後面的不用一直等。
  if (!took) void nextInQueue($)
}
export let optionsRef: PluginOptions | undefined

/**
 * 派工：`claude --bg --name <唯一名> [--resume <任務的 session>] [--model] [--effort] <提示>` 在任務根目錄啟動，
 * 從啟動後的 agents 清單用名字對回完整 session id 才算成功；審查與（設了同步模型的）同步開新 session，不改任務的 session。
 */
async function dispatch($: any, options: PluginOptions, c: Case, kind: DispatchKind, opts: { text?: string; fix?: FixReason; auto?: boolean; security?: boolean } = {}) {
  const text = opts.text ?? ''
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  const refusal = opts.auto ? '' : dispatchRefusal(c, kind)
  if (refusal) { $.ui.toast(`${c.name}：目前無法${KIND_LABEL[kind]}（${refusal}）`); return }
  if (c.statusPath in (await read($, launchingAtom))) { $.ui.toast(`${c.name}：上一次派工仍在啟動`); return }
  if (kind === 'continue' && !opts.auto) {
    if (!(await approveCheck($, c))) return
    // 等你回答的這段時間，可能已經從別處派出去了（例如又打了 /desk go）。
    if (c.statusPath in (await read($, launchingAtom))) { $.ui.toast(`${c.name}：上一次派工仍在啟動`); return }
  }
  const settings = await loadSettings($, options)
  const { model, effort, fresh } = modelFor(settings, c.root, kind)
  const jobs = await loadJobs($)
  const rootKey = normalizeRoot(c.root)
  const own: RootJobs = jobs[rootKey] ?? {}
  // worktree 有不是上一個 Agent 留下的未提交改動（別的對話在改）：不派，免得把它的東西清掉。同步不改程式，不擋；自動流程在派之前已經看過。
  if (kind !== 'sync' && !opts.auto && !tutorial) {
    const foreign = markRefusal(await worktreeMark($, c.root), own)
    if (foreign) { $.ui.toast(`${c.name}：目前無法${KIND_LABEL[kind]}（${foreign}）`, { timeoutMs: 10_000 }); return }
  }
  const sessionId = fresh ? undefined : kind === 'reply' && own.last?.sessionId ? own.last.sessionId : own.sessionId
  const now = await $.clock.now()
  const name = launchName(now, launchSeq++)
  let review: ReviewOpts | undefined
  const head = kind === 'review' ? (await gitProbe($, c.root)).git?.head : undefined
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
  try {
    const confirmed = tutorial ? startSim($, options, c, kind, name, now, opts) : await launch($, c, prompt, { model, effort, sessionId, name })
    const record: JobRecord = { launchName: name, nativeId: String(confirmed.id ?? name), sessionId: confirmed.sessionId!, kind, startedAt: now, fresh, owner: await me($), ...(opts.fix ? { round: opts.fix.round } : {}), ...(opts.security ? { security: true } : {}) }
    // 手動按繼續或審查就開一輪新的流程；自動派的接續原本那輪。
    if (!opts.auto && (kind === 'continue' || kind === 'review')) await saveChain($, rootKey, r => ({ owner: record.owner!, startedAt: now, round: 0, ...(r?.judgedHead ? { judgedHead: r.judgedHead } : {}) }))
    if (kind === 'review' && head) await saveChain($, rootKey, r => r ? { ...r, ...(opts.security ? { securityHead: head } : { reviewHead: head }) } : r)
    const next: RootJobs = { ...(fresh ? { sessionId: own.sessionId } : { sessionId: confirmed.sessionId! }), ...(own.mark !== undefined ? { mark: own.mark } : {}), last: record }
    await $.store.set(JOBS_KEY, { ...jobs, [rootKey]: next })
    const agent: AgentInfo = { ...agentInfo(confirmed), status: 'busy', kind: doing }
    await restage($, c.statusPath, x => ({ ...x, agent, state: 'running' }))
    const label = opts.fix ? `修正第 ${opts.fix.round} 輪` : opts.security ? '資安審查' : KIND_LABEL[kind]
    await feedPush($, [{ at: now, text: `${c.name} ${opts.auto ? '自動' : ''}派${label}（${model || '預設模型'}${fresh ? '・新對話' : ''}）`, tone: 'suggestion', card: c.statusPath }])
    $.ui.toast(`${c.name}：${label}已派出`, { timeoutMs: 6000 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await feedPush($, [{ at: now, text: `${c.name} ${KIND_LABEL[kind]}失敗：${message}`, tone: 'error', card: c.statusPath }])
    $.ui.toast(`${c.name}：${KIND_LABEL[kind]}失敗，${message}`, { timeoutMs: 8000 })
  } finally {
    launchKinds = Object.fromEntries(Object.entries(launchKinds).filter(([k]) => k !== c.statusPath))
    await update($, launchingAtom, v => Object.fromEntries(Object.entries(v).filter(([k]) => k !== c.statusPath)))
    await spin($, false)
  }
}

const APPROVE = '核准並派工'

/**
 * 按 g 開始一輪流程：這張卡的完成檢查還沒核准過（或指令改過），先問；做完實作會自動執行它，流程不用停下等你按 v。
 * 回傳能不能派：核准或早就核准過是 true；取消或關掉對話框是 false，什麼都不記。
 */
async function approveCheck($: any, c: Case): Promise<boolean> {
  const trusted = await trustedChecks($)
  if (!c.verify || trusted[c.statusPath] === c.verify) return true
  const answer = await $.ui.ask(`在 ${c.root} 派實作。做完會自動執行這條完成檢查：\n${c.verify}\n核准後這張卡同一條指令不再問；不核准就不派工。`, { header: `${c.name} 核准檢查`, options: [APPROVE, '取消'] }).catch(() => '')
  if (answer !== APPROVE) return false
  await $.store.set(TRUST_KEY, { ...trusted, [c.statusPath]: c.verify })
  return true
}

/** 回覆停下來問的 Agent：先問要回什麼（可打自己的字），再 resume 那個 session。 */
async function reply($: any, options: PluginOptions, c: Case, text?: string) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  const why = replyRefusal(c)
  if (why) { $.ui.toast(`${c.name}：目前無法回覆（${why}）`); return }
  let answer = text?.trim() ?? ''
  if (!answer) {
    // 停在提問（status waiting）的 Agent 重新整理時不讀輸出：回覆這時才讀它最後一句。
    const asked = c.agent?.last || (tutorial ? '' : await lastLine($, c.agent?.id))
    const picked = await $.ui.ask(`${asked ? `Agent 提問：${asked}` : '讀不到 Agent 的提問，按 l 看輸出'}\n要回覆什麼？請選「照卡片的下一步繼續」，或在「其他」輸入回覆。`, { header: `${c.name} 回覆`, options: ['照卡片的下一步繼續', '取消'] }).catch(() => '')
    if (!picked || picked === '取消') return
    answer = picked === '照卡片的下一步繼續' ? `照卡片的下一步繼續：${c.next || '依卡片'}` : picked
  }
  // 不先把上一次派工標成已回覆：派出成功時 dispatch 會換上新的那筆；派工失敗時要留著，Agent 才仍算在等你、可以再回覆。
  await dispatch($, options, c, 'reply', { text: answer })
}

/** 合併段的「⇡ 開 PR」：只把要主對話做的事預填進輸入框，不自動送出；desk 自己不 push、不開 PR。 */
async function fillPrRequest($: any, options: PluginOptions, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  const [target] = await baseRefs($, c, (await loadSettings($, options)).cardBase ?? '')
  const text = `push ${c.git?.branch ?? '分支'} 並${target ? `對 ${target.replace(/^origin\//, '')} ` : ''}開 PR`
  const filled = await $.prompt.fill({ text, mode: 'replace' }).catch(() => ({ isFilled: false }))
  if (!filled.isFilled) $.ui.toast(`${c.name}：輸入框無法預填，請直接輸入：${text}`)
}

/** 合併段 PR 已開後的「⇡ push」：只預填「push <分支>」，不自動送出；desk 自己不 push。有未提交的檔案時提醒只會推已 commit 的。 */
async function fillPushRequest($: any, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  const text = `push ${c.git?.branch ?? '分支'}`
  const filled = await $.prompt.fill({ text, mode: 'replace' }).catch(() => ({ isFilled: false }))
  if (!filled.isFilled) $.ui.toast(`${c.name}：輸入框無法預填，請直接輸入：${text}`)
  if (c.gitState?.changed) $.ui.toast(`${c.name}：有 ${c.gitState.changed} 檔未提交，只會 push 已 commit 的`)
}

async function fillDecision($: any, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  const decisions = parseDecisions(c.ask)
  const picks = (await read($, picksAtom))[picksKey(c)] ?? {}
  if (!allPicked(decisions, picks)) { $.ui.toast(`${c.name}：請先完成每個決策的選擇（點選項或按數字鍵）`); return }
  if (sentState(await readSent($), c) === 'waiting') { $.ui.toast(`${c.name}：決策已送出，等對話寫回卡片`); return }
  const answer = decisionAnswer(decisions, picks)
  if (tutorial) { await tutorialDecision($, c, answer); return }
  const text = decisionPrompt(c.name, answer)
  const filled = await $.prompt.fill({ text, mode: 'replace' }).catch(() => ({ isFilled: false }))
  if (!filled.isFilled) { $.ui.toast(`${c.name}：輸入框無法預填，請直接輸入${text}`); return }
  $.ui.toast(`${c.name}：決策已填入，按 Esc 回到輸入框再按 Enter 送出；此任務的卡片會一併附上`, { timeoutMs: 6000 })
}

async function openCard($: any, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  if (!(await openWith($, c.statusPath))) $.ui.toast(`${c.name}：無法開啟 ${c.statusPath}`)
}

/** 系統通知（macOS 通知、手機）：同一句話這次載入只送一次，送不出去就算了。 */
const notified = new Set<string>()
function notify($: any, text: string) {
  if (!active || tutorial || notified.has(text)) return
  notified.add(text)
  void Promise.resolve().then(() => $.ui.notify(text, { title: 'desk' })).catch(() => {})
}

/** 上線確認：重讀卡片，關卡還是 release 才清成「無」並記 History；desk 只在這裡寫卡。 */
async function confirmShipped($: any, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  const text = await $.fs.read(c.statusPath).catch(() => null)
  const d = new Date(await $.clock.now())
  const two = (n: number) => String(n).padStart(2, '0')
  const next = typeof text === 'string' ? confirmShip(text, `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, `${two(d.getHours())}:${two(d.getMinutes())}`, c.tag ?? '', isReleaseLine(c) ? '等下一版開發' : `${ARCHIVE_WORD}：${CARD_CMD} archive ${slugOf(c)}`, (await loadSettings($, optionsRef!)).user) : null
  if (!next) { $.ui.toast(`${c.name}：卡片關卡已不是 release，沒有改動`); void refresh($, optionsRef!); return }
  const ok = await $.fs.write(c.statusPath, next).then(() => true).catch(() => false)
  if (!ok) { $.ui.toast(`${c.name}：寫入卡片失敗`); return }
  await feedPush($, [{ at: await $.clock.now(), text: `${c.name} 已確認上線${c.tag ? `（${c.tag}）` : ''}`, tone: 'success', card: c.statusPath }])
  $.ui.toast(`${c.name}：已確認上線，release 關卡已清除`)
  void refresh($, optionsRef!)
}

/** 卡片或登錄表剛被改過（卡片腳本、對話、回合結束）後重新整理：已有一輪在跑（可能在改之前就讀過）就等它結束再讀一輪。 */
export async function refreshAfterWrite($: any, options: PluginOptions) {
  if (refreshing) await refreshing.catch(() => {})
  return refresh($, options)
}

/** 在任務的 worktree 裡跑 /desk:card 用的那支腳本（cwd 讓它認得出同一個專案與登錄表）。 */
async function runCardScript($: any, options: PluginOptions, c: Case, cmd: 'spec-ok' | 'archive') {
  const env = { DESK_SETTINGS: (await deskPaths($, options)).settings }
  return $.process.run(['python3', `${$.plugin.root}/skills/card/scripts/card.py`, cmd, slugOf(c)], { cwd: c.root, timeoutMs: 30_000, env })
    .catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: String(e) }))
}

/**
 * 真實模式的歸檔：執行 /desk:card archive <slug> 用的同一支腳本；卡片與審查檔由腳本複製、登錄表由腳本改。
 * 不刪 worktree 與分支，只把腳本印出的刪除指令放進提示。失敗就提示錯誤原因（腳本印的第一行），任務留著。
 */
async function archiveCase($: any, options: PluginOptions, c: Case) {
  const r = await runCardScript($, options, c, 'archive')
  const now = await $.clock.now()
  if (r.exitCode !== 0) {
    const why = reasonLine(r)
    $.ui.toast(`${c.name}：歸檔失敗：${why}`, { timeoutMs: 10_000 })
    await feedPush($, [{ at: now, text: `${c.name} 歸檔失敗：${why}`, tone: 'error', card: c.statusPath }])
    void refreshAfterWrite($, options)
    return
  }
  const removeCmd = String(r.stdout ?? '').split(/\r?\n/).map((l: string) => l.trim()).find((l: string) => /\bworktree remove\b/.test(l))
  $.ui.toast(`${c.name}：已歸檔${removeCmd ? `；worktree 與分支確認後再自己刪：${removeCmd}` : ''}`, { timeoutMs: 15_000 })
  // 歸檔後這件離開工作桌：這筆不掛在它的卡上，換到哪件都看得到。
  await feedPush($, [{ at: now, text: `${c.name} 已歸檔（worktree 與分支保留）`, tone: 'success' }])
  void refreshAfterWrite($, options)
}

/**
 * 真實模式的確認規格：執行 /desk:card spec <slug> ok 用的同一支腳本（在任務的 worktree 裡跑，認得出同一個專案），
 * 卡片由腳本改；只確認、不派工。腳本失敗（卡片已被改過、找不到卡）就提示錯誤原因（腳本印的第一行），關卡留著。
 */
async function confirmSpec($: any, options: PluginOptions, c: Case) {
  const r = await runCardScript($, options, c, 'spec-ok')
  const now = await $.clock.now()
  if (r.exitCode !== 0) {
    const why = reasonLine(r)
    $.ui.toast(`${c.name}：確認規格失敗：${why}`, { timeoutMs: 10_000 })
    await feedPush($, [{ at: now, text: `${c.name} 確認規格失敗：${why}`, tone: 'error', card: c.statusPath }])
    void refreshAfterWrite($, options)
    return
  }
  await feedPush($, [{ at: now, text: `${c.name} 規格已確認，可以派實作`, tone: 'success', card: c.statusPath }])
  void refreshAfterWrite($, options)
}

/** 停止 desk 自己派出去、正在跑的那個背景 agent（名字要對得上這件任務最後一次派工），流程一併暫停。 */
async function stopAgent($: any, c: Case) {
  const last = (await loadJobs($))[normalizeRoot(c.root)]?.last
  if (!c.agent?.id || !last || c.agent.name !== last.launchName) { $.ui.toast(`${c.name}：只能停止 desk 派出去的 Agent`); return }
  if (tutorial) cancelSim()
  const r = tutorial ? { exitCode: 0, stderr: '' } : await $.process.run(['claude', 'stop', c.agent.id], { timeoutMs: 30_000 }).catch(() => null)
  if (!r || r.exitCode !== 0) { $.ui.toast(`${c.name}：無法停止（${errorLine(r, 'claude stop 失敗')}）`); return }
  await saveChain($, normalizeRoot(c.root), run => run ? paused(run, AGENT_STOPPED) : run)
  await feedPush($, [{ at: await $.clock.now(), text: `${c.name} ${AGENT_STOPPED}（對話保留）`, tone: 'warning', card: c.statusPath }])
  $.ui.toast(`${c.name}：已停止 Agent`)
  void refresh($, optionsRef!)
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
    await update($, queueAtom, () => [])
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
      if (m[1] === 'verify') { void runVerify($, c); return { text: `${c.name}：完成檢查已開始。` } }
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
    const ctxOf = (c: Case) => ({ verifying: c.statusPath in verifying, queued: queue.includes(c.statusPath), launching: c.statusPath in launching, tutorial: !!s.tutorial, sent: sentState(sent, c) })
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
    const view: PaneView = {
      s, now: await $.clock.now(), columns: Math.max(20, e.props.bodyColumns ?? 80), isFocused: !!e.props.isFocused,
      bodyRows: e.props.scroll?.bodyRows, placement: e.props.placement, offset: await read($, contentOffset),
      selected: await read($, selected), feed: await read($, feedAtom), picks: await read($, picksAtom),
      verifies: await read($, verifiesAtom), verifying: await read($, verifyingAtom), tick: await read($, tick), isExpanded: await read($, isExpanded),
      launching: await read($, launchingAtom),
      queue: await read($, queueAtom),
      armed: await read($, armedAtom),
      logsOpen: await read($, logsOpenAtom),
      logView: await read($, logViewAtom),
      isHelp: await read($, helpAtom),
      showAll: await read($, showAllAtom),
      sent: await readSent($),
    }
    const act: PaneActions = {
      select: path => void (async () => { await update($, selected, v => (v === path ? null : path)); await update($, contentOffset, () => 0) })(),
      pick: (c, index, key) => void update($, picksAtom, all => {
        const k = picksKey(c)
        const mine = all[k] ?? {}
        const others = Object.fromEntries(Object.entries(all).filter(([x]) => !x.startsWith(c.statusPath + '\n')))
        return { ...others, [k]: mine[String(index)] === key ? Object.fromEntries(Object.entries(mine).filter(([i]) => i !== String(index))) : { ...mine, [String(index)]: key } }
      }),
      fill: c => void fillDecision($, c),
      verify: c => void runVerify($, c),
      open: c => void openCard($, c),
      dispatch: (c, kind) => void (async () => {
        if (kind === 'reply') return reply($, options, c)
        if (await confirmed($, `${c.statusPath}\n${kind}`)) await dispatch($, options, c, kind)
      })(),
      stop: c => void (async () => { if (await confirmed($, `${c.statusPath}\nstop`)) await stopAgent($, c) })(),
      ship: c => void (async () => { if (await confirmed($, `${c.statusPath}\nship`)) await confirmShipped($, c) })(),
      specOk: c => void (async () => { if (!tutorial && awaitsSpecOk(c) && await confirmed($, `${c.statusPath}\nspec-ok`)) await confirmSpec($, options, c) })(),
      archive: c => void (async () => { if (!tutorial && canArchive(c) && await confirmed($, `${c.statusPath}\narchive`)) await archiveCase($, options, c) })(),
      tutorial: c => void tutorialAct($, options, c),
      logs: c => void toggleLogs($, c),
      openReview: c => void openPath($, `${c.root}/${REVIEW_FILE}`, '審查檔'),
      openPr: c => void (c.pr?.url ? openPath($, c.pr.url, ' PR') : undefined),
      fillPr: c => void fillPrRequest($, options, c),
      fillPush: c => void fillPushRequest($, c),
      next: () => void (async () => {
        const cur = await read($, snapshot)
        if (!cur) return
        // 示範任務只是背景：n 不會跳到它們。
        const list = sorted(liveCases(cur.cases))
        const at = await read($, selected) ?? list[0]?.statusPath ?? null
        const to = nextCase(list, at)
        if (to) { await update($, selected, () => to); await update($, contentOffset, () => 0) }
      })(),
      help: () => void update($, helpAtom, v => !v),
      more: () => void update($, showAllAtom, v => !v),
      refresh: () => { forcePr = true; void refresh($, options) },
      toggleBand: () => void update($, isBandHidden, v => !v),
      update: () => void runUpdate($),
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

const isEmpty = (node: any): boolean =>
  node === null || node === undefined || node === false || node === '' ||
  ((node.type === 'Box' || node.type === 'Text') && (node.children ?? []).every(isEmpty))

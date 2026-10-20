// desk：工作桌。讀登錄表與每件案子的 DESK 卡，摘要列一行、/desk 面板一張；決策按鍵填入、完成檢查一鍵、開啟卡片，
// 以及派工：繼續／同步／審查／回覆都是 `claude --bg` 在案子根目錄開一個背景 agent，session 對應記在 $.store。
// 不寫卡、不碰正式環境。教學模式的執行在 tutorial-run.tsx，不依賴模組狀態的 I/O 小工具在 desk-io.ts。
import { atom, read, update } from 'claude-code'
import type { Register, PluginOptions } from 'claude-code'
import type { AgentInfo, Case, Snapshot, Verify } from '../types'
import { parseRegistry, parseDecisions, decisionAnswer, allPicked, confirmShip, ARCHIVE_WORD, CARD_CMD } from './card'
import { buildCase, demoCases, events, liveCases, parseAgents, rawAgents, asksFor, agentInfo, stateOf, plain } from './model'
import { archiveReview, containers, deskPaths, diffBase, gitProbe, gitStatus, home, lastLine, loadSettings, logTail, mergedProbe, models, prProbe, riskOf, versions } from './probes'
import { deploySteps, nextCase, parseReminders, reviewTop } from './extras'
import { sorted } from './model'
import { layoutBand, renderBand } from './band'
import { renderPane, picksKey } from './pane'
import type { PaneActions, PaneView } from './pane'
import { KIND_LABEL, REVIEW_FILE, buildPrompt, dispatchable, launchName, modelFor, normalizeRoot } from './dispatch'
import type { DispatchKind, FixReason, JobRecord, RootJobs, ReviewOpts } from './dispatch'
import { checkStands, finalState, isReleaseLine, parseVerdict, pipeline } from './pipeline'
import { nextStep } from './chain'
import { missingServices } from './containers'
import { compactStatus, textKey } from './digest-status'
import type { ChainRun } from './chain'
import { TUTORIAL_RELEASE, tutorialPaths } from './tutorial'
import type { TutorialState } from './tutorial'
import { tutorial, TUTORIAL_KEY, setTutorial, cancelSim, simAgents, startSim, resumeTutorial, tutorialDecision, tutorialAct, tutorialStart, tutorialEnd } from './tutorial-run'
import { JOBS_KEY, MAX_REFRESH_S, MIN_REFRESH_S, SESSIONS_KEY, SPIN_MS, TRUST_KEY, VERIFIES_KEY, VERIFY_TIMEOUT_MS, cardContext, confirmed, feedPush, launch, loadChains, loadJobs, loadSummaries, me, openPath, openWith, registryError, saveChain, statusLine, summarizeStatuses, toggleLogs } from './desk-io'
import type { Timer } from './desk-io'
import { UPDATE_EVERY_MS, UPDATE_KEY, checkLatest, isNewer, noticeOf, noticeText, parseCheck, updateDesk } from './update'
import type { UpdateCheck } from './update'

const PANE = 'desk'
const DEMO_ONLY = '示範案子只能看；請照教學那件的指示操作'
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
    const error = text !== null ? null : tutorial ? `無法讀取教學的登錄表 ${path}；輸入 /desk tutorial end 回到你的案子` : registryError(paths!)
    const rows = parseRegistry(text ?? '', await home($))
    // 教學不看真的背景 agent，只看模擬的那一個。
    const agentsOut = tutorial ? null : await $.process.run(['claude', 'agents', '--json', '--all'], { timeoutMs: 60_000 }).catch(() => null)
    const list = agentsOut && agentsOut.exitCode === 0 ? rawAgents(agentsOut.stdout) : []
    const agents: Record<string, AgentInfo> = tutorial ? simAgents() : agentsOut && agentsOut.exitCode === 0 ? parseAgents(agentsOut.stdout) : {}
    const verifies = await read($, verifiesAtom)
    const jobs = await loadJobs($)
    const chains = await loadChains($)
    const summaries = await loadSummaries($)
    const launching = await read($, launchingAtom)
    const verifying = await read($, verifyingAtom)
    const settings = tutorial ? null : await loadSettings($, options)
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
      if (!agent && row.statusPath in launching) agent = { name: '啟動中', state: 'starting', status: 'busy' }
      if (agent && agent.id && !tutorial && (agent.status === 'busy' || agent.asks)) agent = { ...agent, last: await lastLine($, agent.id) }
      const probe = await gitProbe($, base.root)
      const pr = tutorial ? (tutorial.merged ? { id: 1, state: 'MERGED' as const, ci: 'none' as const, dest: TUTORIAL_RELEASE } : undefined) : probe.git ? await prProbe($, options, base.root, probe.git.branch, now, forcePr) : undefined
      const run = chains[normalizeRoot(base.root)]
      const stale = !!run?.judgedHead && !!probe.git?.head && probe.git.head !== run.judgedHead
      const chain = run ? { round: run.round, ...(stale ? { stale: true } : {}), ...(run.stopped ? { stopped: run.stopped } : {}), ...(run.passed ? { passed: true } : {}), ...(run.needsHuman ? { needsHuman: run.needsHuman } : {}), ...(run.skippedReview ? { skippedReview: true } : {}), ...(last ? { lastKind: (last.round ? 'fix' : last.kind) as any } : {}) } : undefined
      const gitState = probe.git ? await gitStatus($, base.root) : undefined
      const steps = deploySteps(card)
      const top = parseVerdict(base.gate) || run ? reviewTop(await $.fs.read(`${base.root}/${REVIEW_FILE}`).catch(() => null)) : []
      const withAgent = { ...base, ...(agent ? { agent } : {}), ...probe, ...(pr ? { pr } : {}), ...(chain ? { chain } : {}), ...(gitState ? { gitState } : {}), ...(steps.length ? { deploySteps: steps } : {}), ...(top.length ? { reviewTop: top } : {}) }
      const withState = { ...withAgent, state: stateOf(withAgent, verifies[row.statusPath]) }
      const short = withState.status ? summaries[textKey(withState.status)] ?? compactStatus(withState.status) : undefined
      const stages = (x: Case) => pipeline(x, verifies[row.statusPath], row.statusPath in verifying)
      // 合併段、沒有已合併的 PR：問 git 分支 HEAD 是不是已經在基準分支裡（GitLab、沒裝 gh、本機合併都靠這個）。
      const atMerge = !tutorial && stages(withState).current === 'merge' && withState.pr?.state !== 'MERGED'
      const into = atMerge ? await mergedProbe($, withState, cardBase, forcePr) : undefined
      const merged = into ? { ...withState, mergedInto: into } : withState
      const piped = { ...merged, ...(short ? { statusShort: short } : {}), pipeline: stages(merged) }
      return { ...piped, state: finalState(piped) }
    }))
    const usage = await $.session.usage().catch(() => null)
    const limits = (usage?.rateLimits ?? []).map((l: any) => ({ kind: String(l.kind), remaining: 100 - (Number(l.percentUsed) || 0), ...(l.resetsAt ? { resetsAt: String(l.resetsAt) } : {}) }))
    const deskVersions = await versions($, cases)
    const notice = settings && settings.updateCheck !== 'off' ? noticeOf(await loadUpdateCheck($), deskVersions.desk) : undefined
    // 教學模式：示範案子接在後面當「其他案子」的背景（只能看）；版本、轉圈等仍只看真的案子。
    const cur: Snapshot = { at: now, cases: tutorial ? [...cases, ...demoCases(now)] : cases, error, ...(paths?.project ? { project: paths.project.key } : {}), contextPercent: typeof usage?.context?.percent === 'number' ? Math.round(usage.context.percent) : null, limits, versions: deskVersions, models: await models($, options, turnModel), containers: await containers($, options), reminders: parseReminders(text ?? '', now), ...(notice ? { update: notice } : {}), ...(tutorial ? { tutorial: true } : {}) }
    if (mine !== generation) return
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
    await autoChain($, options, cur)
    void summarizeStatuses($, options, cur, summaries)
    if (settings && settings.updateCheck !== 'off') void autoUpdateCheck($, now)
  })().catch(async (error: unknown) => {
    const message = `工作桌讀取失敗：${error instanceof Error ? error.message : String(error)}`
    await update($, snapshot, prev => prev ? { ...prev, error: message } : { at: 0, cases: [], error: message, contextPercent: null })
  }).finally(() => { refreshing = null })
  return refreshing
}

async function loadUpdateCheck($: any): Promise<UpdateCheck | null> {
  return parseCheck(await $.store.get(UPDATE_KEY).catch(() => null))
}

let checkingUpdate = false
/**
 * desk 新版本的自動檢查：距離上次查到結果超過 24 小時才查（時間存 $.store，重開也算）。只提示、不安裝；
 * 同一個版號只在「最近」記一筆、跳一次 toast。查失敗不出聲、不記時間，下一輪再查。
 */
async function autoUpdateCheck($: any, now: number) {
  if (checkingUpdate || tutorial) return
  const prev = await loadUpdateCheck($)
  if (prev && now - prev.at < UPDATE_EVERY_MS) return
  checkingUpdate = true
  try {
    const found = await checkLatest($, now)
    const fresh = isNewer(found.latest, found.current) && prev?.notified !== found.latest
    const next: UpdateCheck = { ...found, ...(fresh ? { notified: found.latest } : prev?.notified ? { notified: prev.notified } : {}) }
    await $.store.set(UPDATE_KEY, next)
    await showNotice($, next)
    if (fresh) {
      await feedPush($, [{ at: now, text: `desk ${noticeText(found.latest)}`, tone: 'suggestion' }])
      $.ui.toast(`desk ${noticeText(found.latest)}`, { timeoutMs: 8000 })
    }
  } catch { /* 查失敗不提示，下一輪再查 */ } finally { checkingUpdate = false }
}

async function showNotice($: any, check: UpdateCheck) {
  await update($, snapshot, s => {
    if (!s) return s
    const notice = noticeOf(check, s.versions?.desk)
    const { update: _old, ...rest } = s
    return notice ? { ...rest, update: notice } : rest
  })
}

let updating = false
/** 手動更新（/desk update、面板按鈕）：結果記進「最近」並跳 toast；查到的版號給自動檢查沿用。 */
async function runUpdate($: any): Promise<string> {
  if (updating) return 'desk 正在更新中，請稍候。'
  updating = true
  try {
    const now = await $.clock.now()
    const r = await updateDesk($, now)
    if (r.check) {
      const prev = await loadUpdateCheck($)
      const check: UpdateCheck = { ...r.check, ...(prev?.notified ? { notified: prev.notified } : {}) }
      await $.store.set(UPDATE_KEY, check)
      await showNotice($, check)
    }
    await feedPush($, [{ at: now, text: r.text, tone: r.tone }])
    $.ui.toast(r.text, { timeoutMs: r.tone === 'success' ? 10_000 : 8000 })
    return r.text
  } finally { updating = false }
}

/** 讀不到登錄表時面板上的說明：選項指定的、這個專案還沒建的、目前資料夾不在 git repo 裡。 */
/**
 * 自動接力（第二到第四段）：只處理這個對話自己派出去、剛結束、還沒處理過的那一次。
 * 做完實作 → 跑完成檢查 → 綠了派審查 → 有 CRITICAL／HIGH 派修正，最多兩輪；停下來就寫進動態並提醒。
 */
async function autoChain($: any, options: PluginOptions, s: Snapshot) {
  const mine = await me($)
  const jobs = await loadJobs($)
  const chains = await loadChains($)
  const verifies = await read($, verifyingAtom)
  const trusted = ((await $.store.get(TRUST_KEY).catch(() => null)) as Record<string, string> | null) ?? {}
  let acted = false
  for (const c of s.cases) {
    const key = normalizeRoot(c.root)
    const run = chains[key]
    const last = jobs[key]?.last
    const agentBusy = !!c.agent && !c.agent.asks
    if (run?.passed && c.chain?.stale && run.owner === mine && !agentBusy && !c.agent?.asks && !(c.statusPath in verifies) && !(c.statusPath in (await read($, launchingAtom)))) {
      await recheck($, key, run, last, mine, s.at)
      await feedPush($, [{ at: s.at, text: `${c.name} 審查通過後有新 commit，自動重新檢查與審查`, tone: 'suggestion' }])
      acted = true
      continue
    }
    if (!run || run.owner !== mine || !last || last.handled || agentBusy || c.agent?.asks || c.statusPath in verifies || checkQueue.some(q => q.statusPath === c.statusPath) || c.statusPath in (await read($, launchingAtom))) continue
    const verify = (await read($, verifiesAtom))[c.statusPath]
    const fresh = verify && verify.at >= last.startedAt ? verify : undefined
    const finished: DispatchKind | null = last.kind === 'sync' ? null : last.kind
    const settings = finished ? await loadSettings($, options) : undefined
    const risk = settings ? await riskOf($, c, settings.riskHigh, settings.cardBase) : undefined
    const step = nextStep(run, finished, checkStands(c, fresh), parseVerdict(c.gate), trusted[c.statusPath] === c.verify && !!c.verify, { ...(risk ? { risk } : {}), lastWasSecurity: !!last.security })
    if (!step) continue
    acted = true
    if (finished === 'review' && step.kind !== 'verify' && !tutorial) await archiveReview($, options, c, !!last.security, s.at)
    // 這次審查看的是派審查時的 HEAD；之後有新 commit，結論就不算數。
    if (finished === 'review') await saveChain($, key, r => r ? { ...r, judgedHead: (last.security ? r.securityHead : r.reviewHead) ?? c.git?.head ?? r.judgedHead } : r)
    const markHandled = async () => { const all = await loadJobs($); if (all[key]?.last) await $.store.set(JOBS_KEY, { ...all, [key]: { ...all[key], last: { ...all[key]!.last!, handled: true } } }) }
    if (step.kind === 'verify') { void runVerify($, c, true); continue }
    await markHandled()
    if (step.kind === 'stop') {
      await saveChain($, key, r => r ? { ...r, stopped: step.reason } : r)
      await feedPush($, [{ at: s.at, text: `${c.name} 自動接力已暫停：${step.reason}`, tone: 'error' }])
      $.ui.toast(`${c.name}：自動接力已暫停，${step.reason}`, { timeoutMs: 10_000 })
      notify($, `${c.name}：自動接力已暫停，${step.reason}`)
    } else if (step.kind === 'pass') {
      const judged = step.skipped ? fresh?.head ?? c.git?.head : undefined
      await saveChain($, key, r => r ? { ...r, passed: true, ...(step.needsHuman ? { needsHuman: step.needsHuman } : {}), ...(step.skipped ? { skippedReview: true } : {}), ...(judged ? { judgedHead: judged } : {}) } : r)
      const text = step.needsHuman ? `${c.name} ${step.needsHuman}` : step.skipped ? `${c.name} 只動文件、檢查通過，免審查，可開 PR` : `${c.name} 審查通過，可開 PR`
      await feedPush($, [{ at: s.at, text, tone: step.needsHuman ? 'warning' : 'success' }])
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
 * 審查通過後分支又有新 commit（你決定要改、或在面板外改了）：開新的一輪接力（不算修正輪數），
 * 排一次「做完了」讓接力照常走：完成檢查 → 審查只看上次審查之後的 diff。
 */
async function recheck($: any, key: string, run: ChainRun, last: JobRecord | undefined, owner: string, now: number) {
  await saveChain($, key, () => ({ owner, startedAt: now, round: 0, recheck: true, ...(run.reviewHead ? { reviewHead: run.reviewHead } : {}), ...(run.judgedHead ? { judgedHead: run.judgedHead } : {}) }))
  const all = await loadJobs($)
  const record: JobRecord = { launchName: last?.launchName ?? 'recheck', nativeId: last?.nativeId ?? 'recheck', sessionId: last?.sessionId ?? '', kind: 'continue', startedAt: now, fresh: false, answered: true, owner, recheck: true }
  await $.store.set(JOBS_KEY, { ...all, [key]: { ...all[key], last: record } })
}

let soonTimer: Timer
/** 接力動作後兩秒再看一次，讓剛派出去的工作或剛跑完的檢查盡快反映。 */
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

function caseNamed(s: Snapshot | null, name: string): Case | null {
  if (!s) return null
  const q = name.trim()
  // 示範案子只能看，指令找不到它們。
  const real = s.cases.filter(c => !c.demo)
  return real.find(c => c.name === q) ?? real.find(c => c.name.includes(q)) ?? null
}

/** 完成檢查：第一次跑某條指令先問；之後同一條直接跑。結果記在 $.store，重開也在。 */
/** 排隊等著跑的檢查（同一時間只跑一個：測試共用主工作區的容器與資料庫，同時跑會互相干擾）。 */
const checkQueue: { statusPath: string; auto: boolean }[] = []

async function runVerify($: any, c: Case, auto = false, fromQueue = false) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  if (!c.verify) { $.ui.toast(`${c.name}：卡片尚缺完成檢查`); return }
  const running = await read($, verifyingAtom)
  if (c.statusPath in running) { if (!auto) $.ui.toast(`${c.name}：檢查仍在執行`); return }
  if (!fromQueue && checkQueue.some(q => q.statusPath === c.statusPath)) { if (!auto) $.ui.toast(`${c.name}：已在排隊`); return }
  const trusted = ((await $.store.get(TRUST_KEY).catch(() => null)) as Record<string, string> | null) ?? {}
  if (trusted[c.statusPath] !== c.verify) {
    if (auto) return
    const answer = await $.ui.ask(`在 ${c.root} 執行完成檢查：\n${c.verify}\n之後同一條指令不再問，自動接力也會用它。`, { header: `${c.name} 檢查`, options: ['執行', '取消'] }).catch(() => '')
    if (answer !== '執行') return
    await $.store.set(TRUST_KEY, { ...trusted, [c.statusPath]: c.verify })
  }
  // 已經有別的檢查在跑：排隊，跑完一個再接下一個。
  if (Object.keys(running).length > 0) {
    if (!checkQueue.some(q => q.statusPath === c.statusPath)) checkQueue.push({ statusPath: c.statusPath, auto })
    await update($, queueAtom, () => checkQueue.map(q => q.statusPath))
    if (!auto) $.ui.toast(`${c.name}：已排隊，前面還有 ${checkQueue.length} 件`)
    return
  }
  // 檢查要用的容器沒在跑：不執行，也不記成「未通過」，直接說要先啟動哪個。
  const box = await containers($, optionsRef!)
  const missing = missingServices(c.verify, box, (await loadSettings($, optionsRef!)).checkServices)
  if (missing.length) {
    const reason = `容器 ${missing.join('、')} 未啟動，請先在主工作區執行 docker compose up -d ${missing.join(' ')}`
    $.ui.toast(`${c.name}：${reason}`, { timeoutMs: 10_000 })
    await feedPush($, [{ at: await $.clock.now(), text: `${c.name} 檢查未執行：${reason}`, tone: 'warning' }])
    if (auto) await saveChain($, normalizeRoot(c.root), r => r ? { ...r, stopped: reason } : r)
    await update($, snapshot, s => s ? { ...s, containers: box } : s)
    void nextInQueue($)
    return
  }
  const startedAt = await $.clock.now()
  await update($, verifyingAtom, v => ({ ...v, [c.statusPath]: startedAt }))
  await spin($, true)
  const head = (await gitProbe($, c.root)).git?.head
  let result: Verify
  try {
    const r = await $.process.run(['sh', '-c', c.verify], { cwd: c.root, timeoutMs: VERIFY_TIMEOUT_MS })
    const lines = `${r.stdout}\n${r.stderr}`.split(/[\r\n]+/).map((l: string) => plain(l).trimEnd()).filter(Boolean)
    result = { command: c.verify, at: await $.clock.now(), ok: r.exitCode === 0, exitCode: r.exitCode, tail: lines.slice(-4), truncated: !!r.isStdoutTruncated, ...(head ? { head } : {}) }
  } catch (error) {
    result = { command: c.verify, at: await $.clock.now(), ok: false, exitCode: -1, tail: [plain(error instanceof Error ? error.message : String(error))], truncated: false, ...(head ? { head } : {}) }
  }
  await update($, verifyingAtom, v => Object.fromEntries(Object.entries(v).filter(([k]) => k !== c.statusPath)))
  const all = await update($, verifiesAtom, v => ({ ...v, [c.statusPath]: result }))
  await $.store.set(VERIFIES_KEY, all).catch(() => {})
  await feedPush($, [{ at: result.at, text: `${c.name} ${result.ok ? '檢查通過' : `檢查未通過（exit ${result.exitCode}）`}`, tone: result.ok ? 'success' : 'error' }])
  $.ui.toast(`${c.name}：${result.ok ? '檢查通過' : '檢查未通過'}`, { timeoutMs: 6000 })
  await update($, snapshot, s => s ? { ...s, cases: s.cases.map(x => { if (x.statusPath !== c.statusPath) return x; const y = { ...x, state: stateOf(x, result) }; const z = { ...y, pipeline: pipeline(y, result) }; return { ...z, state: finalState(z) } }) } : s)
  await spin($, false)
  if (auto) refreshSoon($, optionsRef!)
  void nextInQueue($)
}

/** 接著跑排隊中的下一件；用快照裡最新的卡片內容。 */
async function nextInQueue($: any) {
  if (Object.keys(await read($, verifyingAtom)).length > 0) return
  const next = checkQueue.shift()
  await update($, queueAtom, () => checkQueue.map(q => q.statusPath))
  if (!next) return
  const c = (await read($, snapshot))?.cases.find(x => x.statusPath === next.statusPath)
  if (c) await runVerify($, c, next.auto, true)
  else void nextInQueue($)
}
export let optionsRef: PluginOptions | undefined

/**
 * 派工：`claude --bg --name <唯一名> [--resume <案子的 session>] [--model] [--effort] <提示>` 在案子根目錄啟動，
 * 從啟動後的 agents 清單用名字對回完整 session id 才算成功；審查與（設了同步模型的）同步開新 session，不改案子的 session。
 */
async function dispatch($: any, options: PluginOptions, c: Case, kind: DispatchKind, opts: { text?: string; fix?: FixReason; auto?: boolean; security?: boolean } = {}) {
  const text = opts.text ?? ''
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  if (!opts.auto && !dispatchable(c).includes(kind)) { $.ui.toast(`${c.name}：目前無法${KIND_LABEL[kind]}（${c.manual ? '登錄表設為 manual，只追蹤不派工' : c.state === 'running' ? 'Agent 仍在執行' : !c.verify ? '卡片尚缺完成檢查，規格未通過' : '卡片狀態不符'}）`); return }
  if (c.statusPath in (await read($, launchingAtom))) { $.ui.toast(`${c.name}：上一次派工仍在啟動`); return }
  const settings = await loadSettings($, options)
  const { model, effort, fresh } = modelFor(settings, c.root, kind)
  const jobs = await loadJobs($)
  const rootKey = normalizeRoot(c.root)
  const own: RootJobs = jobs[rootKey] ?? {}
  const sessionId = fresh ? undefined : kind === 'reply' && own.last?.sessionId ? own.last.sessionId : own.sessionId
  const now = await $.clock.now()
  const name = launchName(now, launchSeq++)
  let review: ReviewOpts | undefined
  const head = kind === 'review' ? (await gitProbe($, c.root)).git?.head : undefined
  if (kind === 'review') {
    const run = (await loadChains($))[rootKey]
    const round = opts.auto ? run?.round ?? 0 : 0
    const base = opts.security ? run?.securityHead : run?.reviewHead
    const paths = await deskPaths($, options)
    const pitfalls = paths.pitfalls
    const template = settings.review.template || `${$.plugin.root}/templates/review.md`
    const recheck = !!opts.auto && !!run?.recheck && !opts.security
    const target = tutorial ? undefined : (await diffBase($, c, settings.cardBase))?.target
    review = { round, template, ...(target ? { target } : {}), ...((round > 0 || recheck) && base ? { base } : {}), ...(recheck ? { recheck: true } : {}), ...(opts.security ? { security: true } : {}), pitfalls: (await $.fs.exists(pitfalls).catch(() => false)) ? pitfalls : '', history: paths.reviews }
  }
  const prompt = buildPrompt(c, kind, text, opts.fix, review, settings)
  await update($, launchingAtom, v => ({ ...v, [c.statusPath]: now }))
  await spin($, true)
  try {
    const confirmed = tutorial ? startSim($, options, c, kind, name, now, opts) : await launch($, c, prompt, { model, effort, sessionId, name })
    const record: JobRecord = { launchName: name, nativeId: String(confirmed.id ?? name), sessionId: confirmed.sessionId!, kind, startedAt: now, fresh, owner: await me($), ...(opts.fix ? { round: opts.fix.round } : {}), ...(opts.security ? { security: true } : {}) }
    // 手動按繼續或審查就開一輪新的接力；自動派的接續原本那輪。
    if (!opts.auto && (kind === 'continue' || kind === 'review')) await saveChain($, rootKey, r => ({ owner: record.owner!, startedAt: now, round: 0, ...(r?.judgedHead ? { judgedHead: r.judgedHead } : {}) }))
    if (kind === 'review' && head) await saveChain($, rootKey, r => r ? { ...r, ...(opts.security ? { securityHead: head } : { reviewHead: head }) } : r)
    const next: RootJobs = { ...(fresh ? { sessionId: own.sessionId } : { sessionId: confirmed.sessionId! }), last: record }
    await $.store.set(JOBS_KEY, { ...jobs, [rootKey]: next })
    const agent: AgentInfo = { ...agentInfo(confirmed), status: 'busy' }
    await update($, snapshot, s => s ? { ...s, cases: s.cases.map(x => x.statusPath === c.statusPath ? { ...x, agent, state: 'running' as const } : x) } : s)
    const label = opts.fix ? `修正第 ${opts.fix.round} 輪` : opts.security ? '資安審查' : KIND_LABEL[kind]
    await feedPush($, [{ at: now, text: `${c.name} ${opts.auto ? '自動' : ''}派${label}（${model || '預設模型'}${fresh ? '・新對話' : ''}）`, tone: 'suggestion' }])
    $.ui.toast(`${c.name}：${label}已派出`, { timeoutMs: 6000 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await feedPush($, [{ at: now, text: `${c.name} ${KIND_LABEL[kind]}失敗：${message}`, tone: 'error' }])
    $.ui.toast(`${c.name}：${KIND_LABEL[kind]}失敗，${message}`, { timeoutMs: 8000 })
  } finally {
    await update($, launchingAtom, v => Object.fromEntries(Object.entries(v).filter(([k]) => k !== c.statusPath)))
    await spin($, false)
  }
}

/** 回覆停下來問的 Agent：先問要回什麼（可打自己的字），再 resume 那個 session。 */
async function reply($: any, options: PluginOptions, c: Case, text?: string) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  let answer = text?.trim() ?? ''
  if (!answer) {
    const picked = await $.ui.ask(`Agent 提問：${c.agent?.last || '（無法讀取問題，請開啟卡片或用 claude logs 查看）'}\n要回覆什麼？請選「照卡片的下一步繼續」，或在「其他」輸入回覆。`, { header: `${c.name} 回覆`, options: ['照卡片的下一步繼續', '取消'] }).catch(() => '')
    if (!picked || picked === '取消') return
    answer = picked === '照卡片的下一步繼續' ? `照卡片的下一步繼續：${c.next || '依卡片'}` : picked
  }
  const jobs = await loadJobs($)
  const key = normalizeRoot(c.root)
  if (jobs[key]?.last) await $.store.set(JOBS_KEY, { ...jobs, [key]: { ...jobs[key], last: { ...jobs[key]!.last!, answered: true } } })
  await dispatch($, options, { ...c, state: 'ready' }, 'reply', { text: answer })
}

async function fillDecision($: any, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  const decisions = parseDecisions(c.ask)
  const picks = (await read($, picksAtom))[picksKey(c)] ?? {}
  if (!allPicked(decisions, picks)) { $.ui.toast(`${c.name}：請先完成每個決策的選擇（點選項或按數字鍵）`); return }
  const answer = decisionAnswer(decisions, picks)
  if (tutorial) { await tutorialDecision($, c, answer); return }
  const filled = await $.prompt.fill({ text: `「${c.name}」決策：${answer}`, mode: 'replace' }).catch(() => ({ isFilled: false }))
  if (!filled.isFilled) { $.ui.toast(`${c.name}：輸入框無法預填，請直接輸入「${c.name}」決策：${answer}`); return }
  await update($, selected, () => c.statusPath)
  $.ui.toast(`${c.name}：決策已填入，按 Esc 回到輸入框再按 Enter 送出；此案子的卡片會一併附上`, { timeoutMs: 6000 })
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
  const next = typeof text === 'string' ? confirmShip(text, `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, `${two(d.getHours())}:${two(d.getMinutes())}`, c.tag ?? '', isReleaseLine(c) ? '等下一版開發' : `${ARCHIVE_WORD}：${CARD_CMD} archive ${c.root.split('/').filter(Boolean).pop() ?? ''}`, (await loadSettings($, optionsRef!)).user) : null
  if (!next) { $.ui.toast(`${c.name}：卡片關卡已不是 release，沒有改動`); void refresh($, optionsRef!); return }
  const ok = await $.fs.write(c.statusPath, next).then(() => true).catch(() => false)
  if (!ok) { $.ui.toast(`${c.name}：寫入卡片失敗`); return }
  await feedPush($, [{ at: await $.clock.now(), text: `${c.name} 已確認上線${c.tag ? `（${c.tag}）` : ''}`, tone: 'success' }])
  $.ui.toast(`${c.name}：已確認上線，release 關卡已清除`)
  void refresh($, optionsRef!)
}

/** 停止 desk 自己派出去、正在跑的那個背景 agent（名字要對得上這件案子最後一次派工），接力一併暫停。 */
async function stopAgent($: any, c: Case) {
  const last = (await loadJobs($))[normalizeRoot(c.root)]?.last
  if (!c.agent?.id || !last || c.agent.name !== last.launchName) { $.ui.toast(`${c.name}：只能停止 desk 派出去的 Agent`); return }
  if (tutorial) cancelSim()
  const r = tutorial ? { exitCode: 0, stderr: '' } : await $.process.run(['claude', 'stop', c.agent.id], { timeoutMs: 30_000 }).catch(() => null)
  if (!r || r.exitCode !== 0) { $.ui.toast(`${c.name}：無法停止（${String(r?.stderr ?? '').trim().split(/\r?\n/).pop() || 'claude stop 失敗'}）`); return }
  await saveChain($, normalizeRoot(c.root), run => run ? { ...run, stopped: '你手動停止了 Agent' } : run)
  await feedPush($, [{ at: await $.clock.now(), text: `${c.name} 已停止 Agent（對話保留，可再派工接續）`, tone: 'warning' }])
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
    checkQueue.length = 0
    await update($, queueAtom, () => [])
    await $.command.register({ name: 'desk', description: '工作桌：/desk 開啟面板並取得焦點（面板裡 Esc 收起）；close 收起；refresh 重新整理；go|sync|review|reply <案名> [回覆] 派工；verify|open <案名> 執行檢查／開啟卡片；bar 摘要列；update 把 desk 更新到 GitHub 最新版本；tutorial [end] 教學（含示範案子）；off 關閉', argumentHint: '[close|refresh|go|sync|review|reply|verify|open <案名>|bar|update|tutorial [end]|off]' })
    if (e.isInteractive === false) { await update($, snapshot, () => null); return next(e) }
    const id = await $.session.id().catch(() => null)
    const list = ((await $.store.get(SESSIONS_KEY).catch(() => null)) as string[] | null) ?? []
    const always = String(options.activation ?? 'auto') === 'always'
    if (always || (typeof id === 'string' && list.includes(id))) { await start($, options, false); void refresh($, options) }
    else await update($, snapshot, () => null)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'plugin' || !active) return next(e)
    const which = await read($, selected).catch(() => null)
    const s = await read($, snapshot).catch(() => null)
    const c = which && s ? s.cases.find(x => x.statusPath === which) ?? null : null
    if (!c) return next(e)
    const result = await next({ ...e, context: [...(e.context ?? []), cardContext(c)] })
    if (!result.drop) await update($, selected, v => (v === which ? null : v))
    return result
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

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && active) void refresh($, options)
    return next(e)
  })

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
      const c = caseNamed(s, m[2]!)
      if (!c) return { text: `找不到案子「${m[2]}」。` }
      if (m[1] === 'verify') { void runVerify($, c); return { text: `${c.name}：完成檢查已開始。` } }
      if (m[1] === 'open') { await openCard($, c); return { text: `${c.name}：已開啟 ${c.statusPath}` } }
      if (m[1] === 'reply') { void reply($, options, c, m[3]); return { text: `${c.name}：回覆派送中。` } }
      const kind = KIND_ARG[m[1]!]!
      void dispatch($, options, c, kind)
      return { text: `${c.name}：${KIND_LABEL[kind]}派送中。` }
    }
    if (arg === 'close') { await update($, isPaneOpen, () => false); await $.ui.close({ id: PANE }).catch(() => {}); return { text: '工作桌已收起。' } }
    if (arg) return { text: '可用：/desk、close、refresh、go|sync|review <案名>、reply <案名> [回覆]、verify|open <案名>、bar、update、tutorial [end]、off' }
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
    const ctxOf = (c: Case) => ({ verifying: c.statusPath in verifying, queued: queue.includes(c.statusPath), launching: c.statusPath in launching, tutorial: !!s.tutorial })
    const mine = renderBand(ui, layoutBand(s, columns, await read($, isPaneOpen), ctxOf), columns, () => {})
    const below = await next(e).catch(() => null)
    const { Box } = ui as any
    return isEmpty(below) ? mine : <Box flexDirection="column">{mine}{below}</Box>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e) as any
    const { Text } = ui
    const s = await read($, snapshot)
    if (!s) return <Text color="subtle">{active ? '讀取案子中…' : '此對話未開啟工作桌；輸入 /desk refresh 開啟。'}</Text>
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
      tutorial: c => void tutorialAct($, options, c),
      logs: c => void toggleLogs($, c),
      openReview: c => void openPath($, `${c.root}/${REVIEW_FILE}`, '審查檔'),
      openPr: c => void (c.pr?.url ? openPath($, c.pr.url, ' PR') : undefined),
      next: () => void (async () => {
        const cur = await read($, snapshot)
        if (!cur) return
        // 示範案子只是背景：n 不會跳到它們。
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

// desk：工作桌。讀登錄表與每件任務的 DESK 卡，摘要列一行、/desk 面板一張；決策按鍵填入、完成檢查一鍵、開啟卡片，
// 以及派工：繼續／同步／審查／回覆都是 `claude --bg` 在任務根目錄開一個背景 agent，session 對應記在 $.store。
// 不寫卡、不碰正式環境。教學模式的執行在 tutorial-run.tsx，自動流程在 auto-chain.ts，派工執行時間紀錄在 run-notes.ts，不依賴模組狀態的 I/O 小工具在 desk-io.ts。
import { atom, read, update } from 'claude-code'
import type { Register, PluginOptions } from 'claude-code'
import type { AgentInfo, Case, FeedEvent, SettingsChecked, Snapshot, Verify } from '../types'
import { CARD_CMD, parseRegistry } from './card'
import { buildCase, caseNamed, demoCases, events, feedOnDesk, stateOf, settleMergedAsk } from './model'
import { plain, errorText, parseOsc7501 } from './text'
import { agentLog, beaconProbe, clearProbeCaches, commitTime, conflictProbe, containers, deskPaths, diffBase, gitProbe, gitStatus, home, lastLineOf, loadSettings, logTail, logTailOf, mergedProbe, models, prProbe, riskOf, settingsReport, versions, verifyResult } from './probes'
import { deploySteps, historyEntries, parseReminders, preflightLine, reviewTop } from './extras'
import { layoutBand, renderBand } from './band'
import { renderPane, picksKey, moreKeyOf } from './pane'
import type { PaneActions, PaneView } from './pane'
import { KIND_LABEL, REVIEW_FILE, SECURITY_FILE, buildPrompt, liveHolds, dispatchRefusal, refusalOf, refusalText } from './dispatch'
import { runOf } from './run-time'
import { launchName, runningDeskAgents, agentsByRoot, applyOscToAgent, endedAlive, endedHow, rawAgents, supersede, asksFor, agentInfo, askClearedOnCard } from './agents'
import { modelFor, normalizeRoot, pitfallsFor, settingsNotices } from './settings'
import { REGISTRY_FORMAT, newerFormatNotices, registryFormat } from './formats'
import type { FormatsSeen, NewerFormat } from './formats'
import type { DispatchKind, QueueOpts, ReviewOpts, UntrustedHold } from './dispatch'
import type { RawAgent } from './agents'
import type { RunShown } from './run-time'
import { awaitsSpecOk, blocking, canArchive, finalState, isReleaseLine, movedSince, parseVerdict, pipeline, runningKind } from './pipeline'
import { MEDIUM_FIX_NOT_SENT, reviewedOn, seenHeads, shownStopped, skipsReview } from './chain'
import { isApproved, trustCheck, trustedChecks, trustWrites, unapprovedText } from './approve-check'
import { missingServices } from './containers'
import { compactStatus, textKey } from './digest-status'
import { TUTORIAL_RELEASE, tutorialPaths } from './tutorial'
import type { TutorialState } from './tutorial'
import { tutorial, TUTORIAL_KEY, setTutorial, cancelSim, simAgents, startSim, resumeTutorial, tutorialAct, tutorialStart, tutorialEnd } from './tutorial-run'
export { tutorial } from './tutorial-run'
import { checkQueue, checking, isQueued, runVerify, resetCheckingState } from './verify-runner'
export { checkQueue, verifyPending, runVerify } from './verify-runner'
import { slots, launchKinds, launchingCount, launchedSince, busyNow, busyRefused, confirmedIdle, startedSince, dispatch, resetDispatchState } from './dispatch-runner'
export { dispatch, launchingCount, busyRefused, confirmedIdle } from './dispatch-runner'
import { SESSIONS_KEY, SPIN_MS, VERIFIES_KEY, confirmed, feedPush, launch, loadChains, loadJobs, loadSummaries, me, missingRegistry, confirmThen, openPath, refreshMs, registryError, runGraceMs, statusLine, summarizeStatuses, tellPanel, toggleLogs } from './desk-io'
import { isEmpty } from './layout'
import type { Timer } from './desk-io'
import { noticeOf, versionStateOf } from './update'
import { autoUpdateCheck, isUpdating, loadUpdateCheck, markLoaded, runUpdate } from './update-run'
import { noteReleased, noteReleasedNow } from './release-update'
import { checkEngineVersion } from './engine-version'
import { isBusy, sentState } from './turn'
import { WORD, DEMO_ONLY } from './theme'
import { cancelPromptSync, readSent, registerPromptSync, resetPromptSync } from './prompt-sync'
import { lastLaunches, noteCardAsks, stopEnded, stopSuperseded } from './stale-agents'
import { cancelQueued, clearAgentQueue, drainAgentQueue, enqueueDispatch, hasAgentQueue, notSent, queuePosition, readAgentQueue, requeue } from './agent-queue'
import { archiveCase, confirmShipped, confirmSpec, createRegistry, fillDecision, fillRelease, publishPr, publishPush, openCard, reply, resumeQuotaHeld, stopAgent } from './card-actions'
import { autoChain } from './auto-chain'
import { withStackWait } from './stack'
import { branchesOf, noteRuns } from './run-notes'

const PANE = 'desk'
/** 自動派解衝突卻沒派出（不是排進隊伍）時流程停下的原因；失敗原因在動態「無法派解衝突（…）」那筆。 */
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
/** 派工因為 repo 還沒信任而開不了的那幾件；寫入在 dispatch-runner（引擎規定 read 的 atom 要同檔宣告）。 */
const untrustedAtom = atom({ plugin: 'desk', key: 'untrusted' } as const, {} as Record<string, UntrustedHold>)
const queueAtom = atom({ plugin: 'desk', key: 'checkQueue' } as const, [])
const armedAtom = atom({ plugin: 'desk', key: 'armed' } as const, null)
const logsOpenAtom = atom({ plugin: 'desk', key: 'logsOpen' } as const, null)
const logViewAtom = atom({ plugin: 'desk', key: 'logView' } as const, {})
const helpAtom = atom({ plugin: 'desk', key: 'isHelp' } as const, false)
/** 「更多動作」（m）展開當下現在卡的卡片路徑（沒有現在卡是空字串）；收合是 null。現在卡換人就不算展開。 */
const showAllAtom = atom({ plugin: 'desk', key: 'showAllActions' } as const, null)
/** 核准過的完成檢查（卡片路徑 → 指令全文）：每輪重新整理讀一次 store 放進來，面板重繪讀這裡；這個對話核准時 approve-check 也會更新。 */
const trustedAtom = atom({ plugin: 'desk', key: 'trusted' } as const, {} as Record<string, string>)
/** 設定檔驗證上次檢查過的 dispatch.json（路徑 → 內容與問題）：跟動態放在同一處，動態裡的舊錯誤在，這份紀錄也在。 */
const settingsCheckedAtom = atom({ plugin: 'desk', key: 'settingsChecked' } as const, {} as SettingsChecked)
/** 已報過的較新格式（卡片、登錄表 → 版號）：跟動態一起在教學開始／結束與 /desk off 清掉，同一份檔同一個版號只報一次。 */
const formatsSeenAtom = atom({ plugin: 'desk', key: 'formatsSeen' } as const, {} as FormatsSeen)
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
/**
 * 根目錄 → 這個對話已經為它強制重查過 PR 的推送派工（啟動名）。PR 快取是每個對話各一份，
 * 派工紀錄的 ended 卻是所有對話共用的：別的對話先記下結束，這個對話照樣要為那次推送重查一次。
 */
const publishRequeried = new Map<string, string>()
/** 登錄表與每張卡片的路徑（上一輪讀到的）：對話改到它們就馬上重讀。 */
let knownPaths: string[] = []
/** 上一輪重新整理讀到的背景 agent 清單；派工時剛讀過就沿用，即時問不到 claude agents 也用它算名額。 */
export let lastAgents: readonly RawAgent[] | null = null
/** lastAgents 是什麼時候送出去問的（不是回來的時間：等回來的期間派出的 Agent 不在清單裡）；從沒讀到是 -Infinity。 */
export let lastAgentsAt = -Infinity
/** 閒置時（見 isIdle）計時器每觸發這麼多次才整輪重新整理一次。 */
export const IDLE_EVERY = 4
/** 連續閒置、跳過重新整理的觸發次數；不閒置或跑了一輪就歸零。 */
let idleSkips = 0
export let optionsRef: PluginOptions | undefined
/** 卡片解析結果：卡片內容與修改時間都沒變才沿用（歷程的未來時間看修改時間判斷）。 */
const cardParseCache = new Map<string, { raw: string; mtime: number | null; steps: string[]; history: any[] }>()
const reviewTextCache = new Map<string, { raw: string; top: any[]; preflight: string | undefined }>()

/**
 * 設定檔的新動態（不屬於任何一件）：同一份內容只報一次；之前報過的改正、刪掉或不再屬於目前專案時報一筆，問題列跟著收掉。
 * 只報告，派工與流程照舊用解析出的設定。
 */
async function settingsNews($: any, options: PluginOptions, at: number): Promise<FeedEvent[]> {
  const reports = await settingsReport($, options).catch(() => null)
  if (!reports) return []
  const { checked, events } = settingsNotices(reports, await read($, settingsCheckedAtom), at)
  await update($, settingsCheckedAtom, () => checked)
  return events
}

/**
 * 較新格式的新動態：登錄表標記、卡片標記比這版認得的新時各警告一次（同一份檔同一個版號只報一次）；
 * 卡片照常顯示、不派工（Case.newerFormat），登錄表照常讀。
 */
async function formatNews($: any, registryPath: string | null, registryText: string | null, cases: readonly Case[], at: number): Promise<FeedEvent[]> {
  const registry = registryPath && registryText !== null ? registryFormat(registryText) : REGISTRY_FORMAT
  const found: NewerFormat[] = [
    ...(registryPath && registry > REGISTRY_FORMAT ? [{ kind: 'registry' as const, path: registryPath, format: registry }] : []),
    ...cases.flatMap(c => c.newerFormat ? [{ kind: 'card' as const, path: c.statusPath, name: c.name, format: c.newerFormat }] : []),
  ]
  const { seen, events } = newerFormatNotices(found, await read($, formatsSeenAtom), at)
  await update($, formatsSeenAtom, () => seen)
  return events
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
    const agentsAskedAt = await $.clock.now()
    const agentsOut = tutorial ? null : await $.process.run(['claude', 'agents', '--json', '--all'], { timeoutMs: 60_000 }).catch(() => null)
    const jobs = await loadJobs($)
    // 被後來派工取代、還停在提問的工作桌 Agent 不代表任務：拿掉它們再挑（狀態照卡片走），之後停掉。
    const { list, superseded } = supersede(agentsOut && agentsOut.exitCode === 0 ? rawAgents(agentsOut.stdout) : [], lastLaunches(jobs))
    const agents: Record<string, AgentInfo> = tutorial ? simAgents() : agentsOut && agentsOut.exitCode === 0 ? agentsByRoot(list) : {}
    if (!tutorial && agentsOut && agentsOut.exitCode === 0) { lastAgents = list; lastAgentsAt = agentsAskedAt }
    const [verifies, chains, summaries, launching, verifying, settings, self] = await Promise.all([
      read($, verifiesAtom), loadChains($), loadSummaries($), read($, launchingAtom), read($, verifyingAtom),
      tutorial ? null : loadSettings($, options), me($),
    ])
    const cardBase = settings?.cardBase ?? ''
    /** Agent id → 這一輪讀到的 `claude logs` 整份輸出：最後一句與打開的 log 檢視共用，同一個 Agent 只讀一次。 */
    const logs = new Map<string, string | null>()
    const built: Case[] = await Promise.all(rows.map(async row => {
      const [card, stat] = await Promise.all([
        $.fs.read(row.statusPath).catch(() => null) as Promise<string | null>,
        $.fs.stat(row.statusPath).catch(() => null) as Promise<{ mtimeMs?: number } | null>,
      ])
      const cardMtime = typeof stat?.mtimeMs === 'number' ? stat.mtimeMs : null
      const base = buildCase(row, card, cardMtime, agents, verifies[row.statusPath], now)
      const last = jobs[normalizeRoot(base.root)]?.last
      // 最後一次派工停在提問、題目寫進卡片「等你」後已在對話處理（清成「無」）：那個 Agent 不再代表任務，同一輪就照卡片算。
      const cleared = askClearedOnCard(last, base.ask)
      const { agent: found, ...rest } = base
      let agent: AgentInfo | undefined = cleared && found?.name === last?.launchName && found?.waitsFor === 'question' ? undefined : found
      // 清單沒挑到時補上最後一次派工還停在權限提示的那個；提問只剩 status waiting（清單已挑到），做完一輪的 blocked 回 null、不補。
      if (!agent && last && !last.answered && !cleared) agent = asksFor(list, last.launchName) ?? undefined
      if (!agent && row.statusPath in launching) agent = { name: '啟動中', state: 'starting', status: 'busy', ...(launchKinds[row.statusPath] ? { kind: launchKinds[row.statusPath] } : {}) }
      if (agent && agent.id && !tutorial && (agent.status === 'busy' || agent.asks)) {
        const log = await agentLog($, agent.id)
        logs.set(agent.id, log)
        agent = applyOscToAgent(agent, log ? parseOsc7501(log) : null, lastLineOf(log))
      } else if (!agent && !tutorial) {
        const beacon = await beaconProbe($, base.root)
        if (beacon.agent) {
          agent = beacon.agent
          if (agent.id) logs.set(agent.id, beacon.log)
        }
      }
      // 對得上最後一次派工：帶著它在做什麼（審查、同步在跑時六段不退回實作）。
      if (agent && last && agent.name === last.launchName) agent = { ...agent, kind: last.round ? 'fix' : last.kind }
      const probe = await gitProbe($, base.root)
      // 推送（開 PR、push）的 Agent 結束了（記下了，或清單看得出來）、這個對話還沒為它重查過：這一輪強制重查 PR，
      // 不沿用推送前快取的「沒有 PR」或舊的 CI；重查過就記在這個對話，下一輪回到快取。
      const rootKey = normalizeRoot(base.root)
      const publishName = !tutorial && last?.kind === 'publish' ? last.launchName : undefined
      const publishEnded = !!publishName && publishRequeried.get(rootKey) !== publishName && (!!last?.ended || !!endedHow(list, publishName))
      const pr = tutorial ? (tutorial.merged ? { id: 1, state: 'MERGED' as const, ci: 'none' as const, dest: TUTORIAL_RELEASE } : undefined) : probe.git ? await prProbe($, options, base.root, probe.git.branch, now, forcePr || publishEnded) : undefined
      if (publishName && publishEnded && probe.git) publishRequeried.set(rootKey, publishName)
      const run = chains[normalizeRoot(base.root)]
      const stale = movedSince(run?.judgedHead, probe.git)
      // 卡片上有無阻擋的審查結論，但沒有任何 desk 派的審查判過它（沒有流程紀錄，或流程只派過實作）：自審。
      const verdict = parseVerdict(base.gate)
      const selfReview = !tutorial && !!verdict && blocking(verdict) === 0 && !run?.judgedHead && !run?.reviewHead
      // 這個對話的流程還沒處理剛做完的實作：檢查通過後會自動派審查。
      const autoReview = !!run && run.owner === self && !!last && !last.handled && (last.kind === 'continue' || last.kind === 'reply')
      // 流程接手時檢查通過就過關（輪到你的說法）：跟 nextStep 同一個判斷，含風險；只有流程還會接著走（沒過關或過關後有新 commit）時才算。
      const skip = !!run && !tutorial && !!settings && reviewedOn(run, probe.git?.branch) && (!run.passed || stale)
        && skipsReview(run, probe.git?.branch, await riskOf($, { root: base.root, git: probe.git, pr, ...(base.base ? { base: base.base } : {}) }, settings.riskHigh, settings.cardBase))
      const chain = run
        ? { round: run.round, ...(run.rev !== undefined ? { rev: run.rev } : {}), ...(stale ? { stale: true } : {}), ...(run.stopped ? { stopped: shownStopped(run.stopped), ...(run.heldAtCheck ? { heldAtCheck: true } : {}) } : {}), ...(run.owner !== self ? { foreign: true } : {}), ...(run.passed ? { passed: true } : {}), ...(run.mediumFix && !run.passed ? { mediumFix: run.mediumFix } : {}), ...(run.fixTotal ? { fixTotal: run.fixTotal } : {}), ...(run.stopped === MEDIUM_FIX_NOT_SENT && run.mediumFixSecurity ? { mediumSecurity: true } : {}), ...(run.needsHuman ? { needsHuman: run.needsHuman } : {}), ...(run.skippedReview ? { skippedReview: true } : {}), ...(run.passed && run.unreviewed ? { unreviewed: true, ...(run.reviewFix ? { reviewFix: true } : {}) } : {}), ...(skip ? { reviewed: true } : {}), ...(selfReview ? { selfReview: true } : {}), ...(autoReview ? { autoReview: true } : {}), ...(last ? { lastKind: (last.round ? 'fix' : last.kind) as any } : {}), ...(run.catchupHead && run.catchupHead === probe.git?.head ? { catchupTried: true } : {}) }
        : selfReview ? { round: 0, selfReview: true } : undefined
      // 這個對話確認疊放卡規格時記下、原卡合併後要自動派實作：「輪到你」才說得出會自動接著做。
      const stackChain = chain && run?.stackDispatch && run.owner === self ? { ...chain, stackDispatch: true } : chain
      const gitState = probe.git ? await gitStatus($, base.root) : undefined
      // 最後一次 commit 比卡片新：提示按 s 同步。教學的卡片由腳本寫，不提示。
      const commit = probe.git && !tutorial ? await commitTime($, base.root, probe.git.head) : undefined
      let steps: string[] = []
      let history: any[] = []
      if (card !== null) {
        const cached = cardParseCache.get(row.statusPath)
        if (cached && cached.raw === card && cached.mtime === cardMtime) {
          steps = cached.steps
          history = cached.history
        } else {
          steps = deploySteps(card)
          history = historyEntries(card, cardMtime)
          cardParseCache.set(row.statusPath, { raw: card, mtime: cardMtime, steps, history })
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
      // 最後一次派工怎麼結束：還沒記下時看這一輪的清單（記下 ended 排在發動態之後，`claude stop` 停掉的那一輪靠清單才寫得出「已停止」）。
      const lastEnded = last ? last.ended?.how ?? endedHow(list, last.launchName) : null
      const runTime: RunShown = tutorial ? { runMs: 0 } : runOf(jobs[normalizeRoot(base.root)], probe.git?.branch, runGraceMs(options))
      const withAgent = { ...rest, ...(agent ? { agent } : {}), ...(runTime.runMs ? { runMs: runTime.runMs } : {}), ...(runTime.runFrom !== undefined ? { runFrom: runTime.runFrom, runUntil: runTime.runUntil } : {}), ...probe, ...(pr ? { pr } : {}), ...(stackChain ? { chain: stackChain } : {}), ...(gitState ? { gitState } : {}), ...(commit ? { commitAt: commit.at, changedAt: commit.changedAt } : {}), ...(steps.length ? { deploySteps: steps } : {}), ...(history.length ? { history } : {}), ...(top.length ? { reviewTop: top } : {}), ...(preflight ? { preflight } : {}), ...(lastEnded ? { lastEnded } : {}) }
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
    // 疊放卡要看原卡合併了沒：所有 case 都建好才找得到原卡（教學沒有疊放卡）。
    const cases: Case[] = tutorial ? built : withStackWait(built)
    // 檢查關閉時當作沒查過：沒有提示，版本格是「檢查並更新」。
    const [usage, deskVersions, check, model, boxes] = await Promise.all([
      $.session.usage().catch(() => null), versions($, cases),
      settings && settings.updateCheck !== 'off' ? loadUpdateCheck($) : null,
      models($, options, turnModel, cases.map(c => c.root), settings ?? undefined), containers($, options, settings ?? undefined),
    ])
    const limits = (usage?.rateLimits ?? []).map((l: any) => ({ kind: String(l.kind), remaining: 100 - (Number(l.percentUsed) || 0), ...(l.resetsAt ? { resetsAt: String(l.resetsAt) } : {}) }))
    const notice = noticeOf(check, deskVersions.desk)
    const versionState = isUpdating() ? 'updating' as const : versionStateOf(check, deskVersions.desk)
    // 教學模式：示範任務接在後面當「全部任務」的背景（只能看）；版本、轉圈等仍只看真的任務。
    const cur: Snapshot = { at: now, cases: tutorial ? [...cases, ...demoCases(now)] : cases, error, ...(paths?.project ? { project: paths.project.key } : {}), ...(missing ? { missingRegistry: missing } : {}), contextPercent: typeof usage?.context?.percent === 'number' ? Math.round(usage.context.percent) : null, limits, versions: deskVersions, models: model, containers: boxes, reminders: parseReminders(text ?? '', now), ...(notice ? { update: notice } : {}), versionState, ...(tutorial ? { tutorial: true } : {}) }
    if (mine !== generation) return
    // 核准紀錄在寫回前才讀（這輪跑了好幾秒，途中可能按兩次 v 核准過）；讀的期間又核准就不寫，atom 已是最新的。
    const approvals = trustWrites
    const trusted = await trustedChecks($)
    // 選取的任務已不在登錄表（歸檔、換專案）：取消選取，提示不再附它的卡。讀到空的登錄表（正在被改寫）不算。
    if (!error && rows.length) {
      await update($, selected, v => (v && !cur.cases.some(c => c.statusPath === v) ? null : v))
      await update($, feedAtom, list => feedOnDesk(list, cur.cases))
    }
    const prev = await read($, snapshot)
    const fresh = [...events(prev, cur), ...(tutorial ? [] : [...await settingsNews($, options, now), ...await formatNews($, path ?? null, text, cases, now)])]
    await update($, snapshot, () => cur)
    if (approvals === trustWrites) await update($, trustedAtom, () => trusted)
    // 失敗之後這件又有 Agent 開過：「還沒信任」不再成立，三步不再出現。
    await update($, untrustedAtom, v => liveHolds(v, cases) as Record<string, UntrustedHold>)
    await collapseMoreIfMoved($)
    await feedPush($, fresh)
    for (const e of fresh) if (e.tone === 'warning' || e.tone === 'error') { $.ui.toast(e.text, { timeoutMs: 8000 }); notify($, e.text) }
    const openLogs = await read($, logsOpenAtom)
    const logCase = openLogs ? cases.find(c => c.statusPath === openLogs) : undefined
    if (logCase?.agent?.id) {
      const id = logCase.agent.id
      const lines = logs.has(id) ? logTailOf(logs.get(id) ?? null) : await logTail($, id)
      await update($, logViewAtom, v => ({ ...v, [logCase.statusPath]: lines }))
    }
    forcePr = false
    statusLine($, cur)
    await spin($, cases.some(c => c.state === 'running'))
    await stopSuperseded($, cases, superseded, now)
    // 清單是真的（不是教學、claude agents 沒失敗）才看得出誰結束了。
    if (!tutorial && agentsOut && agentsOut.exitCode === 0) {
      // 做完、程序還活著的工作桌 Agent 要停掉：它們的根目錄（含別的專案、已歸檔的）也先記結束，
      // 最後一次派工才先記成做完，停掉後那邊的流程不會當成被人停掉。
      const ended = settings?.stopDone !== false ? endedAlive(list) : []
      await noteRuns($, list, [...cases.filter(c => !c.demo).map(c => c.root), ...ended.map(a => a.root)], now, runGraceMs(options), branchesOf(cases))
      await stopEnded($, cases, ended, now)
      await noteCardAsks($, list, cases, now)
    }
    // 先補派排隊的（同一輪的清單），流程這一輪新派的排在它們後面：先來先派。派出了就用重算過的快照，流程才看得到它在跑。
    const drained = !tutorial && await drainAgentQueue($, options, cur, agentsOut && agentsOut.exitCode === 0 ? list : null, settings ?? undefined)
    await autoChain($, options, drained ? (await read($, snapshot)) ?? cur : cur, settings ?? undefined)
    void summarizeStatuses($, options, cur, summaries)
    if (settings && settings.updateCheck !== 'off' && !tutorial) void autoUpdateCheck($, now)
  })().catch(async (error: unknown) => {
    const message = `工作桌讀取失敗：${error instanceof Error ? error.message : String(error)}`
    // 讀取失敗不代表登錄表不存在：拿掉建立按鈕，錯誤照樣是紅字。
    await update($, snapshot, prev => prev ? { ...prev, error: message, missingRegistry: undefined } : { at: 0, cases: [], error: message, contextPercent: null })
  }).finally(() => { refreshing = null })
  return refreshing
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
    idleSkips = 0
    refreshTimer = $.clock.every(refreshMs(options), () => scheduledRefresh($, options))
  }
  if (remember) {
    const id = await $.session.id().catch(() => null)
    if (typeof id === 'string') {
      const list = ((await $.store.get(SESSIONS_KEY).catch(() => null)) as string[] | null) ?? []
      if (!list.includes(id)) await $.store.set(SESSIONS_KEY, [...list.slice(-19), id])
    }
  }
}

/**
 * 計時器觸發：閒置時（isIdle）只在連續第 IDLE_EVERY 次才整輪重新整理，其他時候每次都跑。
 * 對話改卡、回合結束、按 r、流程動作後的重新整理不走這裡，照舊馬上跑。
 */
async function scheduledRefresh($: any, options: PluginOptions) {
  if (await isIdle($)) {
    idleSkips++
    if (idleSkips < IDLE_EVERY) return
  }
  idleSkips = 0
  return refresh($, options)
}

/**
 * 沒人在看、也沒東西在跑：面板沒畫出或不在最前面（paneShown），
 * 上一份快照沒有 Agent 在跑或停下來問，也沒有檢查在跑或排隊、派工在啟動或排隊。還沒有快照不算閒置。
 * 快照的 agents 清單在這個對話派工啟動前或啟動中（claude --bg 還沒回來）送出的也不算：那一輪可能拿舊清單蓋掉派工時標上的「執行中」，要等下一份清單看到它。
 */
async function isIdle($: any): Promise<boolean> {
  if (await paneShown($)) return false
  if (launchedSince(lastAgentsAt)) return false
  const s = await read($, snapshot)
  if (!s || s.cases.some(c => !c.demo && (c.state === 'running' || !!c.agent?.asks || !!c.agent?.waitsFor))) return false
  if (Object.keys(await read($, verifyingAtom)).length || Object.keys(await read($, launchingAtom)).length) return false
  return !checking && !(await read($, queueAtom)).length && !hasAgentQueue() && launchingCount() === 0
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
  await update($, formatsSeenAtom, () => ({}))
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
  const opened = await $.ui.open({ id: PANE, title: 'desk', focus: true, rows: 18, columns: 72 })
  if (opened && opened.isPlaced === false) $.ui.toast(`工作桌面板尚未顯示（${plain(String(opened.reason ?? ''))}）；輸入 /desk 開啟`)
}

/** 面板看得到：看引擎的實際狀態（畫出且在最前面），不看 isPaneOpen；引擎卸下面板時 ui.close hook 不會執行，那個值會停在 true。 */
async function paneShown($: any): Promise<boolean> {
  const pane = ((await $.ui.panes().catch(() => [])) as { id: string; isPlaced: boolean; isShown: boolean }[]).find(p => p.id === PANE)
  return !!pane?.isPlaced && pane.isShown
}

/** 摘要列按鈕：看得到（paneShown）就收起，不然開啟。 */
async function togglePane($: any) {
  if (await paneShown($)) { await update($, isPaneOpen, () => false); await $.ui.close({ id: PANE }).catch(() => {}) }
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

/**
 * 互動對話開始：Claude Code 比 desk 的最低版本舊（或讀不到版本）就記一筆動態（不帶卡片，不會被換卡清掉）並跳 toast；教學進行中不報。
 * 回傳有沒有報出來；出錯回 false，不擋 desk 啟動（舊引擎上連動態或 toast 都可能不能用）。
 */
async function warnOldEngine($: any): Promise<boolean> {
  try {
    const lesson = (await $.store.get(TUTORIAL_KEY).catch(() => null)) as TutorialState | null
    if (lesson && typeof lesson.dir === 'string') return false
    const notice = await checkEngineVersion($)
    if (!notice) return false
    await feedPush($, [{ at: await $.clock.now(), text: notice.text, tone: 'warning' }])
    $.ui.toast(notice.text, { timeoutMs: 8000 })
    return true
  } catch {
    return false
  }
}

const KIND_ARG: Record<string, DispatchKind> = { go: 'continue', continue: 'continue', sync: 'sync', review: 'review', reply: 'reply' }

/** /desk 指令的任務名對不到：列出可用的任務名（示範任務只能看，不列）；一件都沒有就叫你開卡。 */
function unknownTask(s: Snapshot | null, name: string): string {
  const names = (s?.cases ?? []).filter(c => !c.demo).map(c => c.name)
  return names.length ? `找不到任務「${name}」；可用：${names.join('、')}（任務名或其中一段）` : `目前沒有任務，先用 ${CARD_CMD} new 開卡`
}

export const register: Register = (on, options) => {
  optionsRef = options
  on('session.start', async ($, e, next) => {
    active = false
    clearProbeCaches()
    publishRequeried.clear()
    cardParseCache.clear()
    reviewTextCache.clear()
    setTutorial(null)
    cancelSim()
    refreshTimer?.cancel(); refreshTimer = undefined
    spinTimer?.cancel(); spinTimer = undefined
    // 最先檢查引擎版本：太舊的 Claude Code 後面的 API 可能先壞掉，壞掉前要先講清楚是版本的問題。
    if (e.isInteractive !== false) await warnOldEngine($)
    await update($, verifyingAtom, () => ({}))
    await update($, launchingAtom, () => ({}))
    // 新對話（含 /clear）：重附卡片全文，之前送出的決策不帶著鎖進來。
    await resetPromptSync($)
    resetCheckingState()
    resetDispatchState()
    lastAgents = null
    lastAgentsAt = -Infinity
    await update($, queueAtom, () => [])
    await clearAgentQueue($)
    // 載入計數：更新後 /reload-plugins 被拒時，看新版是不是其實已經載入了。
    await markLoaded($)
    await $.command.register({ name: 'desk', description: '工作桌：/desk 開啟面板並取得焦點（面板裡 Esc 回輸入框）；close 收起；refresh 重新整理；go|sync|review|reply <任務名> [回覆] 派工；verify|open <任務名> 執行測試／開啟卡片；bar 摘要列；update 把 desk 更新到 GitHub 最新版本；tutorial [end] 教學（含示範任務）；off 關閉', argumentHint: '[close|refresh|go|sync|review|reply|verify|open <任務名>|bar|update|tutorial [end]|off]' })
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
      if (!c) return { text: unknownTask(s, m[2]!) }
      // 沒核准的檢查不跑、也不派實作（做完會自動跑它），不彈框：說去面板按兩次。
      if ((m[1] === 'verify' || KIND_ARG[m[1]!] === 'continue') && !isApproved(await trustedChecks($), c)) return { text: unapprovedText(c) }
      if (m[1] === 'verify') {
        // 跟面板的 v 同一個鎖：Agent 在跑就不在它的 worktree 上跑檢查。
        if (await busyNow($, c, true)) return { text: `${c.name}：${WORD.busyRefused}測試` }
        void runVerify($, c)
        return { text: `${c.name}：測試已開始。` }
      }
      if (m[1] === 'open') { await openCard($, c); return { text: `${c.name}：已開啟 ${c.statusPath}` } }
      if (m[1] === 'reply') {
        const refused = refusalOf(c, 'reply')
        if (refused) return { text: refusalText(c.name, '回覆', refused) }
        void reply($, options, c, m[3])
        return { text: `${c.name}：回覆派送中。` }
      }
      const kind = KIND_ARG[m[1]!]!
      const resumed = kind === 'continue' ? await resumeQuotaHeld($, options, c) : null
      if (resumed !== null) return { text: resumed }
      void dispatch($, options, c, kind)
      return { text: `${c.name}：${KIND_LABEL[kind]}派送中。` }
    }
    if (arg === 'close') { await update($, isPaneOpen, () => false); await $.ui.close({ id: PANE }).catch(() => {}); return { text: '工作桌已收起。' } }
    if (arg) return { text: '可用：/desk、close、refresh、go|sync|review <任務名>、reply <任務名> [回覆]、verify|open <任務名>、bar、update、tutorial [end]、off' }
    if (!(await read($, snapshot))) void refresh($, options)
    // 從輸入框打 /desk 時鍵盤一定在輸入框：開著就把焦點移到面板，不關閉。Esc 只把鍵盤交回輸入框、面板留著；收起用 /desk close 或摘要列的「⌗ desk」。
    const wasOpen = await read($, isPaneOpen)
    await openPane($)
    return { text: wasOpen ? '已切到面板（Esc 回輸入框）' : '工作桌已開（Esc 回輸入框；收起用 /desk close）' }
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
    const untrusted = await read($, untrustedAtom)
    const ctxOf = (c: Case) => ({ verifying: c.statusPath in verifying, queued: queue.includes(c.statusPath), launching: c.statusPath in launching, agentQueued: agentQueue.indexOf(c.statusPath) + 1 || undefined, tutorial: !!s.tutorial, sent: sentState(sent, c), ...(untrusted[c.statusPath] ? { hold: untrusted[c.statusPath] } : {}) })
    const mine = renderBand(ui, layoutBand(s, columns, await read($, isPaneOpen), ctxOf, await read($, selected)), columns, () => {})
    const below = await next(e).catch(() => null)
    const { Box } = ui as any
    return isEmpty(below) ? mine : <Box flexDirection="column">{mine}{below}</Box>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e) as any
    const { Text } = ui
    const s = await read($, snapshot)
    if (!s) return <Text color="subtle">{active ? WORD.loading : WORD.off}</Text>
    const base: PaneView = {
      s, now: await $.clock.now(), columns: Math.max(20, e.props.bodyColumns ?? 80), isFocused: !!e.props.isFocused,
      bodyRows: e.props.scroll?.bodyRows, placement: e.props.placement, offset: await read($, contentOffset),
      selected: await read($, selected), feed: await read($, feedAtom), picks: await read($, picksAtom),
      verifies: await read($, verifiesAtom), verifying: await read($, verifyingAtom), tick: await read($, tick), isExpanded: await read($, isExpanded),
      launching: await read($, launchingAtom),
      untrusted: await read($, untrustedAtom),
      queue: await read($, queueAtom),
      agentQueue: await readAgentQueue($),
      armed: await read($, armedAtom),
      trusted: await read($, trustedAtom),
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
        if (isApproved(await trustedChecks($), c)) { if (!(await busyRefused($, c, '測試'))) await runVerify($, c); return }
        // 還沒核准（或指令改過）：按兩次，第一次在檢查列列出全文，第二次核准並執行。
        if (await confirmedIdle($, c, 'verify', '測試') && await trustCheck($, c)) await runVerify($, c)
      })(),
      open: c => void openCard($, c),
      dispatch: (c, kind) => void (async () => {
        if (kind === 'reply') return reply($, options, c)
        if (!(await confirmed($, `${c.statusPath}\n${kind}`))) return
        // 第二次按 g 就核准這張卡的完成檢查（沒核准時第一次已在檢查列列出全文）。
        if (kind === 'continue') await trustCheck($, c)
        // 額度煞車擋在派審查前：g 直接派那次審查，不多派實作。
        if (kind === 'continue' && (await resumeQuotaHeld($, options, c)) !== null) return
        await dispatch($, options, c, kind)
      })(),
      stop: c => void (async () => { if (await confirmed($, `${c.statusPath}\nstop`)) await stopAgent($, c) })(),
      // 還沒派出去，按一次就取消，不用確認。
      unqueue: c => void cancelQueued($, c),
      ship: c => void (async () => { if (await confirmedIdle($, c, 'ship', '確認上線')) await confirmShipped($, c) })(),
      specOk: c => void (async () => { if (!tutorial && awaitsSpecOk(c) && await confirmedIdle($, c, 'spec-ok', '確認規格')) await confirmSpec($, options, c) })(),
      archive: c => void (async () => { if (!tutorial && canArchive(c) && await confirmedIdle($, c, 'archive', '歸檔')) await archiveCase($, options, c) })(),
      // 按兩次 z：第一次只待確認，第二次才填（草稿檢查在 fillRelease 裡，也就是第二次按）。
      release: c => void (tutorial ? undefined : confirmThen($, `${c.statusPath}\nrelease`, () => fillRelease($, c))),
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

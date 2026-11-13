// 自動流程：做完實作 → 跑完成檢查 → 審查 → 修正，以及過關後的解衝突、審查後有新 commit 的重新檢查。
// 從 register.tsx 搬出；$ 只傳給 function 宣告（外掛載入的限制），要 register 的 notify、refreshSoon 照 runner 模組的寫法從 ./register 匯入。
import { atom, read } from 'claude-code'
import type { PluginOptions } from 'claude-code'
import type { Case, Snapshot } from '../types'
import { saysNone } from './card'
import { quotaHold, quotaLow } from './model'
import { archiveReview, loadSettings, prProbe, riskOf, worktreeMark } from './probes'
import { markRefusalStop, specBlocks, specGapStop } from './dispatch'
import type { DispatchKind, FixReason, JobRecord, RootJobs } from './dispatch'
import { askClearedOnCard, askedOnCardAtEnd, codeJobEnded } from './agents'
import { normalizeRoot } from './settings'
import type { DispatchSettings } from './settings'
import { checkStands, isMerged, parseVerdict, passedAtHead } from './pipeline'
import { t } from './i18n'
import { catchupFeed, catchupHold } from './catchup'
import { REVIEW_FIX_NOT_SENT, carriedFix, carriedReview, fixTotalOf, handedOver, judgedAt, nextStep, paused, recheckFeed, skipsReview } from './chain'
import type { ChainRun, ChainStep } from './chain'
import { STOP, causeText, stopText } from './stop-reason'
import { trustedChecks } from './approve-check'
import { tutorial } from './tutorial-run'
import { checking, isQueued, verifyPending, runVerify } from './verify-runner'
import { starting, dispatch, unconfirmed } from './dispatch-runner'
import { JOBS_KEY, feedPush, loadChains, loadJobs, me, saveChain } from './desk-io'
import { isAgentQueued } from './agent-queue'
import { autoPublish, dispatchAfterStack } from './card-actions'
import { autoPrApplies, autoPrPlan, passWords } from './auto-pr'
import type { AutoPrPlan } from './auto-pr'
import { notify, refreshSoon } from './register'

const verifiesAtom = atom({ plugin: 'desk', key: 'verifies' } as const, {})
const verifyingAtom = atom({ plugin: 'desk', key: 'verifying' } as const, {})
const launchingAtom = atom({ plugin: 'desk', key: 'launching' } as const, {})

/**
 * 自動流程（第二到第四段）：只處理這個對話自己派出去、剛結束、還沒處理過的那一次（別的對話開的流程不碰）。
 * 做完實作 → 跑完成檢查 → 綠了派審查 → 有 CRITICAL／HIGH 派修正（MEDIUM 只記錄、不寫進「等你」，開 PR 時列進 PR 說明），
 * 整條分支最多自動修兩輪；停下來就寫進動態並提醒。preloaded：重新整理這一輪已讀好的設定，有就不再讀 dispatch.json。
 */
export async function autoChain($: any, options: PluginOptions, s: Snapshot, preloaded?: DispatchSettings) {
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
    // 寫流程紀錄時整張表一直被別的對話蓋掉、放棄寫入：動態寫一筆（同一件只寫一次）。
    const saveOpts = { warn: { at: s.at, name: c.name, card: c.statusPath } }
    // 疊放卡的原卡還沒合併：不重新檢查、不派審查、修正或解衝突，停在原地（流程不暫停，原卡合併後照常）。
    if (c.stackWait) continue
    // 卡片是較新版 desk 的格式：這版不接著跑檢查、不派任何工作（動態已警告過，更新 desk 後照常）。
    if (c.newerFormat) continue
    // 這個對話確認規格時被原卡擋下、現在不用再等：派一次實作（只試一次，派之前拿掉記號）。
    // 最後一次派工剛結束、還沒處理（同步不在流程裡、不會標處理過）：先讓下面照常處理那次，處理完下次重新整理再派，不然 jobs.last 被這次蓋掉。
    if (run?.stackDispatch && run.owner === mine && !tutorial && (!last || !!last.handled || last.kind === 'sync')) {
      if (await releaseStacked($, options, c, key, mine, s, preloaded)) acted = true
      continue
    }
    // 規格沒有驗收情境、六段停在規格段：跟面板一樣不重新檢查、不派審查或修正，流程停下寫原因（停過就不再寫）。
    // 停下後也要跳過：下面審查通過後有新 commit 的重新檢查不看 stopped。
    if (run && run.owner === mine && specBlocks(c)) {
      if (!run.stopped) {
        const reason = specGapStop(c)
        // 寫入被別的對話蓋掉、放棄（saveChain 已寫過警告）：不說停下；紀錄沒停，下次重新整理會再試。
        if (await saveChain($, key, r => r ? paused(r, reason) : r, saveOpts)) {
          await feedPush($, [{ at: s.at, text: t('autoChain.stopped', { name: c.name, why: stopText(reason) }), tone: 'warning', card: c.statusPath }])
          acted = true
        }
      }
      continue
    }
    // 已經合併：不再自動檢查、審查或修正（之後的 commit 進不了這次合併）。
    const merged = isMerged(c)
    if (!merged && run && await autoCatchup($, options, c, run, mine, s.at, agentBusy, s.limits, preloaded)) { acted = true; continue }
    if (!merged && run?.passed && c.chain?.stale && run.owner === mine && !agentBusy && !c.agent?.asks && !(c.statusPath in verifies) && !isAgentQueued(c.statusPath) && !(c.statusPath in (await read($, launchingAtom)))) {
      const rs = await loadSettings($, options, preloaded)
      const skip = skipsReview(run, c.git?.branch, await riskOf($, c, rs.riskHigh, rs.cardBase))
      await recheck($, key, run, last, mine, s.at, c.git?.branch)
      await feedPush($, [{ at: s.at, text: recheckFeed(c.name, skip), tone: 'suggestion', card: c.statusPath }])
      acted = true
      continue
    }
    // 舊卡：你在「等你」對審查 MEDIUM 題選了修掉、對話清掉了「等你」：派一次修正（不受上限擋）。
    // 流程還在進行、剛結束的派工還沒處理（例如高風險卡在資安審查跑時回答 B）就先讓下面照常處理那次結論（歸檔、有 HIGH 派修正），處理完下次重新整理再派：
    // 不然 jobs.last 被這次修正蓋掉，那次審查結論沒人算。資安審查的修正換了 HEAD，這筆紀錄會在 fixPickedMedium 照規則拿掉。
    // 流程已過關或停下就不等：之後才派的推送／開 PR、同步、解衝突，下面的主判斷不會標成已處理，等它會永遠派不出去。
    const idle = (!last || !!last.handled || !!run?.passed || !!run?.stopped) && !agentBusy && !c.agent?.asks && !(c.statusPath in verifies) && !verifyPending(c.statusPath) && !isAgentQueued(c.statusPath) && !(c.statusPath in (await read($, launchingAtom)))
    if (!merged && run?.mediumFixAt && run.owner === mine && idle && await fixPickedMedium($, options, c, run, jobs[key], s.at)) { acted = true; continue }
    // 實作或回覆做完時把要你決定的事寫進「等你」：等你在對話處理完（清成「無」後自動接著派一次繼續，見下面的 answered）。
    if (!run || !last || last.handled || agentBusy || c.agent?.asks || askedOnCardAtEnd(last, c.ask) || c.statusPath in verifies || checking === c.statusPath || isQueued(c.statusPath) || isAgentQueued(c.statusPath) || c.statusPath in (await read($, launchingAtom))) continue
    // 別的對話開的流程：照舊不碰。
    if (run.owner !== mine) continue
    const markChained = async () => { const all = await loadJobs($); const done = all[key]?.last; if (done && !done.chained) await $.store.set(JOBS_KEY, { ...all, [key]: { ...all[key], last: { ...done, chained: true } } }) }
    const markHandled = async () => { const all = await loadJobs($); if (all[key]?.last) await $.store.set(JOBS_KEY, { ...all, [key]: { ...all[key], last: { ...all[key]!.last!, handled: true } } }) }
    // 流程紀錄寫入被別的對話蓋掉、放棄：那次派工改回未處理，下次重新整理照最新的紀錄再判斷一次（不發暫停、過關的通知，也不派工）。
    const unmarkHandled = async () => { const all = await loadJobs($); const done = all[key]?.last; if (!done?.handled) return; const { handled: _, ...open } = done; await $.store.set(JOBS_KEY, { ...all, [key]: { ...all[key], last: open } }) }
    // 合併前派出、合併後才結束的那次：照樣收尾（審查檔歸檔、標成已處理），但不接著派任何工作。
    if (merged) {
      if (last.kind === 'review' && !tutorial) await archiveReview($, options, c, !!last.security, s.at)
      await markHandled()
      acted = true
      continue
    }
    const verify = (await read($, verifiesAtom))[c.statusPath]
    // 這次派工之後跑的檢查；Agent 沒有新 commit、worktree 沒有未提交改動（卡片與 .task 不算），而且同一個 HEAD、同一條指令上次通過：沿用，不重跑。
    const fresh = verify && (verify.at >= last.startedAt || (!tutorial && passedAtHead(c, verify) && (await worktreeMark($, c.root)).files === 0)) ? verify : undefined
    const finished: DispatchKind | null = last.kind === 'sync' ? null : last.kind
    const settings = finished ? await loadSettings($, options, preloaded) : undefined
    const risk = settings ? await riskOf($, c, settings.riskHigh, settings.cardBase) : undefined
    const stoppedAgent = last.ended?.how === 'stopped'
    // 題目寫進「等你」、已在對話處理：做完一輪才寫的（answered）自動接著派一次繼續；Agent 還停在提問的照 handedOver 不派。
    const handed = askClearedOnCard(last, c.ask)
    const answered = handed && codeJobEnded(last)
    // 額度煞車：要派下一個 Agent 前看 5 小時額度。還停在提問、題目已在對話處理的那次本來就不派，不看。
    const hold = settings && !tutorial && (!handed || answered) ? quotaHold(s.limits, settings.chainQuotaStop, s.at) : null
    const planned = nextStep(run, finished, checkStands(c, fresh), parseVerdict(c.gate), trusted[c.statusPath] === c.verify && !!c.verify, { ...(risk ? { risk } : {}), lastWasSecurity: !!last.security, changed: c.statusPath in trusted, stopped: stoppedAgent, ...(hold ? { quotaHold: hold } : {}), ...(c.git?.branch ? { branch: c.git.branch } : {}), ...(settings?.review.combineSecurity ? { combineSecurity: true } : {}), ...(answered ? { answered: true } : {}) })
    if (!planned) continue
    // 寫入放棄（被別的對話蓋掉）不算有動作：不提早重新整理，等下一次重新整理再試，免得每兩秒重套一次。
    const actedBefore = acted
    acted = true
    // 這次審查看的是派審查時的 HEAD；之後有新 commit，結論就不算數。寫入放棄就先不處理這次（不歸檔、不標處理過），下次重新整理再試。
    // 程式碼審查有結論（不是高風險）：記下這條分支審查過，之後的修正與新 commit 只跑測試、不複審；教學也一樣（審查存底照舊不寫）。
    // MEDIUM 只記錄、不問：舊卡審查檔裡標「（等你決定）」的 MEDIUM 也一樣，留在審查檔、開 PR 時列進 PR 說明，不為它複審。
    const markReviewed = finished === 'review' && !last.security && risk?.level !== 'high' && c.git?.branch && reviewSettled(c) ? { reviewedBranch: c.git.branch } : {}
    if (finished === 'review' && !stoppedAgent && !(await saveChain($, key, r => r ? { ...r, ...judgedAt(r, !!last.security, c.git), ...markReviewed } : r, saveOpts))) { acted = actedBefore; continue }
    // 被停掉的審查沒寫完：不歸檔、不算判過。
    if (finished === 'review' && !stoppedAgent && planned.kind !== 'verify' && !tutorial) await archiveReview($, options, c, !!last.security, s.at)
    // 還停在提問、題目已在對話處理的那次：結論照記，不替它跑檢查或派 Agent（也就不會因為被取代而停掉它）。
    const next = handed && !answered ? handedOver(planned) : planned
    if (!next) { await markHandled(); continue }
    // 開跑自動檢查前記下流程已接手：檢查跑到一半或停在檢查段（容器未啟動、測試中斷）時「等你」出現的題目，不再當成那次派工寫的。
    if (next.kind === 'verify') { await markChained(); void runVerify($, c, true); continue }
    await markHandled()
    // 要派下一步之前先看 worktree：有不是上一個 Agent 留下的未提交改動（別的對話在改），停下來說原因，不派。
    const foreign = next.kind === 'dispatch' && !tutorial ? markRefusalStop(await worktreeMark($, c.root), jobs[key]) : null
    const step: ChainStep = foreign ? { kind: 'stop', reason: foreign } : next
    // 舊紀錄的「這輪要修的 MEDIUM」：MEDIUM 不再自動修，往下寫回時拿掉。
    const withoutMedium = (r: ChainRun): ChainRun => { const { mediumFix: _, ...rest } = r; return rest }
    if (step.kind === 'stop') {
      if (!(await saveChain($, key, r => r ? paused(withoutMedium(r), step.reason, step.atCheck, step.resume) : r, saveOpts))) { await unmarkHandled(); acted = actedBefore; continue }
      const why = causeText(step.reason)
      await feedPush($, [{ at: s.at, text: t('autoChain.paused', { name: c.name, why }), tone: 'error', card: c.statusPath }])
      const say = t('toast.chainPaused', { name: c.name, why })
      $.ui.toast(say, { timeoutMs: 10_000 })
      notify($, say)
    } else if (step.kind === 'pass') {
      const judged = step.skipped || step.unreviewed ? fresh?.head ?? c.git?.head : undefined
      // 免審查、未複審過關：判定的 HEAD 是檢查時的（不記的話過關後馬上算成有新 commit、又重新檢查）；跟現在的 HEAD 一樣才記得住它的分支。
      if (!(await saveChain($, key, r => r ? { ...r, passed: true, ...(step.needsHuman ? { needsHuman: step.needsHuman.code } : {}), ...(step.skipped ? { skippedReview: true } : {}), ...(step.unreviewed ? { unreviewed: true } : {}), ...(judged ? { judgedHead: judged, judgedBranch: judged === c.git?.head ? c.git?.branch : undefined } : {}) } : r, saveOpts))) { await unmarkHandled(); acted = actedBefore; continue }
      // 專案設了 autoPr（高風險照舊停下等你看；發版線、detached HEAD 跟沒開一樣）：重讀一次 PR（不用快取，免得剛開的 PR 沒看到又開一個），決定開 PR、只 push 或不派。
      const auto = !step.needsHuman && !tutorial && autoPrApplies(c) && (settings ?? await loadSettings($, options, preloaded)).autoPr
      const pr = auto ? await prProbe($, options, c.root, c.git!.branch, s.at, true) : undefined
      const prPlan: AutoPrPlan | undefined = auto ? autoPrPlan({ ...c, pr }) : undefined
      // 額度煞車：要派推送前額度低於門檻就不派（流程照樣是過關），動態與提示寫原因。
      const low = prPlan && prPlan.kind !== 'skip' ? quotaLow(s.limits, (settings ?? await loadSettings($, options, preloaded)).chainQuotaStop, s.at) : ''
      const plan: AutoPrPlan | undefined = low && prPlan ? { kind: 'skip', why: t('autoChain.quotaNoPush', { low, button: prPlan.kind === 'open' ? t('word.openPrButton') : t('word.pushButton') }) } : prPlan
      const words = passWords(c.name, plan, step.skipped ? 'skipped' : step.unreviewed ? 'unreviewed' : 'reviewed')
      const risky = step.needsHuman ? stopText(step.needsHuman) : ''
      const text = risky ? t('feed.named', { name: c.name, text: risky }) : words.feed
      await feedPush($, [{ at: s.at, text, tone: risky ? 'warning' : 'success', card: c.statusPath }])
      const say = risky ? t('toast.named', { name: c.name, text: risky }) : words.say
      $.ui.toast(say, { timeoutMs: 10_000 })
      notify($, say)
      if (plan) await autoPublish($, options, { ...c, pr }, plan)
    } else {
      // 派修正：這條分支累計的修正輪數要等真的派出去（dispatch 啟動成功）才加 1，排進隊伍後被丟掉、沒派成的不算；
      // 這裡先把目前的累計數寫成數字（舊紀錄沒有，round 改掉之前照它算），提示的「第 n／2 輪」是派出去後的數。
      // 寫回時以最新的紀錄為準（被別的對話改過會重套）：提示用的輪數跟寫進去的同一個。派審查不算。
      let total = fixTotalOf(run) + 1
      const counted = (r: ChainRun): Partial<ChainRun> => { const now = fixTotalOf(r); total = now + 1; return step.reason ? { fixTotal: now } : {} }
      if (!(await saveChain($, key, r => r ? { ...withoutMedium(r), ...counted(r), round: step.round, ...(step.reason === 'review' ? { reviewFix: true } : {}) } : r, saveOpts))) { await unmarkHandled(); acted = actedBefore; continue }
      // 審查修正帶著剛結束的是不是資安審查：提示只寫那一份審查檔（SECURITY.md 或 REVIEW.md）。提示的「第 n／2 輪」是整張卡累計的。
      const fix: FixReason | undefined = step.reason ? { from: step.reason as 'check' | 'review', round: total, ...(step.reason === 'check' ? { tail: fresh?.tail ?? [] } : {}), ...(step.reason === 'review' && last.security ? { security: true } : {}) } : undefined
      const sent = await dispatch($, options, { ...c, state: 'ready' }, step.dispatch, { fix, auto: true, ...(step.security ? { security: true } : {}) })
      // 依審查修正沒派出（不在隊伍、不是已啟動未列出）：停下流程，不然面板一直算成處理中。派審查、檢查失敗後的修正不在這裡停。
      if (!sent && fix?.from === 'review') await pauseUnsentReviewFix($, c, mine, s.at)
    }
  }
  if (acted) refreshSoon($, options)
}

/**
 * 疊放卡不用再等原卡、這個對話記著要派實作：沒有 Agent 在跑、排隊、啟動或檢查在跑時，拿掉記號再派一次（只試一次）。
 * 額度低於門檻不派，動態與提示寫原因、叫你按 g（記號照樣拿掉，不會每次重新整理都重來）。回傳有沒有動作。
 */
async function releaseStacked($: any, options: PluginOptions, c: Case, key: string, mine: string, s: Snapshot, preloaded?: DispatchSettings): Promise<boolean> {
  if (c.agent || c.statusPath in (await read($, verifyingAtom)) || verifyPending(c.statusPath) || isAgentQueued(c.statusPath) || await starting($, c.statusPath)) return false
  const clear = (r: ChainRun | undefined) => { if (!r?.stackDispatch || r.owner !== mine) return r; const { stackDispatch: _, ...rest } = r; return rest }
  if (!(await saveChain($, key, clear))) return false
  const low = quotaLow(s.limits, (await loadSettings($, options, preloaded)).chainQuotaStop, s.at)
  if (low) {
    const why = t('autoChain.stackQuota', { low })
    await feedPush($, [{ at: s.at, text: t('feed.named', { name: c.name, text: why }), tone: 'warning', card: c.statusPath }])
    $.ui.toast(t('toast.named', { name: c.name, text: why }), { timeoutMs: 10_000 })
    return true
  }
  await dispatchAfterStack($, options, c)
  return true
}

/**
 * 審查有 CRITICAL／HIGH、自動派的修正沒派出（直接派與從派工隊伍派出共用）：確定沒啟動才停下這個對話的流程、記原因，
 * 不然結論還擋著、流程沒停，面板一直算成處理中。排回隊伍的（名額被搶走）、已啟動只是 agents 清單還沒列出的（Agent 可能在跑）、
 * 這件另有派工還在啟動的（同時派了兩次，由那次決定）不停。
 * 流程是別的對話的、或已經停下就不動；真的停下才寫動態與系統通知（同一件不會寫兩次）。回傳這次有沒有停下。
 */
export async function pauseUnsentReviewFix($: any, c: Case, mine: string, at: number): Promise<boolean> {
  if (isAgentQueued(c.statusPath) || unconfirmed.has(c.statusPath) || await starting($, c.statusPath)) return false
  if (!(await saveChain($, normalizeRoot(c.root), r => !r || r.owner !== mine || r.stopped ? r : paused(r, STOP.reviewFixNotSent)))) return false
  await feedPush($, [{ at, text: t('autoChain.paused', { name: c.name, why: REVIEW_FIX_NOT_SENT }), tone: 'error', card: c.statusPath }])
  notify($, t('toast.chainPaused', { name: c.name, why: REVIEW_FIX_NOT_SENT }))
  return true
}

/** 程式碼審查的結論可以算「這條分支審查過」：關卡讀得出分級就算（MEDIUM 只記錄，不管有沒有 CRITICAL／HIGH）。 */
function reviewSettled(c: Case): boolean {
  return !!parseVerdict(c.gate)
}

/**
 * 舊卡：你在「等你」對審查 MEDIUM 題選了修掉（送出時記下 HEAD 在 mediumFixAt）、對話把「等你」清掉了：派一次依審查檔修那幾條 MEDIUM 的修正。
 * 你主動要的修正不受上限擋；派出去才算一輪（dispatch 的 countedFix），修完的 commit 由「審查通過後有新 commit」的重新測試與驗收接手。
 * 這之後 HEAD 變了（對話自己修了、或你改了別的）就不派，拿掉紀錄；worktree 有別人的未提交改動先不派，下次重新整理再看。
 * 你主動要的：照按 g 接續的規則派（resumed），排隊時不看額度。自動只試一次：派之前就拿掉紀錄（啟動一直失敗也不會每次重新整理都重派）。
 * 沒派出去時分兩種：已啟動、只是 agents 清單還沒列出（Agent 可能在跑）就不重派、不停下，等它出現；確定沒啟動就停下流程寫明按 g 重派。
 * 回傳有沒有派出或排進隊伍。
 */
async function fixPickedMedium($: any, options: PluginOptions, c: Case, run: ChainRun, own: RootJobs | undefined, at: number): Promise<boolean> {
  const head = run.mediumFixAt
  if (!saysNone(c.ask) || tutorial) return false
  const key = normalizeRoot(c.root)
  const clear = (r: ChainRun | undefined) => { if (!r || r.mediumFixAt !== head) return r; const { mediumFixAt: _, ...rest } = r; return rest }
  if (head !== c.git?.head) { await saveChain($, key, clear); return false }
  if (markRefusalStop(await worktreeMark($, c.root), own)) return false
  if (!(await saveChain($, key, clear))) return false
  await feedPush($, [{ at, text: t('autoChain.mediumFix', { name: c.name }), tone: 'suggestion', card: c.statusPath }])
  const fix: FixReason = { from: 'medium', round: fixTotalOf(run) + 1, ...(run.mediumFixSecurity ? { security: true } : {}) }
  if (await dispatch($, options, { ...c, state: 'ready' }, 'continue', { fix, auto: true, resumed: true })) {
    await saveChain($, key, r => r ? { ...r, mediumFixed: true } : r)
    return true
  }
  if (unconfirmed.has(c.statusPath)) return false
  if (await saveChain($, key, r => r && !r.stopped ? paused(r, STOP.mediumFixNotSent) : r)) await feedPush($, [{ at, text: t('autoChain.paused', { name: c.name, why: stopText(STOP.mediumFixNotSent) }), tone: 'error', card: c.statusPath }])
  return false
}

/**
 * 合併段跟基準分支有衝突、這個對話的流程已過關：自動派解衝突 Agent（同一個 HEAD 只試一次）。不自動派的原因（catchupHold）由面板寫在「輪到你」。
 * 等你有內容、有 Agent 在跑或排隊或啟動中、檢查在跑都先不派。派之前再看一次 worktree 乾淨，滿了照派工規則排隊。
 * 這個 HEAD 試過了（catchupHead）在 dispatch 真的派出 Agent 時才記：排隊中、隊伍被清空、派不出去都不算。
 * 派不出去（不在隊伍裡）就把流程停下寫原因，不然每次重新整理都會再派一次。
 * 回傳有沒有動作（派出、排進隊伍或停下流程）。合併 commit 之後由「審查通過後有新 commit」的重新檢查與審查接手。
 */
async function autoCatchup($: any, options: PluginOptions, c: Case, run: ChainRun, mine: string, at: number, agentBusy: boolean, limits: Snapshot['limits'], preloaded?: DispatchSettings): Promise<boolean> {
  const conflict = c.conflict
  if (!conflict || run.owner !== mine || !run.passed || c.chain?.stale || catchupHold(c) || !saysNone(c.ask) || !c.git) return false
  if (agentBusy || c.agent?.asks || c.statusPath in (await read($, verifyingAtom)) || verifyPending(c.statusPath) || isAgentQueued(c.statusPath) || await starting($, c.statusPath)) return false
  if (tutorial || (await worktreeMark($, c.root)).files) return false
  // 額度煞車：額度低於門檻不派解衝突，流程停下寫原因（停過之後 catchupHold 回額度原因，不會再來）。合併段沒有 g 可按，
  // 原因句的結尾改成叫你在對話合併基準分支、解衝突，「輪到你」也照這句。
  const hold = quotaHold(limits, (await loadSettings($, options, preloaded)).chainQuotaStop, at, true)
  if (hold) {
    // 快照是這輪重新整理開始時的：同一輪隊伍可能已經把這件停下了（排隊的解衝突被擋），那邊已經通知過，這裡只在真的停下時才說。
    // 看 saveChain 的回傳值：閉包在重套時會再跑，放棄寫入時也不算停下。
    const stopped = await saveChain($, normalizeRoot(c.root), r => !r || r.owner !== mine || r.stopped ? r : paused(r, hold))
    if (!stopped) return true
    const why = stopText(hold)
    await feedPush($, [{ at, text: t('autoChain.paused', { name: c.name, why }), tone: 'error', card: c.statusPath }])
    const say = t('toast.chainPaused', { name: c.name, why })
    $.ui.toast(say, { timeoutMs: 10_000 })
    notify($, say)
    return true
  }
  await feedPush($, [{ at, text: catchupFeed(c.name, conflict.into, conflict.files.length), tone: 'suggestion', card: c.statusPath }])
  const sent = await dispatch($, options, { ...c, state: 'ready' }, 'catchup', { auto: true, text: conflict.ref })
  if (!sent && !isAgentQueued(c.statusPath)) {
    if (await saveChain($, normalizeRoot(c.root), r => r && r.owner === mine && !r.stopped ? paused(r, STOP.catchupNotSent) : r)) {
      const why = stopText(STOP.catchupNotSent)
      await feedPush($, [{ at, text: t('autoChain.paused', { name: c.name, why }), tone: 'error', card: c.statusPath }])
      notify($, t('toast.chainPaused', { name: c.name, why }))
    }
  }
  return true
}

/**
 * 審查通過後分支又有新 commit（你決定要改、或在面板外改了）：開新的一輪流程（不算修正輪數，但同一條分支累計的修正數與「審查過」照帶），
 * 排一次「做完了」讓流程照常走：完成檢查 → 這條分支審查過就只跑測試、綠了過關；沒審查過（或高風險）才審查，只看上次審查之後的 diff。
 * 這筆是合成的、不是真的派工，直接記成已結束：noteRuns 不會再對它重算指紋（這時 worktree 的改動多半是人在面板外改的），
 * 派審查前照樣拿上一個程式 Agent 結束時的指紋比對。
 */
async function recheck($: any, key: string, run: ChainRun, last: JobRecord | undefined, owner: string, now: number, branch: string | undefined) {
  await saveChain($, key, () => ({ owner, startedAt: now, round: 0, recheck: true, ...carriedFix(run, branch), ...carriedReview(run, branch), ...(run.mediumFixed ? { reviewFix: true } : {}), ...(run.reviewHead ? { reviewHead: run.reviewHead, ...(run.reviewBranch ? { reviewBranch: run.reviewBranch } : {}) } : {}), ...(run.judgedHead ? { judgedHead: run.judgedHead, ...(run.judgedBranch ? { judgedBranch: run.judgedBranch } : {}) } : {}) }))
  const all = await loadJobs($)
  const record: JobRecord = { launchName: last?.launchName ?? 'recheck', nativeId: last?.nativeId ?? 'recheck', sessionId: last?.sessionId ?? '', kind: 'continue', startedAt: now, fresh: false, answered: true, owner, recheck: true, ended: { how: 'finished' } }
  await $.store.set(JOBS_KEY, { ...all, [key]: { ...all[key], last: record } })
}

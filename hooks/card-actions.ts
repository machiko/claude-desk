// 現在卡上的動作：回覆 Agent、派 Agent 開 PR／push、預填決策、預填發版請求、開卡片、確認上線、歸檔、確認規格、停止 Agent；
// 以及新專案還沒有任務時的建立空登錄表。會改變任務狀態的操作，結果另外記下來，下一則你打的提示告訴對話（desk-io 的 tellPanel）。
// 從 register.tsx 搬出來；派工、重新整理仍在 register.tsx，比照 tutorial-run.tsx 從那裡匯入。
// 跨檔傳 $ 的函式一律用 function 宣告；atom 位址同 register.tsx，各自宣告。
import { atom, read } from 'claude-code'
import type { PluginOptions } from 'claude-code'
import type { Case, SentRecord, Snapshot } from '../types'
import { parseCard, parseDecisions, decisionAnswer, decisionNames, decisionPrompt, withDecision, releasePrompt, allPicked, confirmShip, isPlaceholder, parseGate, ARCHIVE_WORD, CARD_CMD, PLAN_STEP, REGISTRY_TEMPLATE } from './card'
import { DEMO_ONLY, WORD } from './theme'
import { quotaHeld } from './model'
import { errorLine, errorText, plain, reasonLine, slugOf } from './text'
import { baseRefs, deskPaths, lastLine, loadSettings, originRemote, worktreeMark } from './probes'
import { afterSpecRefusal, openPrRequest, prHowOf, pushRequest, refusalOf, refusalText } from './dispatch'
import { normalizeRoot } from './settings'
import { archivesOnShip, canRelease, isReleaseLine, releasingStep } from './pipeline'
import { AGENT_STOPPED, CHAIN_CHANGED, paused, revOf } from './chain'
import { STOP, storedCause } from './stop-reason'
import { picksKey } from './pane'
import { tutorial, cancelSim, tutorialDecision } from './tutorial-run'
import type { AutoPrPlan } from './auto-pr'
import { feedPush, loadChains, loadJobs, me, missingRegistry, openWith, saveChain, tellPanel } from './desk-io'
import { markRefusal } from './worktree-mark'
import { isAgentQueued } from './agent-queue'
import { alreadyQueued } from './dispatch-runner'
import { sentState } from './turn'
import { readSent } from './prompt-sync'
import { trustCheck } from './approve-check'
import { STACK_AUTO_NEXT } from './stack'
import { dispatch, refresh, refreshAfterWrite, restageFromCard, optionsRef } from './register'
import { t } from './i18n'

// 示範任務那句搬到 theme.ts；呼叫端與測試照舊從這裡匯入也行。
export { DEMO_ONLY } from './theme'

const picksAtom = atom({ plugin: 'desk', key: 'picks' } as const, {})
const snapshotAtom = atom({ plugin: 'desk', key: 'snapshot' } as const, null)

/**
 * 額度煞車擋在派審查（或資安審查）前、你按 g（或 /desk go）重開：直接派那次審查接續原本那輪，不多派一個實作 Agent。
 * 擋在派修正前的不走這裡（照舊按 g 派修正）；沒有記到被擋的那步（舊紀錄）也不走，回 null。
 * 這是你手動派的：先過手動派審查的拒絕檢查（Agent 在跑、已經合併、規格還擋著、手動任務）與 worktree 檢查；
 * 流程改成這個對話的（別的對話開的也一樣，跟手動按 g 開新的一輪相同）；排隊時不看額度（resumed）。
 * 面板上次重新整理之後流程紀錄被別的對話改過（版本不同）：不派，回 CHAIN_CHANGED。
 * 回傳給 /desk go 的一句話（派出、排隊、拒絕或沒派出）。
 */
export async function resumeQuotaHeld($: any, options: PluginOptions, c: Case): Promise<string | null> {
  const key = normalizeRoot(c.root)
  const run = (await loadChains($))[key]
  if (!quotaHeld(c.chain)) return null
  // 面板看到的是額度暫停，但之後別的對話改過這件的流程紀錄（例如接手開了新一輪、暫停已解除）：不派、照它寫的留著。
  if (revOf(run) !== (c.chain?.rev ?? 0)) return chainChanged($, c)
  const resume = run?.resume
  if (!run?.stopped || !resume || resume.dispatch !== 'review') return null
  const what = resume.security ? t('word.securityReview') : t('kindLabel.review')
  const refused = refusalOf(c, 'review')
  const foreign = (refused || tutorial) ? '' : markRefusal(await worktreeMark($, c.root), (await loadJobs($))[key])
  if (refused || foreign) {
    const text = refused ? refusalText(c.name, what, refused) : t('toast.cantDispatch', { name: c.name, what, why: foreign })
    $.ui.toast(text, { timeoutMs: 10_000 })
    return text
  }
  // 同一件已經有一筆排著（例如被擋下後名額滿、你按了 s 或 w）：跟手動派工一樣只說已在隊伍，流程紀錄不動（額度暫停與記下的那步留著）。
  if (isAgentQueued(c.statusPath)) {
    const text = alreadyQueued(c)
    $.ui.toast(text)
    return text
  }
  const reason = storedCause(run.stopped, run.stopArgs)
  const mine = await me($)
  // 帶著面板上次重新整理看到的版本寫：之後別的對話改過這件的流程紀錄（例如接手開了新一輪），就不派、照它寫的留著。
  const taken = await saveChain($, key, r => { if (!r) return r; const { stopped: _s, stopArgs: _a, resume: _r, ...rest } = r; return { ...rest, owner: mine, round: resume.round } }, { basedOn: c.chain?.rev ?? 0 })
  if (!taken) return chainChanged($, c)
  const sent = await dispatch($, options, { ...c, state: 'ready' }, 'review', { auto: true, resumed: true, ...(resume.security ? { security: true } : {}) })
  // 沒派出也沒排進隊伍（啟動中、同時派了兩次、啟動失敗；排進隊伍 dispatch 回 true）：流程照原本的原因停著，下次 g 再來。
  if (!sent) {
    await saveChain($, key, r => r ? paused(r, reason, false, resume) : r)
    const text = t('cardActions.resumeNotSent', { name: c.name, what })
    // 面板按 g 時沒有地方回這句：跟拒絕一樣也跳提示（啟動失敗本身另有一則「無法派…」）。
    $.ui.toast(text, { timeoutMs: 10_000 })
    return text
  }
  await feedPush($, [{ at: await $.clock.now(), text: t('cardActions.resumeFeed', { name: c.name, what }), tone: 'suggestion', card: c.statusPath }])
  return isAgentQueued(c.statusPath) ? t('cardActions.resumeQueued', { name: c.name, what }) : t('cardActions.resumeSent', { name: c.name, what })
}

/** 接續時流程紀錄已被別的對話改過：toast 並回給 /desk go 同一句。 */
function chainChanged($: any, c: Case): string {
  const text = t('toast.named', { name: c.name, text: CHAIN_CHANGED })
  $.ui.toast(text, { timeoutMs: 10_000 })
  return text
}

/** 回覆對話框的兩個選項。 */
const REPLY_NEXT = t('cardActions.replyNext')
const REPLY_CANCEL = t('cardActions.replyCancel')
/** 選「照卡片的下一步繼續」時送給 Agent 的回覆：給 Agent 的提示，不跟選項字一起搬進字串目錄。 */
const nextStepAnswer = (next: string) => `照卡片的下一步繼續：${next || '依卡片'}`

/** 回覆停下來問的 Agent：先問要回什麼（可打自己的字），再 resume 那個 session。 */
export async function reply($: any, options: PluginOptions, c: Case, text?: string) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  const refused = refusalOf(c, 'reply')
  if (refused) { $.ui.toast(refusalText(c.name, t('kindLabel.reply'), refused)); return }
  let answer = text?.trim() ?? ''
  if (!answer) {
    // 停在提問（status waiting）的 Agent 重新整理時不讀輸出：回覆這時才讀它最後一句。
    const asked = c.agent?.last || (tutorial ? '' : await lastLine($, c.agent?.id))
    const question = t('cardActions.replyQuestion', { asked: asked ? t('cardActions.replyAsked', { asked }) : t('cardActions.replyNoAsk'), next: REPLY_NEXT })
    const picked = await $.ui.ask(question, { header: t('cardActions.replyHeader', { name: c.name }), options: [REPLY_NEXT, REPLY_CANCEL] }).catch(() => '')
    if (!picked || picked === REPLY_CANCEL) return
    // 下一步還是範本佔位（舊卡沒跑 spec-ok）：與派工同一條規則，不把佔位文字原樣送給 Agent。
    answer = picked !== REPLY_NEXT ? picked : isPlaceholder(c.next) ? PLAN_STEP : nextStepAnswer(c.next)
  }
  // 不先把上一次派工標成已回覆：派出成功時 dispatch 會換上新的那筆；派工失敗時要留著，Agent 才仍算在等你、可以再回覆。
  await dispatch($, options, c, 'reply', { text: answer })
}

/** 教學不派真的 Agent：合併照教學說的按 t。 */
const TUTORIAL_PUBLISH = t('cardActions.tutorialPublish')

/** 開 PR 要推送 Agent 做的那句：對基準分支（baseRefs 第一個：PR 目標、卡片基準欄、最新 release 線…）開 PR，做法依 origin（或專案 `pr.open`）。 */
async function openPrText($: any, options: PluginOptions, c: Case): Promise<string> {
  const settings = await loadSettings($, options)
  const [target] = await baseRefs($, c, settings.cardBase ?? '')
  return openPrRequest(c.git?.branch ?? '分支', target ?? '', prHowOf(await originRemote($, c.root), settings.prOpen))
}

/** 合併段的「⇡ 開 PR」（按兩次確認後）：派推送 Agent push 分支並對基準分支開 PR；desk 自己不跑 git push、gh。 */
export async function publishPr($: any, options: PluginOptions, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  if (tutorial) { $.ui.toast(t('toast.named', { name: c.name, text: TUTORIAL_PUBLISH })); return }
  await dispatch($, options, c, 'publish', { text: await openPrText($, options, c) })
}

/**
 * 審查過關後自動派推送（專案設了 autoPr）：open 開 PR、push 只推到已開的 PR；跟按鈕一樣派推送 Agent，desk 自己不跑 git push、gh。
 * 自動派的不經手動派工的合併段判斷（過關當下六段還在審查段）；名額滿了照樣排進派工隊伍。
 */
export async function autoPublish($: any, options: PluginOptions, c: Case, plan: AutoPrPlan) {
  if (plan.kind === 'skip') return
  const text = plan.kind === 'open' ? await openPrText($, options, c) : pushRequest(c.git?.branch ?? '分支', plan.pr)
  await dispatch($, options, { ...c, state: 'ready' }, 'publish', { text, auto: true })
}

/** 合併段 PR 已開後的「⇡ push」（按兩次確認後）：派推送 Agent 只 push、不開新 PR。派出去了、又有未提交的檔案時提醒只會推已 commit 的。 */
export async function publishPush($: any, options: PluginOptions, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  if (tutorial) { $.ui.toast(t('toast.named', { name: c.name, text: TUTORIAL_PUBLISH })); return }
  const sent = await dispatch($, options, c, 'publish', { text: pushRequest(c.git?.branch ?? '分支', c.pr?.id) })
  if (sent && c.gitState?.changed) $.ui.toast(t('cardActions.uncommitted', { name: c.name, n: c.gitState.changed }))
}

/** 輸入框裡還沒送出的字；讀不到（沒有輸入框、讀取失敗）當成空的。 */
async function promptDraft($: any): Promise<string> {
  const box = await Promise.resolve().then(() => $.prompt.read()).catch(() => null)
  return typeof box?.text === 'string' ? box.text : ''
}

/**
 * 預填決策：輸入框是空的就直接填入；有草稿就另起一行接在後面（送出時 decisionNames 照樣認得）。
 * 草稿裡已有這件的決策（還沒送出又改選、或多按一次 f）就換掉那一行，不疊出兩行互相矛盾的決策。
 */
async function decisionFill($: any, name: string, text: string): Promise<{ input: { text: string; mode: string }; how: string }> {
  const draft = await promptDraft($)
  if (!draft.trim()) return { input: { text, mode: 'replace' }, how: t('cardActions.fillNew') }
  if (decisionNames(draft).includes(name)) return { input: { text: withDecision(draft, name, text), mode: 'replace' }, how: t('cardActions.fillReplaced') }
  return { input: { text: draft.endsWith('\n') ? text : `\n${text}`, mode: 'append' }, how: t('cardActions.fillAppended') }
}

/**
 * 按 f 填入決策被擋下的那句（含任務名）；null 代表可以填。示範任務、還有決策沒選、決策已送出還在等對話寫回，依序檢查。
 * 已送出時送出後面板就收掉 f，只有按下時面板還沒重畫才會走到；回合結束沒寫回時 prompt-sync 會再提示（「決策已送出，但卡片的「等你」沒有改」）。
 */
export function decisionRefusal(
  c: Pick<Case, 'demo' | 'name' | 'ask' | 'statusPath' | 'state'>,
  picks: Readonly<Record<string, string>>,
  sent: Readonly<Record<string, SentRecord>>,
): string | null {
  if (c.demo) return DEMO_ONLY
  if (!allPicked(parseDecisions(c.ask), picks)) return t('cardActions.pickAll', { name: c.name })
  if (sentState(sent, c) === 'waiting') return t('cardActions.sentWaiting', { name: c.name })
  return null
}

export async function fillDecision($: any, c: Case) {
  const picks = (await read($, picksAtom))[picksKey(c)] ?? {}
  const refusal = decisionRefusal(c, picks, await readSent($))
  if (refusal) { $.ui.toast(refusal); return }
  const decisions = parseDecisions(c.ask)
  const answer = decisionAnswer(decisions, picks)
  if (tutorial) { await tutorialDecision($, c, answer); return }
  const text = decisionPrompt(c.name, answer)
  const { input, how } = await decisionFill($, c.name, text)
  const filled = await $.prompt.fill(input).catch(() => ({ isFilled: false }))
  if (!filled.isFilled) { $.ui.toast(t('cardActions.cantFillDecision', { name: c.name, text })); return }
  $.ui.toast(t('cardActions.decisionFilled', { name: c.name, how }), { timeoutMs: 6000 })
}

/**
 * 「⚑ 發版」第二次按 z（第一次只待確認）：填一行帶確認段的 `/desk:release` 短請求（所有已合併待發版的卡與清理對象）進輸入框，你按 Enter 送給對話；
 * 對話載入 skills/release/SKILL.md，看到確認段就照慣例版號直接做、不再出題。面板不打 tag、不 push、不派工、不跑任何指令，也不自動送出。
 * 輸入框有還沒送出的字就不填（發版請求要整行送出，接在草稿後面會變成一則混在一起的提示）。
 */
export async function fillRelease($: any, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  // 第一次按之後發版才在對話裡開始（面板還沒重新整理）：重讀卡片，發版中就不填，同一版不做兩次。
  const refused = releaseRefusal(await releasingNow($, c))
  if (refused) { $.ui.toast(refused, { timeoutMs: 8000 }); return }
  if ((await promptDraft($)).trim()) { $.ui.toast(RELEASE_DRAFT, { timeoutMs: 8000 }); return }
  const cases = ((await read($, snapshotAtom)) as Snapshot | null)?.cases.filter(canRelease) ?? []
  const text = releasePrompt(cases.length ? cases : [c], { confirmed: true })
  const filled = await $.prompt.fill({ text, mode: 'replace' }).catch(() => ({ isFilled: false }))
  if (!filled.isFilled) { $.ui.toast(t('cardActions.cantFillRelease', { text }), { timeoutMs: 10_000 }); return }
  $.ui.toast(RELEASE_FILLED, { timeoutMs: 6000 })
}

const RELEASE_DRAFT = t('cardActions.releaseDraft')
export const RELEASE_RUNNING = t('cardActions.releaseRunning')
/** 按發版時這件正在發版（releasingNow 讀到的步驟）：回傳要跳的提示，否則 null。 */
export const releaseRefusal = (step: string | null): string | null => step ? RELEASE_RUNNING : null

/** 按下當下的卡片：狀態寫發版進行中、還沒逾時就回傳步驟；讀不到卡片就照快照（c.releasing）。 */
async function releasingNow($: any, c: Case): Promise<string | null> {
  const [text, stat] = await Promise.all([
    $.fs.read(c.statusPath).catch(() => null) as Promise<string | null>,
    $.fs.stat(c.statusPath).catch(() => null) as Promise<{ mtimeMs?: number } | null>,
  ])
  if (typeof text !== 'string') return c.releasing ?? null
  return releasingStep(plain(parseCard(text)?.['狀態'] ?? ''), typeof stat?.mtimeMs === 'number' ? stat.mtimeMs : null, await $.clock.now())
}
const RELEASE_FILLED = t('cardActions.releaseFilled')

export async function openCard($: any, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  if (!(await openWith($, c.statusPath))) $.ui.toast(t('cardActions.cantOpenCard', { name: c.name, path: c.statusPath }))
}

/** 上線確認：重讀卡片，關卡還是 release 才清成「無」並記 History；desk 只在這裡寫卡。 */
export async function confirmShipped($: any, c: Case) {
  if (c.demo) { $.ui.toast(DEMO_ONLY); return }
  const text = await $.fs.read(c.statusPath).catch(() => null)
  const now = await $.clock.now()
  const d = new Date(now)
  const two = (n: number) => String(n).padStart(2, '0')
  const next = typeof text === 'string' ? confirmShip(text, `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, `${two(d.getHours())}:${two(d.getMinutes())}`, c.tag ?? '', isReleaseLine(c) ? '等下一版開發' : `${ARCHIVE_WORD}：${CARD_CMD} archive ${slugOf(c)}`, (await loadSettings($, optionsRef!)).user) : null
  if (!next) {
    $.ui.toast(t('cardActions.shipUnchanged', { name: c.name }))
    await tellPanel($, now, '確認上線沒有改動：卡片關卡已不是 release', { name: c.name, skip: tutorial })
    void refresh($, optionsRef!); return
  }
  const failed = await $.fs.write(c.statusPath, next).then(() => null, (e: unknown) => errorText(e))
  if (failed !== null) {
    const text = t('cardActions.shipWriteFailed', { err: failed })
    $.ui.toast(t('toast.named', { name: c.name, text }))
    await tellPanel($, now, text, { name: c.name, skip: tutorial })
    return
  }
  const shipped = t('cardActions.shipped', { tag: c.tag ? t('word.paren', { text: c.tag }) : '' })
  await feedPush($, [{ at: now, text: t('feed.named', { name: c.name, text: shipped }), tone: 'success', card: c.statusPath }])
  await tellPanel($, now, shipped, { name: c.name, skip: tutorial })
  // 一般的卡確認上線後接著歸檔（同 ⌫ 歸檔，不刪 worktree 與分支）；發版線與教學那件照舊只清關卡。
  if (archivesOnShip(c, !!tutorial)) { await archiveCase($, optionsRef!, c); return }
  $.ui.toast(t('cardActions.shipCleared', { name: c.name }))
  void refresh($, optionsRef!)
}

/** 在任務的 worktree 裡跑 /desk:card 用的那支腳本（cwd 讓它認得出同一個專案與登錄表）。 */
async function runCardScript($: any, options: PluginOptions, c: Case, cmd: 'spec-ok' | 'archive') {
  const env = { DESK_SETTINGS: (await deskPaths($, options)).settings }
  return $.process.run(['python3', `${$.plugin.root}/skills/card/scripts/card.py`, cmd, slugOf(c)], { cwd: c.root, timeoutMs: 30_000, env })
    .catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: String(e) }))
}

export const deployReminder = (n: number): string => t('cardActions.deployReminder', { n })

/**
 * 真實模式的歸檔：執行 /desk:card archive <slug> 用的同一支腳本；卡片與審查檔由腳本複製、登錄表由腳本改。
 * 不刪 worktree 與分支，只把腳本印出的刪除指令放進提示；卡片有部署步驟時提示一併提醒搬走。失敗就提示錯誤原因（腳本印的第一行），任務留著。
 */
export async function archiveCase($: any, options: PluginOptions, c: Case) {
  const r = await runCardScript($, options, c, 'archive')
  const now = await $.clock.now()
  if (r.exitCode !== 0) {
    const why = reasonLine(r)
    const failed = t('cardActions.archiveFailed', { why })
    $.ui.toast(t('toast.named', { name: c.name, text: failed }), { timeoutMs: 10_000 })
    await feedPush($, [{ at: now, text: t('feed.named', { name: c.name, text: failed }), tone: 'error', card: c.statusPath }])
    await tellPanel($, now, `歸檔失敗：${why}`, { name: c.name, skip: tutorial })
    void refreshAfterWrite($, options)
    return
  }
  const removeCmd = String(r.stdout ?? '').split(/\r?\n/).map((l: string) => l.trim()).find((l: string) => /\bworktree remove\b/.test(l))
  // 部署步驟跟著卡片歸檔：隨發版線發版的卡，步驟要搬到發版線卡片或登錄表才不會漏做（只提醒，不自動搬）。
  const steps = c.deploySteps?.length ? t('word.semiNote', { text: deployReminder(c.deploySteps.length) }) : ''
  $.ui.toast(t('cardActions.archived', { name: c.name, steps, remove: removeCmd ? t('cardActions.archivedRemove', { cmd: removeCmd }) : '' }), { timeoutMs: 15_000 })
  // 歸檔後這件離開工作桌：這筆不掛在它的卡上，換到哪件都看得到。
  await feedPush($, [{ at: now, text: t('cardActions.archivedKept', { name: c.name }), tone: 'success' }])
  await tellPanel($, now, '已歸檔（worktree 與分支保留）', { name: c.name, skip: tutorial })
  void refreshAfterWrite($, options)
}

/**
 * 真實模式的確認規格：執行 /desk:card spec <slug> ok 用的同一支腳本（在任務的 worktree 裡跑，認得出同一個專案），
 * 卡片由腳本改；確認後重讀這張卡（restageFromCard），照按 g 的規則自動派實作（dispatchAfterSpec），再在背景重新整理。腳本失敗（卡片已被改過、找不到卡）就提示錯誤原因（腳本印的第一行），關卡留著、不派。
 */
export async function confirmSpec($: any, options: PluginOptions, c: Case) {
  const r = await runCardScript($, options, c, 'spec-ok')
  const now = await $.clock.now()
  if (r.exitCode !== 0) {
    const why = reasonLine(r)
    const failed = t('cardActions.specFailed', { why })
    $.ui.toast(t('toast.named', { name: c.name, text: failed }), { timeoutMs: 10_000 })
    await feedPush($, [{ at: now, text: t('feed.named', { name: c.name, text: failed }), tone: 'error', card: c.statusPath }])
    await tellPanel($, now, `確認規格失敗：${why}`, { name: c.name, skip: tutorial })
    void refreshAfterWrite($, options)
    return
  }
  await feedPush($, [{ at: now, text: t('cardActions.specOk', { name: c.name }), tone: 'success', card: c.statusPath }])
  await tellPanel($, now, '規格已確認，可以派實作', { name: c.name, skip: tutorial })
  // 只重讀這張卡就派，不等進行中那輪重新整理（可能卡在查容器、PR）；背景整輪重讀排在派工送出之後，
  // 才不會拿派工前的狀態蓋掉「啟動中」、或在收尾重派。讀不到卡就照舊等整輪重讀完再派。
  if (await restageFromCard($, c.statusPath)) {
    await dispatchAfterSpec($, options, c.statusPath)
    void refreshAfterWrite($, options)
    return
  }
  await refreshAfterWrite($, options, { whole: true })
  await dispatchAfterSpec($, options, c.statusPath)
}

/**
 * 規格剛確認（面板 t、教學的 t、對話跑的 spec-ok）：用重讀後的卡照按 g 派實作。
 * 確認規格等於核准檢查欄當時的指令：先記下核准（不能派也記，之後按 g 不用再核准），不跳對話框；
 * 「等你」還有事或手動派也不能派的，只說原因；其餘當手動派工交給 dispatch：worktree 有別人的改動、啟動中、已在隊伍、Agent 已滿排隊都照按 g 處理。
 */
export async function dispatchAfterSpec($: any, options: PluginOptions, statusPath: string): Promise<boolean> {
  const c = ((await read($, snapshotAtom)) as Snapshot | null)?.cases.find(x => x.statusPath === statusPath)
  // 重讀到的關卡還是 spec（腳本失敗、重讀失敗）：沒有確認，不派也不出聲。
  if (!c || c.demo || parseGate(c.gate)?.kind === 'spec') return false
  await trustCheck($, c)
  const refused = afterSpecRefusal(c)
  // 疊放卡只差原卡還沒合併（其他條件都過）：記在流程紀錄，原卡合併後自動流程派一次實作（擁有者是這個對話）。教學沒有疊放卡。
  if (refused && c.stackWait && !tutorial && !afterSpecRefusal({ ...c, stackWait: undefined })) {
    // 記號沒寫進去（流程紀錄一直被別的對話蓋掉）就不說會自動接著做，照手動派工的下一步。
    const next = await holdForStack($, c) ? STACK_AUTO_NEXT : refused.next
    await notDispatched($, c, t('cardActions.specNotDispatched', { why: refused.why, next: next ? t('word.semiNote', { text: next }) : '' }))
    return false
  }
  if (refused) { await notDispatched($, c, t('cardActions.specNotDispatched', { why: refused.why, next: refused.next ? t('word.semiNote', { text: refused.next }) : '' })); return false }
  return dispatch($, options, c, 'continue')
}

/**
 * 疊放卡確認規格後等原卡合併：流程紀錄記下「合併後派實作」，擁有者改成這個對話（確認規格跟按 g 一樣算這個對話接手）。
 * 回傳有沒有記下（已經是這個對話記的也算）。
 */
async function holdForStack($: any, c: Case): Promise<boolean> {
  const owner = await me($)
  const now = await $.clock.now()
  const key = normalizeRoot(c.root)
  const saved = await saveChain($, key, r => r?.stackDispatch && r.owner === owner ? r : { ...(r ?? { startedAt: now, round: 0 }), owner, stackDispatch: true })
  if (saved) return true
  const cur = (await loadChains($))[key]
  return !!cur?.stackDispatch && cur.owner === owner
}

/**
 * 疊放卡不用再等原卡（原卡合併、從登錄表消失，或你刪了「疊放於」）、這個對話記著要派：照確認規格後的規則派一次實作。
 * 呼叫端已拿掉記號（只試一次）。「等你」有事或手動派也不能派的只說原因；其餘當手動派工交給 dispatch（檢查改過沒核准、worktree 有別人的改動照按 g 擋）。
 */
export async function dispatchAfterStack($: any, options: PluginOptions, c: Case): Promise<boolean> {
  const refused = afterSpecRefusal(c)
  if (refused) { await notDispatched($, c, t('cardActions.stackNotDispatched', { why: refused.why, next: refused.next ? t('word.semiNote', { text: refused.next }) : '' })); return false }
  await feedPush($, [{ at: await $.clock.now(), text: t('cardActions.stackDispatch', { name: c.name }), tone: 'suggestion', card: c.statusPath }])
  return dispatch($, options, c, 'continue')
}

/** 確認規格後（或疊放卡不用再等原卡時）沒有派實作：提示、動態、下一則提示告訴對話都說同一句。 */
async function notDispatched($: any, c: Case, text: string) {
  const now = await $.clock.now()
  $.ui.toast(t('toast.named', { name: c.name, text }), { timeoutMs: 10_000 })
  await feedPush($, [{ at: now, text: t('feed.named', { name: c.name, text }), tone: 'suggestion', card: c.statusPath }])
  await tellPanel($, now, text, { name: c.name, skip: tutorial })
}

/** 停止 desk 自己派出去、正在跑的那個背景 agent（名字要對得上這件任務最後一次派工），流程一併暫停。 */
export async function stopAgent($: any, c: Case) {
  const last = (await loadJobs($))[normalizeRoot(c.root)]?.last
  if (!c.agent?.id) { $.ui.toast(t('cardActions.stopNoAgent', { name: c.name })); return }
  if (!last || c.agent.name !== last.launchName) { $.ui.toast(t('cardActions.stopForeign', { name: c.name, agent: c.agent.name || c.agent.id, id: c.agent.id })); return }
  if (tutorial) cancelSim()
  const r = tutorial ? { exitCode: 0, stderr: '' } : await $.process.run(['claude', 'stop', c.agent.id], { timeoutMs: 30_000 }).catch(() => null)
  if (!r || r.exitCode !== 0) {
    const why = errorLine(r, t('word.claudeStopFailed'))
    $.ui.toast(t('cardActions.stopFailed', { name: c.name, why }))
    await tellPanel($, await $.clock.now(), `停止 Agent 失敗：${why}`, { name: c.name, skip: tutorial })
    return
  }
  await saveChain($, normalizeRoot(c.root), run => run ? paused(run, STOP.agentStopped) : run)
  const now = await $.clock.now()
  await feedPush($, [{ at: now, text: t('cardActions.stoppedFeed', { name: c.name, stopped: AGENT_STOPPED }), tone: 'warning', card: c.statusPath }])
  await tellPanel($, now, `${AGENT_STOPPED}（對話保留）`, { name: c.name, skip: tutorial })
  $.ui.toast(t('cardActions.stopped', { name: c.name }))
  void refresh($, optionsRef!)
}

/**
 * 新專案的「＋ 建立空的登錄表」：在專案資料夾寫一份只有表頭的登錄表（$.fs.write 會建資料夾）。
 * 按下時重算一次要建的路徑：上次讀取後已經有了（對話或 /desk:card new 建的）、對話換了 repo、確認不了在不在，都不寫，提示後重讀。
 */
export async function createRegistry($: any, options: PluginOptions, path: string) {
  if ((await missingRegistry($, await deskPaths($, options))) !== path) {
    const exists = await $.fs.exists(path).catch(() => null)
    $.ui.toast(exists ? t('cardActions.registryExists') : t('cardActions.registryChanged'))
    void refreshAfterWrite($, options)
    return
  }
  const ok = await $.fs.write(path, REGISTRY_TEMPLATE).then(() => true).catch(() => false)
  if (!ok) { $.ui.toast(t('cardActions.registryFailed', { path })); await tellPanel($, await $.clock.now(), `無法建立登錄表 ${path}`, { skip: tutorial }); return }
  const now = await $.clock.now()
  await feedPush($, [{ at: now, text: t('cardActions.registryCreated', { what: WORD.createRegistry }), tone: 'success' }])
  await tellPanel($, now, `已${WORD.createRegistry}`, { skip: tutorial })
  $.ui.toast(t('cardActions.registryNext', { what: WORD.createRegistry, cmd: CARD_CMD }), { timeoutMs: 8000 })
  void refreshAfterWrite($, options)
}

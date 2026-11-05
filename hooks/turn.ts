// 輪到誰、該做什麼：依六段與任務狀態產生一句給你看的話，以及這一刻該出現哪些動作。
// 卡片的「下一步」是寫給 Agent 的；這裡的句子才是寫給人的，現在卡最上方與摘要列都用它。
import type { Case, SentRecord } from '../types'
import { agentWaits, approvalWait, approveText, isQuotaHold, QUOTA_RESTART, quotaHeld, slugOf } from './model'
import { CARD_CMD, choiceCount, parseDecisions, parseGate, saysNone } from './card'
import { awaitsSpecOk, canArchive, canRelease, finalState, isMerged, isReleaseLine, needsPr, needsPush, runningKind, shipsWith, standingVerdict } from './pipeline'
import { tutorialStep, tutorialTurn } from './tutorial'
import { AGENT_STOPPED, CHECK_CHANGED, CHECK_CHANGED_WHY, CHECK_UNAPPROVED, CHECK_UNAPPROVED_WHY } from './chain'
import { dispatchable, fixByG, idleNext, mergedUnshipped, reviewNext, untrustedSteps } from './dispatch'
import type { DispatchKind, UntrustedHold } from './dispatch'
import { MISSING_CHECK_NEXT, MISSING_CHECK_WHY } from './next-words'
import { ACTION_ORDER, HOTKEY } from './actions'
import type { ActionId } from './actions'
import { CATCHUP_RUNNING, catchupAutoTurn, catchupHandTurn, catchupHold } from './catchup'

export type Turn = {
  /** you：輪到你動手；ai：AI 或機器處理中，等著就好；none：沒有要做的事。 */
  who: 'you' | 'ai' | 'none'
  text: string
  /** 該按的那個動作：一定在 footer 上（stageActions 裡），而且是唯一帶頭的那顆；不在 footer 上就不帶。 */
  action?: ActionId
  /** 那個動作的單鍵（由 action 推得，HOTKEY(action)）。 */
  key?: string
}

/** 各段落算出來、還沒跟 footer 對過的那一句：action 由 turnOf 跟 stageActions 取交集後才定。 */
type BaseTurn = Omit<Turn, 'key'>

/**
 * 畫面上才知道的事：完成檢查執行中、排隊中、派工中、派工排第幾位（1 起，沒排是 undefined）、決策送出了沒、現在是不是教學模式，
 * 以及現在幾點（判斷卡片落後）、上次派工有沒有被擋下（hold）。
 */
export type TurnCtx = { /** 上次派工因為 repo 還沒信任而開不了：派的是哪一種、是不是自動流程派的；沒有更要緊的事時改說三步。 */ hold?: Pick<UntrustedHold, 'dispatch' | 'auto'>; verifying?: boolean; queued?: boolean; launching?: boolean; agentQueued?: number; tutorial?: boolean; sent?: SentState; now?: number }

/** waiting：送出了、對話還在處理；unwritten：回合結束了，卡片的「等你」卻沒改。 */
export type SentState = 'waiting' | 'unwritten'

/** 這件任務的決策送出了沒：卡片「等你」跟送出時一樣才算；寫回卡片（等你改了）就回到平常。 */
export function sentState(sent: Readonly<Record<string, SentRecord>>, c: Pick<Case, 'statusPath' | 'ask' | 'state'>): SentState | undefined {
  const r = sent[c.statusPath]
  if (!r || c.state !== 'ask' || r.ask !== c.ask) return undefined
  return r.done ? 'unwritten' : 'waiting'
}

/** 最後一次 commit 比卡片新多少才提示同步：Agent 先寫卡再 commit 時差幾秒，不算。 */
export const BEHIND_MS = 60_000
/** commit 之後等多久才提示：對話常常先 commit 再寫卡，給它時間寫完。 */
export const SETTLE_MS = 2 * 60_000

/**
 * 卡片可能過期：分支最後一次 commit（不算只改卡片的）改到的程式比卡片新、commit 已經放了一陣子，而且沒有 Agent 在跑。按 s 同步。
 * 比的是那次 commit 改到的檔案最後被改的時間，不是 commit 時間：先寫卡、跑完測試才 commit 時，卡片並沒有過期。
 */
export const cardBehind = (c: Pick<Case, 'demo' | 'manual' | 'commitAt' | 'changedAt' | 'updatedAt' | 'state' | 'agent' | 'pipeline'>, now: number) =>
  !c.demo && !c.manual && !c.agent && c.state !== 'running' && c.state !== 'nocard' && c.state !== 'done' && !isMerged(c)
  && typeof c.commitAt === 'number' && c.updatedAt !== null && (c.changedAt ?? c.commitAt) - c.updatedAt > BEHIND_MS && now - c.commitAt > SETTLE_MS

export type { ActionId }

const isRunning = (c: Case) => c.state === 'running'
const hasChoice = (c: Case) => choiceCount(parseDecisions(c.ask)) > 0
/** Agent 在跑時，依最後一次派的是什麼說它在做什麼。 */
const RUNNING_TEXT: Partial<Record<string, string>> = {
  continue: 'Agent 在寫程式（l 看輸出）', reply: 'Agent 在寫程式（l 看輸出）', fix: 'Agent 在修正（l 看輸出）',
  sync: 'Agent 在同步卡片（l 看輸出）', review: 'Agent 在驗收（新對話）', verify: '測試在跑',
  publish: 'Agent 在 push、開 PR（l 看輸出）', catchup: CATCHUP_RUNNING,
}

const runningText = (c: Case) => RUNNING_TEXT[runningKind(c) ?? c.chain?.lastKind ?? 'continue'] ?? RUNNING_TEXT.continue!

const SELF_REVIEW = '（驗收是自審，可按 w 派獨立驗收）'
/** 檢查欄空白、範本佔位或說明文字（verifyCommand 回空字串）時，規格段叫你填的那句。 */
const MISSING_CHECK = `${MISSING_CHECK_WHY}：${MISSING_CHECK_NEXT}`

// 派工（dispatch.ts）也要用，放在 pipeline.ts；這裡照舊匯出。
export { needsPr, needsPush }

/** 高風險改動、還沒有 PR：審查檔（e）一律列出，不管有沒有 Agent 在跑。 */
export const riskyNoPr = (c: Case) => !c.pr && !!c.chain?.needsHuman
/** 高風險改動、還沒有 PR、能派推送：「⇡ 開 PR」照樣出現，但第一次按只提醒先看過審查檔，再按一次才派推送 Agent。 */
export const needsPrConfirm = (c: Case) => needsPr(c) && riskyNoPr(c)

/**
 * 流程停在檢查段（指令未核准、容器沒啟動、檢查中斷）：說為什麼，按 v；排除後跑完檢查，流程接著走。
 * 指令未核准的原因本身就說了要按什麼，直接用它。
 */
function checkHold(c: Case): BaseTurn | null {
  const why = c.chain?.heldAtCheck ? c.chain.stopped : undefined
  if (!why) return null
  // 停下之後卡片的檢查被整條清掉：按 v 跑不了（只會說尚缺檢查），不再承諾核准；先叫你填檢查。
  if (!c.verify) return { who: 'you', text: MISSING_CHECK, action: 'open' }
  // 別的對話開的流程：這裡按 v 只會跑檢查、接不下去；說去哪裡接，或在這裡重開一輪。
  if (c.chain!.foreign) {
    const short = why === CHECK_CHANGED ? CHECK_CHANGED_WHY : why === CHECK_UNAPPROVED ? CHECK_UNAPPROVED_WHY : why
    return { who: 'you', text: `流程已暫停（${short}）：這個流程是別的對話開的，到那個對話按 v 才會接著走；或在這裡按 g 重開一輪`, action: 'continue' }
  }
  const text = why === CHECK_CHANGED || why === CHECK_UNAPPROVED ? why : `流程已暫停（${why}）：排除後按 v 重跑測試，流程接著走`
  return { who: 'you', text, action: 'verify' }
}

/** 流程停住、檢查段因此標 ✕：說停住的原因，按 v 重跑檢查。 */
const checkStageFailed = (c: Case) => !!c.chain?.stopped && c.pipeline?.current === 'check' && c.pipeline.stages.some(s => s.id === 'check' && s.status === 'fail')

/**
 * 檢查通過後流程會自動派審查：流程是這個對話開的、最後一次派的是實作／回覆且還沒處理（autoReview），沒停下、沒過關。
 * 只有流程紀錄不夠：紀錄按資料夾永久保存，別的對話開的（foreign）或最後一次派的是同步，按 v 之後不會派審查。
 */
const willAutoReview = (c: Case) => !!c.chain?.autoReview && !c.chain.stopped && !c.chain.passed

/**
 * 上線段該做的事與做完之後：還沒打 tag 就按兩次 z（「⚑ 發版」）把已確認照慣例版號的發版請求填進輸入框（關卡是 release 的打了 tag 接著部署、按 u，否則歸檔）；
 * tag 打了、關卡是 release 就部署後按 u，不是 release 就歸檔。合併進發版線（release/*）的卡隨那條線發版，等它打 tag；
 * 其他沒有發版按鈕的（教學模式、發版線本身）照舊叫你打 tag。
 * 面板合併後的下一步與部署步驟列「全部做完後：」也用這一句。
 */
export const shipTurn = (c: Case, tutorial = false): Turn => keyed(shipBase(c, tutorial))

function shipBase(c: Case, tutorial: boolean): BaseTurn {
  const release = parseGate(c.gate)?.kind === 'release'
  if (c.tag && release) return { who: 'you', text: `部署 ${c.tag} 後按 u 確認上線；確認後歸檔`, action: 'ship' }
  if (c.tag) return { who: 'you', ...(!tutorial && canArchive(c) ? archiveTurn(c) : { text: `${c.tag} 已打；輸入 ${CARD_CMD} archive ${slugOf(c)} 歸檔` }) }
  // 合併進發版線的卡：發版線打 tag 就是它的上線，沒有自己的發版鍵；不帶鍵。
  const line = tutorial ? null : shipsWith(c)
  if (line) return { who: 'you', text: `隨 ${line} 發版；${release ? '發版線打 tag 後部署並按 u 確認上線' : '發版線打 tag 後歸檔'}` }
  if (tutorial || !canRelease(c)) return { who: 'you', text: release ? '打 tag 發版；打了之後部署並按 u 確認上線' : '打 tag 發版；打了之後歸檔' }
  return { who: 'you', text: `${RELEASE_TURN}；${release ? '打了 tag 之後部署並按 u 確認上線' : '打了 tag 之後歸檔'}`, action: 'release' }
}

export const RELEASE_TURN = '按兩次 z 發版，再按 Enter 送出'

/** 可以從面板歸檔：按兩次 q（⌫ 歸檔），或在對話輸入歸檔指令。 */
const archiveTurn = (c: Case) => ({ text: `按兩次 q 歸檔（或輸入 ${CARD_CMD} archive ${slugOf(c)}）`, action: 'archive' as const })

/**
 * 檢查段：按 v，以及通過後會怎樣。審查後有新 commit 時，流程是這個對話的且已過關（register 會排 recheck），
 * 或流程已經會自己接手（recheck 排好的新一輪、修正輪剛做完：willAutoReview），都是自動重新審查。
 */
function checkTurnText(c: Case): string {
  if (c.chain?.stale) return `驗收後有新 commit：按 v 重新執行測試；${(c.chain.passed && !c.chain.foreign) || willAutoReview(c) ? '通過後自動重新驗收' : '通過後按 w 重新驗收'}`
  return `按 v 執行測試；${willAutoReview(c) ? '通過後自動驗收' : '通過後按 w 派驗收'}`
}

/** 審查段：按 w，以及審查之後會怎樣：CRITICAL／HIGH 自動修正、影響行為的 MEDIUM 寫進「等你」，過關後合併開著的 PR，沒有 PR 就開 PR。 */
function reviewTurnText(c: Case): string {
  const head = c.chain?.stale ? '驗收後有新 commit：按 w 重新驗收（新對話）' : '按 w 派驗收（新對話）'
  return `${head}；有 CRITICAL／HIGH 會自動修正、影響行為的 MEDIUM 寫進等你，過關後${c.pr?.state === 'OPEN' ? '合併 PR' : '開 PR'}`
}

/** 重新派工的動作：③ 只說這幾種的鍵，別的（開卡片、執行測試）不算。 */
const DISPATCH_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>(['continue', 'review', 'sync', 'reply', 'open-pr', 'push'])
/** 只用來算鍵：把還在走的流程當成已暫停，不寫回卡片也不顯示。 */
const UNTRUSTED_STOP = 'repo 還沒信任'
/** 手動派工遇到還沒信任：剛按的那個動作（推送看現在是開 PR 還是 push）。 */
const HOLD_ACTION: Partial<Record<DispatchKind, ActionId>> = { continue: 'continue', review: 'review', sync: 'sync', reply: 'reply' }
const heldAction = (c: Case, kind: DispatchKind): ActionId | undefined => kind === 'publish' ? (needsPr(c) ? 'open-pr' : needsPush(c) ? 'push' : undefined) : HOLD_ACTION[kind]
/** 派工鍵派得出去：dispatchable 列了它；等你有決策時不派繼續（先回答決策）。列上與 ③ 用同一個判斷。 */
function mayDispatch(c: Case, k: 'continue' | 'review' | 'sync' | 'reply'): boolean {
  return dispatchable(c).includes(k) && !(k === 'continue' && c.state === 'ask' && parseDecisions(c.ask).length > 0)
}
/** 手動派的那個動作此刻還在列上（派得出去）才算；失敗後卡片改成派不出去就不算（推送兩顆鍵照原本的條件）。 */
const heldOnRow = (c: Case, kind: DispatchKind): ActionId | undefined => {
  const a = heldAction(c, kind)
  return a && (a === 'open-pr' || a === 'push' || mayDispatch(c, a as 'continue' | 'review' | 'sync' | 'reply')) ? a : undefined
}

/**
 * 還沒信任時 ③ 要按的動作：手動派的就是剛按的那個，前提是它還派得出去（actionsFor 用同一個 heldOnRow 列它）；
 * 失敗後卡片改成派不出去了，跟自動流程派的一樣照「輪到你」取派工動作，沒有就說重新派工。
 * 自動流程派的照「這一步沒派出去」時的「輪到你」取派工動作：派工當下的快照還說「接著自動驗收」（沒有動作），所以算的時候把流程當成已停下；
 * 檢查失敗後派修正那種，state 是 failed，停下時一樣是繼續（g）。c 要是快照裡這件的樣子（跟面板同一份），不是派工用的 state 改成 ready 的複本。
 */
function untrustedAction(c: Case, hold: NonNullable<TurnCtx['hold']>, ctx: TurnCtx): ActionId | undefined {
  const held = hold.auto ? undefined : heldOnRow(c, hold.dispatch)
  if (held) return held
  const { hold: _, ...rest } = ctx
  const paused = c.chain && !c.chain.stopped ? { ...c, chain: { ...c.chain, stopped: UNTRUSTED_STOP } } : c
  const action = turnOf(paused, rest).action
  return action && DISPATCH_ACTIONS.has(action) ? action : undefined
}

/** ③ 要按的鍵：「輪到你」與派工當下的 toast、動態共用，兩邊說同一個鍵；沒有就說重新派工。 */
export function untrustedKey(c: Case, hold: NonNullable<TurnCtx['hold']>, ctx: TurnCtx = {}): string | undefined {
  const action = untrustedAction(c, hold, ctx)
  return action ? HOTKEY(action) : undefined
}

/**
 * 還沒信任：說三步，③ 是回面板要再按的鍵。排在執行中、等你、等回覆、等批准之後：那些比重派要緊，
 * 紀錄是這個對話自己的，別的對話派出 Agent 它不知道。
 */
function untrustedTurn(c: Case, hold: NonNullable<TurnCtx['hold']>, ctx: TurnCtx): BaseTurn {
  const action = untrustedAction(c, hold, ctx)
  return { who: 'you', text: untrustedSteps(c.root, action ? HOTKEY(action) : undefined), ...(action ? { action } : {}) }
}

/** 帶上動作的單鍵。 */
const keyed = (t: BaseTurn): Turn => (t.action ? { ...t, key: HOTKEY(t.action) } : t)

/** 教學那句的鍵對回動作：f 是填入決策，t 是教學的下一步。 */
const LESSON_ACTION: Partial<Record<string, ActionId>> = { f: 'fill', t: 'tutorial' }

/**
 * 輪到誰、該按什麼：句子照各段落算；句子指定的動作不在這一刻的 footer（stageActions）上就不帶，
 * 沒帶動作而卡片比分支舊（footer 上有同步）時帶同步。footer 帶頭的只看這裡的 action。
 */
export function turnOf(c: Case, ctx: TurnCtx = {}): Turn {
  const base = baseTurn(c, ctx)
  const listed = actionsFor(c, ctx, isHandling(c, ctx))
  const action = base.action && listed.has(base.action) ? base.action : base.who !== 'ai' && listed.has('sync') ? 'sync' : undefined
  return keyed({ who: base.who, text: base.text, ...(action ? { action } : {}) })
}

function baseTurn(c: Case, ctx: TurnCtx): BaseTurn {
  if (c.demo) return { who: 'none', text: '示範任務：只能看，照教學那件的指示操作' }
  if (c.state === 'nocard') return { who: 'none', text: '找不到卡片：確認登錄表裡的路徑' }
  if (ctx.launching) return { who: 'ai', text: '派工中，等 Agent 啟動' }
  if (ctx.agentQueued) return { who: 'ai', text: `派工排隊中（第 ${ctx.agentQueued} 位）：同時執行的 Agent 已達上限，有空位會自動派出` }
  // 教學：規格確認、合併、打 tag 用 t，決策寫回卡片；同時說實際使用時怎麼做。執行中、檢查中照一般的說法。
  const lesson = ctx.tutorial && !isRunning(c) && !ctx.verifying && !ctx.queued ? tutorialTurn(c) : null
  if (lesson) return { who: 'you', text: lesson.text, ...(lesson.key && LESSON_ACTION[lesson.key] ? { action: LESSON_ACTION[lesson.key] } : {}) }
  // 決策從面板送出了：等對話寫回卡片，不要再叫你按字母；回合結束卻沒寫回，說清楚怎麼辦。
  if (c.state === 'ask' && ctx.sent === 'waiting') return { who: 'ai', text: '決策已送出，等對話處理並寫回卡片' }
  if (c.state === 'ask' && ctx.sent === 'unwritten') return { who: 'you', text: '決策已送出，但卡片的「等你」沒有改：按 o 開卡片改掉，或重新選擇後按 f 再送一次', action: 'open' }
  // 等你沒有選項（例如請你登入）：直接說那句話，沒有字母可按、也沒有東西可填。
  if (c.state === 'ask') return hasChoice(c) ? { who: 'you', text: '按選項字母 → f 填入 → Enter 送出', action: 'fill' } : { who: 'you', text: c.ask }
  if (c.state === 'reply') return { who: 'you', text: '按 y 回覆 Agent 的提問', action: 'reply' }
  if (c.state === 'approve') return { who: 'you', text: approveText(c), action: 'logs' }
  // 處理中：標籤已經說了「不用動手」，這句只講誰在做什麼。
  if (ctx.verifying) return { who: 'ai', text: '測試在跑' }
  if (ctx.queued) return { who: 'ai', text: '測試排隊中' }
  // 看 Agent 本身：卡片停在關卡時 state 是 gate，Agent 照樣在跑，該按的鍵也都鎖著，不叫你按。
  if (isBusy(c)) return { who: 'ai', text: runningText(c) }
  if (c.manual) return { who: 'none', text: '手動任務：工作桌只追蹤，不派工' }
  if (ctx.hold) return untrustedTurn(c, ctx.hold, ctx)
  if (c.state === 'done') return isReleaseLine(c) ? { who: 'none', text: '已上線，等下一版開發' } : { who: 'you', ...(!ctx.tutorial && canArchive(c) ? archiveTurn(c) : { text: `輸入 ${CARD_CMD} archive ${slugOf(c)} 歸檔` }) }
  const hold = checkHold(c)
  if (hold && (c.state === 'failed' || c.pipeline?.current === 'check')) return hold
  // Agent 被停掉：原因本身就說了要做什麼，不是修一輪。
  if (c.state === 'failed' && c.chain?.stopped === AGENT_STOPPED) return { who: 'you', text: AGENT_STOPPED, action: 'continue' }
  // 額度煞車：原因已寫了額度、重置時間與接下來要做什麼，照原句；只有「按 g 重開」那種才標 g（解衝突被擋的叫你在對話處理）。
  if ((c.state === 'failed' || quotaHeld(c.chain)) && isQuotaHold(c.chain?.stopped)) return { who: 'you', text: c.chain!.stopped!, ...(c.chain!.stopped!.endsWith(QUOTA_RESTART) ? { action: 'continue' as const } : {}) }
  if (c.state === 'failed') return c.chain?.stopped
    ? { who: 'you', text: `流程已暫停（${c.chain.stopped}）：看審查檔（e）後按 g 再修一輪`, action: 'continue' }
    : { who: 'you', text: '測試未通過：按 g 讓 Agent 修正，或自己修好後按 v 重跑', action: 'continue' }
  const gate = parseGate(c.gate)
  if (gate?.kind === 'unknown') return { who: 'you', text: `關卡「${gate.detail}」：開卡片（o）處理`, action: 'open' }
  switch (c.pipeline?.current) {
    case 'spec':
      if ((gate?.kind === 'spec' || c.specGap) && c.agent) return { who: 'ai', text: runningText(c) }
      // 關卡是 spec 但認不到驗收情境：沒有東西可確認，叫你寫規格。
      if (gate?.kind === 'spec' && !c.specGap) return { who: 'you', text: `看過規格（o 開卡片）後按 t 確認並派實作（或輸入 ${CARD_CMD} spec ${slugOf(c)} ok）`, action: 'spec-ok' }
      if (c.specGap) return { who: 'you', text: `輸入 ${CARD_CMD} spec ${slugOf(c)} 寫驗收情境與實作計畫` }
      // 規格沒問題（或舊卡沒有規格段），停在這段只因為檢查欄空白、還是 `<…>` 範本佔位或說明文字：請人填一條真的指令。
      return { who: 'you', text: MISSING_CHECK, action: 'open' }
    case 'build':
      if (saysNone(c.next)) return { who: 'none', text: '閒置：卡片沒有下一步' }
      // 流程會自動接審查（autoReview）：檢查通過就派審查。不會（主對話開發、done 寫的下一步、別的對話開的流程）：v 只記結果，審查要再按 w。
      // 下一步是派審查：g 派的是繼續，不會審查；先 v 檢查，通過後 w（或流程自動接）。
      if (reviewNext(c.next)) return { who: 'you', text: `下一步是驗收：按 v 執行測試，通過後${willAutoReview(c) ? '自動驗收' : '按 w 派驗收'}`, action: 'verify' }
      if (idleNext(c.next)) return willAutoReview(c)
        ? { who: 'you', text: '下一步只剩等測試／驗收：按 v 執行測試，流程接著驗收；要改程式先把下一步寫成要做的事', action: 'verify' }
        : { who: 'you', text: '下一步只剩等測試：按 v 執行測試，通過後按 w 派驗收；要改程式先把下一步寫成要做的事', action: 'verify' }
      return { who: 'you', text: `按 g 派 Agent：${c.next}`, action: 'continue' }
    case 'check':
      if (checkStageFailed(c)) return { who: 'you', text: `流程已暫停（${c.chain!.stopped}）`, action: 'verify' }
      return { who: 'you', text: checkTurnText(c), action: 'verify' }
    case 'review':
      if (standingVerdict(c)) return { who: 'ai', text: '驗收有結論，接著自動修正或過關' }
      // 檢查剛通過、流程還沒派出審查（約兩秒）：不用你按 w。
      if (willAutoReview(c)) return { who: 'ai', text: '接著自動驗收' }
      return { who: 'you', text: reviewTurnText(c), action: 'review' }
    case 'merge': {
      const t = mergeTurn(c)
      return c.chain?.selfReview && t.who === 'you' ? { ...t, text: t.text + SELF_REVIEW } : t
    }
    case 'ship':
      return shipBase(c, !!ctx.tutorial)
    default:
      return { who: 'none', text: '沒有待辦' }
  }
}

export const PUBLISH_PR_TURN = '按兩次 n 開 PR 派 Agent push 並開 PR'
export const PUBLISH_PR_RISKY_TURN = '高風險改動：看過審查檔（e）後按兩次 n 開 PR 派 Agent push 並開 PR'
export const PUBLISH_PUSH_TURN = 'PR 開著又有新 commit：按兩次 n 派 Agent push，CI 過了再合併'

function mergeTurn(c: Case): BaseTurn {
  // 跟基準分支有衝突：先解衝突。這個對話的流程會自動派 Agent；不自動派的寫原因，在對話處理。
  if (c.conflict) {
    const why = catchupHold(c)
    return why ? { who: 'you', text: catchupHandTurn(c.conflict.into, why) } : { who: 'ai', text: catchupAutoTurn(c.conflict.into) }
  }
  // 帶開 PR：帶頭的是「⇡ 開 PR」，e 留在列上但變淡。
  if (needsPrConfirm(c)) return { who: 'you', text: PUBLISH_PR_RISKY_TURN, action: 'open-pr' }
  // push、開 PR 由 Agent 做（按兩次 n）。
  if (needsPr(c)) return { who: 'you', text: PUBLISH_PR_TURN, action: 'open-pr' }
  // PR 開著、分支又有新 commit：先 push，CI 才會跑在新 commit 上；這時叫你合併會合到舊的。
  if (needsPush(c)) return { who: 'you', text: PUBLISH_PUSH_TURN, action: 'push' }
  if (c.pr!.ci === 'pending') return { who: 'ai', text: 'PR 的 CI 在跑' }
  if (c.pr!.ci === 'fail') return { who: 'you', text: 'CI 失敗：開 PR（p）看原因後按 g 修正', action: 'pr' }
  return { who: 'you', text: `合併 PR #${c.pr!.id}（p 在瀏覽器開啟）；合併後打 tag 發版`, action: 'pr' }
}

/**
 * Agent 執行中或等批准：會跟它搶 worktree 或卡片的動作（檢查、確認規格、上線確認、歸檔）都鎖住。
 * 看 Agent 本身，不只看 state：卡片有關卡或等你時 state 是 gate／ask，Agent 照樣在跑；停著等回覆的不算。
 */
export const isBusy = (c: Case) => isRunning(c) || c.state === 'approve' || approvalWait(c.agent) || (!!runningKind(c) && !agentWaits(c.agent))

/** 上線確認只在最後一段：已經有 tag 包含這個 commit、關卡是 release：…（部署完由你按）。 */
export const canShip = (c: Case) => c.pipeline?.current === 'ship' && !!c.tag && parseGate(c.gate)?.kind === 'release'

/** 只有 desk 派出去、正在跑（含卡片停在關卡、等你有選項時）的那個才能從面板停止；名稱以 desk- 開頭才算 desk 派的。 */
export const canStop = (c: Case) => isBusy(c) && !!c.agent?.id && /^desk-/.test(c.agent.name)

/**
 * 「處理中」（輪到 AI 或機器）時 footer 只留不會派工、不會搶 worktree 的動作；測試在跑或排隊時另留「測試中」。
 * 派工中再少停止、取消排隊與填入：Agent 還沒啟動。其他收進「更多動作」（m）。
 */
const HANDLING: ReadonlySet<ActionId> = new Set<ActionId>(['stop', 'logs', 'open', 'unqueue', 'fill', 'review-file', 'pr'])
const LAUNCHING: ReadonlySet<ActionId> = new Set<ActionId>(['open', 'logs', 'review-file', 'pr'])

function handling(out: Set<ActionId>, isAi: boolean, ctx: TurnCtx): Set<ActionId> {
  if (!isAi) return out
  const keep = ctx.launching ? LAUNCHING : HANDLING
  return new Set([...out].filter(id => keep.has(id) || (id === 'verify' && !ctx.launching && (ctx.verifying || ctx.queued))))
}

/**
 * 這一刻該出現的動作：只列現在可以做、而且有意義的；footer（不按 m）照這個集合畫，不多不少。
 * 同步只在卡片落後分支時列（ctx.now 判斷）；平常收在「更多動作」（m）。派工鍵（繼續、審查、同步、回覆）另外跟 dispatchable 取交集。
 * 已經過了的段落不再出現它的鍵（檢查過了沒有 v、審查過了沒有 w）；之後有新 commit，六段會退回去，鍵也會回來。
 * 合併之後只列該段的主動作：沒打 tag 是發版與開卡片，有 release 關卡是上線確認與開卡片，可歸檔只剩歸檔；
 * 輸出、審查檔、PR 都收進 m（Agent 在跑時照舊能看輸出、停掉它）。「輪到你」是處理中時只留 HANDLING 那幾種。
 */
export function stageActions(c: Case, ctx: TurnCtx = {}): Set<ActionId> {
  return actionsFor(c, ctx, isHandling(c, ctx))
}

/**
 * 「輪到你」是不是「處理中」（turnOf 回 who: 'ai'）：派工中／派工排隊、決策已送出、測試在跑或排隊、Agent 在跑或等批准、
 * 規格段 Agent 在、驗收有結論、會自動驗收、CI 跑中、衝突自動解。順序跟 turnOf 一樣（前面先回 you 的不算），不看句子；
 * tests/turn-actions-gate.test.tsx 逐組比對它跟 turnOf 一致。
 */
export function isHandling(c: Case, ctx: TurnCtx = {}): boolean {
  if (c.demo || c.state === 'nocard') return false
  if (ctx.launching || ctx.agentQueued) return true
  if (ctx.tutorial && !isRunning(c) && !ctx.verifying && !ctx.queued && tutorialTurn(c)) return false
  if (c.state === 'ask') return ctx.sent === 'waiting'
  if (c.state === 'reply' || c.state === 'approve') return false
  if (ctx.verifying || ctx.queued || isBusy(c)) return true
  // 還沒信任的三步是輪到你（排在執行中之後，跟 baseTurn 同順序）。
  if (ctx.hold && !c.manual) return false
  if (c.manual || c.state === 'done' || c.state === 'failed') return false
  if (quotaHeld(c.chain) && isQuotaHold(c.chain?.stopped)) return false
  const gate = parseGate(c.gate)
  if (gate?.kind === 'unknown') return false
  switch (c.pipeline?.current) {
    case 'spec': return (gate?.kind === 'spec' || !!c.specGap) && !!c.agent
    case 'review': return !!standingVerdict(c) || willAutoReview(c)
    case 'merge':
      if (c.conflict) return !catchupHold(c)
      return !needsPr(c) && !needsPush(c) && c.pr?.ci === 'pending'
    default: return false
  }
}

function actionsFor(c: Case, ctx: TurnCtx, isAi: boolean): Set<ActionId> {
  if (c.demo) return new Set()
  // 派工排隊中：只能取消排隊或開卡片，有空位會自動派出。
  if (ctx.agentQueued) return new Set<ActionId>(['unqueue', 'open'])
  const busy = isBusy(c)
  const merged = isMerged(c) && !busy
  const out = new Set<ActionId>(merged && canArchive(c) ? [] : ['open'])
  const current = c.pipeline?.current ?? null
  // 派工鍵只列派得出去的；等你有決策時不列繼續（先回答決策）。
  const kinds = new Set<string>(dispatchable(c))
  const decides = c.state === 'ask' && parseDecisions(c.ask).length > 0
  const may = (k: 'continue' | 'review' | 'sync' | 'reply') => kinds.has(k) && !(k === 'continue' && decides)
  if (!merged) {
    if (c.agent?.id) out.add('logs')
    if (c.reviewTop?.length || riskyNoPr(c)) out.add('review-file')
    if (c.pr?.url) out.add('pr')
  }
  if (c.state === 'ask' && hasChoice(c) && ctx.sent !== 'waiting') out.add('fill')
  if (c.state === 'reply' && may('reply')) out.add('reply')
  // Agent 在跑或等權限批准：回覆放行不了工具；能做的只有看輸出、停掉它（desk 派的才能停）。
  if (busy) {
    if (canStop(c)) out.add('stop')
    return handling(out, isAi, ctx)
  }
  // 手動派工遇到還沒信任：剛按的那個留在列上，照三步回來才按得到（派不出去的照樣不列，③ 也不說它）。
  const held = ctx.hold && !ctx.hold.auto ? heldOnRow(c, ctx.hold.dispatch) : undefined
  if (held) out.add(held)
  if (!merged) {
    if (ctx.now !== undefined && cardBehind(c, ctx.now) && may('sync')) out.add('sync')
    const idleBuild = current === 'build' && !!idleNext(c.next)
    // 檢查失敗、PR 的 CI 失敗：「輪到你」叫你按 g 修正，g 要在列上（跟 dispatchable 同一個判斷）；本機已有新 commit 沒 push 時該按的是 ⇡ push，不列 g。
    if (((current === 'build' && !idleBuild) || fixByG(c)) && may('continue')) out.add('continue')
    if (c.verify && (current === 'check' || idleBuild || c.state === 'failed' || ctx.verifying || ctx.queued)) out.add('verify')
    // 自審的結論照算，但留著 w 讓你派獨立審查。
    if (((current === 'review' && !standingVerdict(c)) || (current === 'merge' && c.chain?.selfReview)) && may('review')) out.add('review')
    if (needsPr(c)) out.add('open-pr')
    if (needsPush(c)) out.add('push')
  }
  if (canShip(c)) out.add('ship')
  if (ctx.tutorial && tutorialStep(c)) out.add('tutorial')
  else if (!ctx.tutorial && awaitsSpecOk(c)) out.add('spec-ok')
  if (!ctx.tutorial && canArchive(c)) out.add('archive')
  if (!ctx.tutorial && canRelease(c)) out.add('release')
  return handling(out, isAi, ctx)
}

/** 按 m 展開時的一個動作：isLocked 是 Agent 在跑時鎖住（只列淡色文字、寫原因），isRetreat 是合併段退回前面段落的鍵。 */
export type ExpandedAction = { id: ActionId; isLocked?: boolean; isRetreat?: boolean }

/** 合併段退回前面段落的鍵：繼續、審查、檢查。 */
const RETREAT: ReadonlySet<ActionId> = new Set<ActionId>(['continue', 'review', 'verify'])

/** Agent 不在時的這件：執行中鎖住的確認規格、歸檔照原本的條件判斷要不要列（Agent 在跑時那兩個條件本來就不成立）。 */
function withoutAgent(c: Case): Case {
  const { agent: _running, ...rest } = c
  return c.state === 'running' || c.state === 'approve' ? { ...rest, state: finalState({ ...rest, state: 'ready' }) } : rest
}

/**
 * 按 m 展開全部動作時要畫的（照 ACTION_ORDER 排）：每個動作照它自己能不能做判斷，不看這一段；
 * Agent 在跑時會搶 worktree 或卡片的（檢查、上線確認、確認規格、歸檔）鎖住。合併段平常不列的退回鍵（繼續、審查、檢查）標 isRetreat；
 * 本段列了的（例如 CI 失敗時的繼續、自審的審查）不算退回。示範任務沒有動作；決策送出了、等對話寫回時不給填入，免得重送。
 */
export function expandedActions(c: Case, ctx: TurnCtx = {}): ExpandedAction[] {
  if (c.demo) return []
  const busy = isBusy(c)
  const idle = busy ? withoutAgent(c) : c
  const decides = c.state === 'ask' && parseDecisions(c.ask).length > 0
  const kinds = ctx.launching || ctx.agentQueued ? new Set<string>() : new Set<string>(dispatchable(c))
  const shown = new Map<ActionId, ExpandedAction>()
  const add = (id: ActionId, isLocked = false) => shown.set(id, isLocked ? { id, isLocked } : { id })
  if (c.state === 'ask' && hasChoice(c) && ctx.sent !== 'waiting') add('fill')
  if (ctx.agentQueued && !ctx.launching) add('unqueue')
  for (const k of ['continue', 'review', 'reply', 'sync'] as const) if (kinds.has(k) && !(k === 'continue' && decides)) add(k)
  if (!ctx.agentQueued && canStop(c)) add('stop')
  if (c.agent?.id) add('logs')
  if (c.reviewTop?.length || riskyNoPr(c)) add('review-file')
  if (c.pr?.url) add('pr')
  if (!ctx.tutorial && canRelease(c)) add('release')
  if (needsPr(c)) add('open-pr')
  if (needsPush(c)) add('push')
  // 已合併還沒上線：分支已進基準分支，展開全部也不列檢查。
  if (c.verify && !mergedUnshipped(c)) add('verify', busy)
  if (canShip(c)) add('ship', busy)
  if (!ctx.tutorial && awaitsSpecOk(idle)) add('spec-ok', busy)
  if (!ctx.tutorial && canArchive(idle)) add('archive', busy)
  if (ctx.tutorial && tutorialStep(c)) add('tutorial')
  add('open')
  const atMerge = c.pipeline?.current === 'merge' && !isMerged(c)
  // 退回看的是這一段本來的動作（沒經過「處理中」過濾）：CI 跑中時自審的審查、CI 失敗的繼續照樣算本段。
  const listed = atMerge ? actionsFor(c, ctx, false) : new Set<ActionId>()
  return ACTION_ORDER.flatMap(id => {
    const a = shown.get(id)
    if (!a) return []
    return [atMerge && RETREAT.has(id) && !listed.has(id) ? { ...a, isRetreat: true } : a]
  })
}

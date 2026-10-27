// 輪到誰、該做什麼：依六段與任務狀態產生一句給你看的話，以及這一刻該出現哪些動作。
// 卡片的「下一步」是寫給 Agent 的；這裡的句子才是寫給人的，現在卡最上方與摘要列都用它。
import type { Case, SentRecord } from '../types'
import { slugOf } from './model'
import { CARD_CMD, choiceCount, parseDecisions, parseGate, saysNone } from './card'
import { awaitsSpecOk, canArchive, isMerged, isReleaseLine, needsPr, needsPush, runningKind, standingVerdict } from './pipeline'
import { tutorialStep, tutorialTurn } from './tutorial'
import { AGENT_STOPPED, CHECK_CHANGED, CHECK_CHANGED_WHY, CHECK_UNAPPROVED, CHECK_UNAPPROVED_WHY } from './chain'
import { idleNext } from './dispatch'

export type Turn = {
  /** you：輪到你動手；ai：AI 或機器處理中，等著就好；none：沒有要做的事。 */
  who: 'you' | 'ai' | 'none'
  text: string
  /** 該按的那個鍵；footer 上對應的按鈕會亮。 */
  key?: string
}

/** 畫面上才知道的事：完成檢查執行中、排隊中、派工中、決策送出了沒，以及現在是不是教學模式。 */
export type TurnCtx = { verifying?: boolean; queued?: boolean; launching?: boolean; tutorial?: boolean; sent?: SentState }

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

export type ActionId = 'fill' | 'continue' | 'review' | 'sync' | 'reply' | 'stop' | 'logs' | 'review-file' | 'pr' | 'open-pr' | 'push' | 'verify' | 'ship' | 'open' | 'spec-ok' | 'archive' | 'tutorial'

const isRunning = (c: Case) => c.state === 'running'
const hasChoice = (c: Case) => choiceCount(parseDecisions(c.ask)) > 0
/** Agent 在跑時，依最後一次派的是什麼說它在做什麼。 */
const RUNNING_TEXT: Partial<Record<string, string>> = {
  continue: 'Agent 在寫程式（l 看輸出）', reply: 'Agent 在寫程式（l 看輸出）', fix: 'Agent 在修正（l 看輸出）',
  sync: 'Agent 在同步卡片（l 看輸出）', review: 'Agent 在審查 diff（新對話）', verify: '完成檢查在跑',
  publish: 'Agent 在 push、開 PR（l 看輸出）',
}

const runningText = (c: Case) => RUNNING_TEXT[runningKind(c) ?? c.chain?.lastKind ?? 'continue'] ?? RUNNING_TEXT.continue!

const SELF_REVIEW = '（審查是自審，可按 w 派獨立審查）'
/** 檢查欄空白、範本佔位或說明文字（verifyCommand 回空字串）時，規格段叫你填的那句。 */
const MISSING_CHECK = '卡片尚缺完成檢查：開卡片（o）在「檢查」欄填一條修之前會紅、修好會綠的指令'

// 派工（dispatch.ts）也要用，放在 pipeline.ts；這裡照舊匯出。
export { needsPr, needsPush }

/**
 * 流程停在檢查段（指令未核准、容器沒啟動、檢查中斷）：說為什麼，按 v；排除後跑完檢查，流程接著走。
 * 指令未核准的原因本身就說了要按什麼，直接用它。
 */
function checkHold(c: Case): Turn | null {
  const why = c.chain?.heldAtCheck ? c.chain.stopped : undefined
  if (!why) return null
  // 停下之後卡片的檢查被整條清掉：按 v 跑不了（只會說尚缺檢查），不再承諾核准；先叫你填檢查。
  if (!c.verify) return { who: 'you', text: MISSING_CHECK, key: 'o' }
  // 別的對話開的流程：這裡按 v 只會跑檢查、接不下去；說去哪裡接，或在這裡重開一輪。
  if (c.chain!.foreign) {
    const short = why === CHECK_CHANGED ? CHECK_CHANGED_WHY : why === CHECK_UNAPPROVED ? CHECK_UNAPPROVED_WHY : why
    return { who: 'you', text: `流程已暫停（${short}）：這個流程是別的對話開的，到那個對話按 v 才會接著走；或在這裡按 g 重開一輪`, key: 'g' }
  }
  const text = why === CHECK_CHANGED || why === CHECK_UNAPPROVED ? why : `流程已暫停（${why}）：排除後按 v 重跑檢查，流程接著走`
  return { who: 'you', text, key: 'v' }
}

/** 流程停住、檢查段因此標 ✕：說停住的原因，按 v 重跑檢查。 */
const checkStageFailed = (c: Case) => !!c.chain?.stopped && c.pipeline?.current === 'check' && c.pipeline.stages.some(s => s.id === 'check' && s.status === 'fail')

/**
 * 檢查通過後流程會自動派審查：流程是這個對話開的、最後一次派的是實作／回覆且還沒處理（autoReview），沒停下、沒過關。
 * 只有流程紀錄不夠：紀錄按資料夾永久保存，別的對話開的（foreign）或最後一次派的是同步，按 v 之後不會派審查。
 */
const willAutoReview = (c: Case) => !!c.chain?.autoReview && !c.chain.stopped && !c.chain.passed

/** 上線段該做的事：還沒打 tag 就打 tag；tag 打了、關卡是 release 就部署後按 u。面板合併後的下一步也用它。 */
export function shipTurn(c: Case): Turn {
  if (c.tag && parseGate(c.gate)?.kind === 'release') return { who: 'you', text: `部署 ${c.tag} 後按 u 確認上線`, key: 'u' }
  return { who: 'you', text: '打 tag 發版' }
}

export function turnOf(c: Case, ctx: TurnCtx = {}): Turn {
  if (c.demo) return { who: 'none', text: '示範任務：只能看，照教學那件的指示操作' }
  if (c.state === 'nocard') return { who: 'none', text: '找不到卡片：確認登錄表裡的路徑' }
  if (ctx.launching) return { who: 'ai', text: '派工中，等 Agent 啟動' }
  // 教學：規格確認、合併、打 tag 用 t，決策寫回卡片；同時說實際使用時怎麼做。執行中、檢查中照一般的說法。
  const lesson = ctx.tutorial && !isRunning(c) && !ctx.verifying && !ctx.queued ? tutorialTurn(c) : null
  if (lesson) return { who: 'you', ...lesson }
  // 決策從面板送出了：等對話寫回卡片，不要再叫你按字母；回合結束卻沒寫回，說清楚怎麼辦。
  if (c.state === 'ask' && ctx.sent === 'waiting') return { who: 'ai', text: '決策已送出，等對話處理並寫回卡片' }
  if (c.state === 'ask' && ctx.sent === 'unwritten') return { who: 'you', text: '決策已送出，但卡片的「等你」沒有改：按 o 開卡片改掉，或重新選擇後按 f 再送一次', key: 'o' }
  // 等你沒有選項（例如請你登入）：直接說那句話，沒有字母可按、也沒有東西可填。
  if (c.state === 'ask') return hasChoice(c) ? { who: 'you', text: '按選項字母 → f 填入 → Enter 送出', key: 'f' } : { who: 'you', text: c.ask }
  if (c.state === 'reply') return { who: 'you', text: '按 y 回覆 Agent 的提問', key: 'y' }
  // 處理中：標籤已經說了「不用動手」，這句只講誰在做什麼。
  if (ctx.verifying) return { who: 'ai', text: '完成檢查在跑' }
  if (ctx.queued) return { who: 'ai', text: '完成檢查排隊中' }
  if (isRunning(c)) return { who: 'ai', text: runningText(c) }
  if (c.manual) return { who: 'none', text: '手動任務：工作桌只追蹤，不派工' }
  if (c.state === 'done') return isReleaseLine(c) ? { who: 'none', text: '已上線，等下一版開發' } : { who: 'you', text: `輸入 ${CARD_CMD} archive ${slugOf(c)} 歸檔` }
  const hold = checkHold(c)
  if (hold && (c.state === 'failed' || c.pipeline?.current === 'check')) return hold
  // Agent 被停掉：原因本身就說了要做什麼，不是修一輪。
  if (c.state === 'failed' && c.chain?.stopped === AGENT_STOPPED) return { who: 'you', text: AGENT_STOPPED, key: 'g' }
  if (c.state === 'failed') return c.chain?.stopped
    ? { who: 'you', text: `流程已暫停（${c.chain.stopped}）：看審查檔（e）後按 g 再修一輪`, key: 'g' }
    : { who: 'you', text: '完成檢查未通過：按 g 讓 Agent 修正，或自己修好後按 v 重跑', key: 'g' }
  const gate = parseGate(c.gate)
  if (gate?.kind === 'unknown') return { who: 'you', text: `關卡「${gate.detail}」：開卡片（o）處理`, key: 'o' }
  switch (c.pipeline?.current) {
    case 'spec':
      if ((gate?.kind === 'spec' || c.specGap) && c.agent) return { who: 'ai', text: runningText(c) }
      // 關卡是 spec 但認不到驗收情境：沒有東西可確認，叫你寫規格。
      if (gate?.kind === 'spec' && !c.specGap) return { who: 'you', text: `看過規格（o 開卡片）後按 t 確認（或輸入 ${CARD_CMD} spec ${slugOf(c)} ok）`, key: 't' }
      if (c.specGap) return { who: 'you', text: `輸入 ${CARD_CMD} spec ${slugOf(c)} 寫驗收情境與實作計畫` }
      // 規格沒問題（或舊卡沒有規格段），停在這段只因為檢查欄空白、還是 `<…>` 範本佔位或說明文字：請人填一條真的指令。
      return { who: 'you', text: MISSING_CHECK, key: 'o' }
    case 'build':
      if (saysNone(c.next)) return { who: 'none', text: '閒置：卡片沒有下一步' }
      // 流程會自動接審查（autoReview）：檢查通過就派審查。不會（主對話開發、done 寫的下一步、別的對話開的流程）：v 只記結果，審查要再按 w。
      if (idleNext(c.next)) return willAutoReview(c)
        ? { who: 'you', text: '下一步只剩等檢查／審查：按 v 執行完成檢查，流程接著審查；要改程式先把下一步寫成要做的事', key: 'v' }
        : { who: 'you', text: '下一步只剩等檢查：按 v 執行完成檢查，通過後按 w 派審查；要改程式先把下一步寫成要做的事', key: 'v' }
      return { who: 'you', text: `按 g 派 Agent：${c.next}`, key: 'g' }
    case 'check':
      if (checkStageFailed(c)) return { who: 'you', text: `流程已暫停（${c.chain!.stopped}）`, key: 'v' }
      return { who: 'you', text: c.chain?.stale ? '審查後有新 commit：按 v 重新執行完成檢查' : '按 v 執行完成檢查', key: 'v' }
    case 'review':
      if (standingVerdict(c)) return { who: 'ai', text: '審查有結論，接著自動修正或過關' }
      // 檢查剛通過、流程還沒派出審查（約兩秒）：不用你按 w。
      if (willAutoReview(c)) return { who: 'ai', text: '接著自動審查' }
      return { who: 'you', text: c.chain?.stale ? '審查後有新 commit：按 w 重新審查（新對話）' : '按 w 派審查（新對話）', key: 'w' }
    case 'merge': {
      const t = mergeTurn(c)
      return c.chain?.selfReview && t.who === 'you' ? { ...t, text: t.text + SELF_REVIEW } : t
    }
    case 'ship':
      return shipTurn(c)
    default:
      return { who: 'none', text: '沒有待辦' }
  }
}

export const PUBLISH_PR_TURN = '按 ⇡ 開 PR 派 Agent push 並開 PR'
export const PUBLISH_PUSH_TURN = 'PR 開著又有新 commit：按 ⇡ push 派 Agent 推上去，CI 過了再合併'

function mergeTurn(c: Case): Turn {
  if (!c.pr && c.chain?.needsHuman) return { who: 'you', text: '高風險改動：看過資安審查（e）後再開 PR', key: 'e' }
  // push、開 PR 由 Agent 做：按鈕沒有快捷鍵，這句說按哪一顆。
  if (needsPr(c)) return { who: 'you', text: PUBLISH_PR_TURN }
  // PR 開著、分支又有新 commit：先 push，CI 才會跑在新 commit 上；這時叫你合併會合到舊的。
  if (needsPush(c)) return { who: 'you', text: PUBLISH_PUSH_TURN }
  if (c.pr!.ci === 'pending') return { who: 'ai', text: 'PR 的 CI 在跑' }
  if (c.pr!.ci === 'fail') return { who: 'you', text: 'CI 失敗：開 PR（p）看原因後按 g 修正', key: 'p' }
  return { who: 'you', text: '合併 PR（p 開啟）', key: 'p' }
}

/**
 * 這一刻該出現的動作：只列現在可以做、而且有意義的。開卡片永遠在；同步在沒有人執行、還沒合併時都在。
 * 已經過了的段落不再出現它的鍵（檢查過了沒有 v、審查過了沒有 w）；之後有新 commit，六段會退回去，鍵也會回來。
 * 合併之後只剩上線、歸檔、開卡片與 PR：不再繼續、審查、同步、檢查。
 */
export function stageActions(c: Case, ctx: TurnCtx = {}): Set<ActionId> {
  if (c.demo) return new Set()
  const out = new Set<ActionId>(['open'])
  const current = c.pipeline?.current ?? null
  if (c.agent?.id) out.add('logs')
  if (c.reviewTop?.length) out.add('review-file')
  if (c.pr?.url) out.add('pr')
  if (c.state === 'ask' && hasChoice(c) && ctx.sent !== 'waiting') out.add('fill')
  if (c.state === 'reply') out.add('reply')
  if (isRunning(c)) { out.add('stop'); return out }
  if (!isMerged(c)) {
    if (c.state !== 'done') out.add('sync')
    const idleBuild = current === 'build' && !!idleNext(c.next)
    if ((current === 'build' && !idleBuild) || c.state === 'failed') out.add('continue')
    if (current === 'check' || idleBuild || c.state === 'failed' || ctx.verifying || ctx.queued) out.add('verify')
    if (current === 'review' && !standingVerdict(c)) out.add('review')
    // 自審的結論照算，但留著 w 讓你派獨立審查。
    if (current === 'merge' && c.chain?.selfReview) out.add('review')
    if (needsPr(c)) out.add('open-pr')
    if (needsPush(c)) out.add('push')
  }
  if (current === 'ship') out.add('ship')
  if (ctx.tutorial && tutorialStep(c)) out.add('tutorial')
  else if (!ctx.tutorial && awaitsSpecOk(c)) out.add('spec-ok')
  if (!ctx.tutorial && canArchive(c)) out.add('archive')
  return out
}

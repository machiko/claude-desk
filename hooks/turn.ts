// 輪到誰、該做什麼：依六段與案子狀態產生一句給你看的話，以及這一刻該出現哪些動作。
// 卡片的「下一步」是寫給 Agent 的；這裡的句子才是寫給人的，現在卡最上方與摘要列都用它。
import type { Case } from '../types'
import { slugOf } from './model'
import { CARD_CMD, choiceCount, parseDecisions, parseGate, saysNone } from './card'
import { awaitsSpecOk, canArchive, isReleaseLine, runningKind, standingVerdict } from './pipeline'
import { tutorialStep, tutorialTurn } from './tutorial'

export type Turn = {
  /** you：輪到你動手；ai：AI 或機器處理中，等著就好；none：沒有要做的事。 */
  who: 'you' | 'ai' | 'none'
  text: string
  /** 該按的那個鍵；footer 上對應的按鈕會亮。 */
  key?: string
}

/** 畫面上才知道的事：完成檢查執行中、排隊中、派工中，以及現在是不是教學模式。 */
export type TurnCtx = { verifying?: boolean; queued?: boolean; launching?: boolean; tutorial?: boolean }

export type ActionId = 'fill' | 'continue' | 'review' | 'sync' | 'reply' | 'stop' | 'logs' | 'review-file' | 'pr' | 'open-pr' | 'verify' | 'ship' | 'open' | 'spec-ok' | 'archive' | 'tutorial'

const isRunning = (c: Case) => c.state === 'running'
const hasChoice = (c: Case) => choiceCount(parseDecisions(c.ask)) > 0
/** Agent 在跑時，依最後一次派的是什麼說它在做什麼。 */
const RUNNING_TEXT: Partial<Record<string, string>> = {
  continue: 'Agent 在寫程式（l 看輸出）', reply: 'Agent 在寫程式（l 看輸出）', fix: 'Agent 在修正（l 看輸出）',
  sync: 'Agent 在同步卡片（l 看輸出）', review: 'Agent 在審查 diff（新對話）', verify: '完成檢查在跑',
}

const runningText = (c: Case) => RUNNING_TEXT[runningKind(c) ?? c.chain?.lastKind ?? 'continue'] ?? RUNNING_TEXT.continue!

const SELF_REVIEW = '（審查是自審，可按 w 派獨立審查）'

/** 合併段還沒有可用的 PR：要你 push 並開 PR（高風險要先看過資安審查的不算）。 */
export const needsPr = (c: Case) => c.pipeline?.current === 'merge' && !(!c.pr && c.chain?.needsHuman) && (!c.pr || c.pr.state === 'DECLINED' || c.pr.state === 'SUPERSEDED')

/** 接力停住、檢查段因此標 ✕：說停住的原因，按 v 重跑檢查。 */
const heldAtCheck = (c: Case) => !!c.chain?.stopped && c.pipeline?.current === 'check' && c.pipeline.stages.some(s => s.id === 'check' && s.status === 'fail')

/** 上線段該做的事：還沒打 tag 就打 tag；tag 打了、關卡是 release 就部署後按 u。面板合併後的下一步也用它。 */
export function shipTurn(c: Case): Turn {
  if (c.tag && parseGate(c.gate)?.kind === 'release') return { who: 'you', text: `部署 ${c.tag} 後按 u 確認上線`, key: 'u' }
  return { who: 'you', text: '打 tag 發版' }
}

export function turnOf(c: Case, ctx: TurnCtx = {}): Turn {
  if (c.demo) return { who: 'none', text: '示範案子：只能看，照教學那件的指示操作' }
  if (c.state === 'nocard') return { who: 'none', text: '找不到卡片：確認登錄表裡的路徑' }
  if (ctx.launching) return { who: 'ai', text: '派工中，等 Agent 啟動' }
  // 教學：規格確認、合併、打 tag 用 t，決策寫回卡片；同時說實際使用時怎麼做。執行中、檢查中照一般的說法。
  const lesson = ctx.tutorial && !isRunning(c) && !ctx.verifying && !ctx.queued ? tutorialTurn(c) : null
  if (lesson) return { who: 'you', ...lesson }
  // 等你沒有選項（例如請你登入）：直接說那句話，沒有字母可按、也沒有東西可填。
  if (c.state === 'ask') return hasChoice(c) ? { who: 'you', text: '按選項字母 → f 填入 → Enter 送出', key: 'f' } : { who: 'you', text: c.ask }
  if (c.state === 'reply') return { who: 'you', text: '按 y 回覆 Agent 的提問', key: 'y' }
  // 處理中：標籤已經說了「不用動手」，這句只講誰在做什麼。
  if (ctx.verifying) return { who: 'ai', text: '完成檢查在跑' }
  if (ctx.queued) return { who: 'ai', text: '完成檢查排隊中' }
  if (isRunning(c)) return { who: 'ai', text: runningText(c) }
  if (c.manual) return { who: 'none', text: '手動案子：工作桌只追蹤，不派工' }
  if (c.state === 'done') return isReleaseLine(c) ? { who: 'none', text: '已上線，等下一版開發' } : { who: 'you', text: `輸入 ${CARD_CMD} archive ${slugOf(c)} 歸檔` }
  if (c.state === 'failed') return c.chain?.stopped
    ? { who: 'you', text: `接力已暫停（${c.chain.stopped}）：看審查檔（e）後按 g 再修一輪`, key: 'g' }
    : { who: 'you', text: '完成檢查未通過：按 g 讓 Agent 修正，或自己修好後按 v 重跑', key: 'g' }
  const gate = parseGate(c.gate)
  if (gate?.kind === 'unknown') return { who: 'you', text: `關卡「${gate.detail}」：開卡片（o）處理`, key: 'o' }
  switch (c.pipeline?.current) {
    case 'spec':
      if (gate?.kind === 'spec' && c.agent) return { who: 'ai', text: runningText(c) }
      if (gate?.kind === 'spec') return { who: 'you', text: `看過規格（o 開卡片）後按 t 確認（或輸入 ${CARD_CMD} spec ${slugOf(c)} ok）`, key: 't' }
      return { who: 'you', text: `輸入 ${CARD_CMD} spec ${slugOf(c)} 寫規格與完成檢查` }
    case 'build':
      if (saysNone(c.next)) return { who: 'none', text: '閒置：卡片沒有下一步' }
      return { who: 'you', text: `按 g 派 Agent：${c.next}`, key: 'g' }
    case 'check':
      if (heldAtCheck(c)) return { who: 'you', text: `接力已暫停（${c.chain!.stopped}）`, key: 'v' }
      return { who: 'you', text: c.chain?.stale ? '審查後有新 commit：按 v 重新執行完成檢查' : '按 v 執行完成檢查', key: 'v' }
    case 'review':
      if (standingVerdict(c)) return { who: 'ai', text: '審查有結論，接著自動修正或過關' }
      // 檢查剛通過、接力還沒派出審查（約兩秒）：不用你按 w。
      if (c.chain?.autoReview && !c.chain.stopped && !c.chain.passed) return { who: 'ai', text: '接著自動審查' }
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

function mergeTurn(c: Case): Turn {
  if (!c.pr && c.chain?.needsHuman) return { who: 'you', text: '高風險改動：看過資安審查（e）後再開 PR', key: 'e' }
  if (needsPr(c)) return { who: 'you', text: 'push 分支並開 PR' }
  if (c.pr!.ci === 'pending') return { who: 'ai', text: 'PR 的 CI 在跑' }
  if (c.pr!.ci === 'fail') return { who: 'you', text: 'CI 失敗：開 PR（p）看原因後按 g 修正', key: 'p' }
  return { who: 'you', text: '合併 PR（p 開啟）', key: 'p' }
}

/**
 * 這一刻該出現的動作：只列現在可以做、而且有意義的。開卡片永遠在；同步在沒有人執行時都在。
 * 已經過了的段落不再出現它的鍵（檢查過了沒有 v、審查過了沒有 w）；之後有新 commit，六段會退回去，鍵也會回來。
 */
export function stageActions(c: Case, ctx: TurnCtx = {}): Set<ActionId> {
  if (c.demo) return new Set()
  const out = new Set<ActionId>(['open'])
  const current = c.pipeline?.current ?? null
  if (c.agent?.id) out.add('logs')
  if (c.reviewTop?.length) out.add('review-file')
  if (c.pr?.url) out.add('pr')
  if (c.state === 'ask' && hasChoice(c)) out.add('fill')
  if (c.state === 'reply') out.add('reply')
  if (isRunning(c)) { out.add('stop'); return out }
  if (c.state !== 'done') out.add('sync')
  if (current === 'build' || c.state === 'failed') out.add('continue')
  if (current === 'check' || c.state === 'failed' || ctx.verifying || ctx.queued) out.add('verify')
  if (current === 'review' && !standingVerdict(c)) out.add('review')
  // 自審的結論照算，但留著 w 讓你派獨立審查。
  if (current === 'merge' && c.chain?.selfReview) out.add('review')
  if (needsPr(c)) out.add('open-pr')
  if (current === 'ship') out.add('ship')
  if (ctx.tutorial && tutorialStep(c)) out.add('tutorial')
  else if (!ctx.tutorial && awaitsSpecOk(c)) out.add('spec-ok')
  if (!ctx.tutorial && canArchive(c)) out.add('archive')
  return out
}

// 審查過關後自動開 PR（dispatch.json 的 autoPr）：決定開 PR、只 push 還是不派，以及動態與提示的字。
// 純函式；派推送 Agent 在 card-actions.ts 的 autoPublish，什麼時候問在 register.tsx 自動流程的過關那段。
import type { Case } from '../types'
import { isReleaseLine } from './pipeline'

/** open：還沒有 PR，push 並開 PR；push：PR 已開、分支領先遠端，只 push；skip：不派，why 是原因（空白＝沿用原本那句）。 */
export type AutoPrPlan = { kind: 'open' } | { kind: 'push'; pr: number } | { kind: 'skip'; why: string }

/**
 * autoPr 對這件管不管用：發版線（release/* 本身）不開 PR 也不查 PR，detached HEAD 沒有分支可推，跟沒開 autoPr 一樣。
 * 排隊的推送靠 queueRefusal 的合併段判斷擋掉，直接派的路徑沒有，所以在過關那段先擋。
 */
export const autoPrApplies = (c: Pick<Case, 'git'>) => !!c.git && !isReleaseLine(c) && c.git.branch !== 'HEAD'

/**
 * 過關時要不要自動派推送：高風險（needsHuman）照舊停下等你看；PR 被拒絕不自己重開；PR 已合併不再推；
 * PR 開著時分支領先才 push，否則等 CI 與合併；沒有 PR 就開。
 */
export function autoPrPlan(c: Pick<Case, 'pr' | 'gitState'>, needsHuman?: string): AutoPrPlan {
  if (needsHuman) return { kind: 'skip', why: '' }
  const pr = c.pr
  if (!pr) return { kind: 'open' }
  if (pr.state === 'DECLINED' || pr.state === 'SUPERSEDED') return { kind: 'skip', why: `PR #${pr.id} 已被拒絕，要重開請按 ⇡ 開 PR` }
  if (pr.state === 'MERGED') return { kind: 'skip', why: `PR #${pr.id} 已合併` }
  return (c.gitState?.ahead ?? 0) > 0 ? { kind: 'push', pr: pr.id } : { kind: 'skip', why: `PR #${pr.id} 已是最新，等 CI 與合併` }
}

/** 過關的動態（feed）與提示、系統通知（say）。沒有 plan（沒開 autoPr）時跟以前一字不差；skipped 是只動文件、免審查過關。 */
export function passWords(name: string, plan: AutoPrPlan | undefined, skipped = false): { feed: string; say: string } {
  const lead = skipped ? { feed: '只動文件、檢查通過，免審查', say: '只動文件，免審查' } : { feed: '審查通過', say: '審查通過' }
  const tail = !plan || (plan.kind === 'skip' && !plan.why) ? { feed: '，可開 PR', say: '，可以開 PR' }
    : plan.kind === 'open' ? '，自動派 Agent 開 PR'
    : plan.kind === 'push' ? `，自動派 Agent push 到 PR #${plan.pr}`
    : `，${plan.why}`
  const [feed, say] = typeof tail === 'string' ? [tail, tail] : [tail.feed, tail.say]
  return { feed: `${name} ${lead.feed}${feed}`, say: `${name}：${lead.say}${say}` }
}

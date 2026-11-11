// 審查過關後自動開 PR（dispatch.json 的 autoPr）：決定開 PR、只 push 還是不派，以及動態與提示的字。
// 純函式；派推送 Agent 在 card-actions.ts 的 autoPublish，什麼時候問在 auto-chain.ts 自動流程的過關那段。
import type { Case } from '../types'
import { isReleaseLine } from './pipeline'
import { t } from './i18n'

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
  if (pr.state === 'DECLINED' || pr.state === 'SUPERSEDED') return { kind: 'skip', why: t('autoPr.declined', { id: pr.id }) }
  if (pr.state === 'MERGED') return { kind: 'skip', why: t('autoPr.merged', { id: pr.id }) }
  return (c.gitState?.ahead ?? 0) > 0 ? { kind: 'push', pr: pr.id } : { kind: 'skip', why: t('autoPr.upToDate', { id: pr.id }) }
}

/** 怎麼過關的：審查通過、只動文件免審查、這條分支審查過而修正或新 commit 只跑測試（未複審）。 */
export type PassHow = 'reviewed' | 'skipped' | 'unreviewed'
const PASS_LEAD: Record<PassHow, { feed: string; say: string }> = {
  reviewed: { feed: t('autoPr.reviewed'), say: t('autoPr.reviewed') },
  skipped: { feed: t('autoPr.skippedFeed'), say: t('autoPr.skippedSay') },
  unreviewed: { feed: t('autoPr.unreviewedFeed'), say: t('autoPr.unreviewedSay') },
}

/** 過關的動態（feed）與提示、系統通知（say）。沒有 plan（沒開 autoPr）時跟以前一字不差。 */
export function passWords(name: string, plan: AutoPrPlan | undefined, how: PassHow = 'reviewed'): { feed: string; say: string } {
  const lead = PASS_LEAD[how]
  const tail = !plan || (plan.kind === 'skip' && !plan.why) ? { feed: t('autoPr.canOpenFeed'), say: t('autoPr.canOpenSay') }
    : plan.kind === 'open' ? t('autoPr.autoOpen')
    : plan.kind === 'push' ? t('autoPr.autoPush', { id: plan.pr })
    : t('autoPr.skipWhy', { why: plan.why })
  const [feed, say] = typeof tail === 'string' ? [tail, tail] : [tail.feed, tail.say]
  return { feed: t('feed.named', { name, text: `${lead.feed}${feed}` }), say: t('toast.named', { name, text: `${lead.say}${say}` }) }
}

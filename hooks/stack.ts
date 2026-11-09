// 疊放卡：開在另一張卡分支上的後續卡（卡片有「疊放於：<原卡分支>」）。原卡合併前不派工改程式，合併後才接著做。純函式。
import type { Case } from '../types'
import { isMerged } from './pipeline'

/**
 * 疊放卡還在等的原卡名：登錄表上找分支是「疊放於」那條的另一件，找得到又還沒合併才回它的名字。
 * 原卡已合併、找不到（歸檔、刪除、worktree 已移除）或這張不是疊放卡都回 undefined：不再等。
 */
export function stackWaitOf(c: Pick<Case, 'statusPath' | 'stackedOn'>, cases: readonly Pick<Case, 'statusPath' | 'name' | 'git' | 'pipeline' | 'demo'>[]): string | undefined {
  if (!c.stackedOn) return undefined
  const parent = cases.find(x => x.statusPath !== c.statusPath && !x.demo && x.git?.branch === c.stackedOn)
  return parent && !isMerged(parent) ? parent.name : undefined
}

/** 每件補上 stackWait（重新整理建好所有 case 之後）；沒有要等的照原物件。 */
export function withStackWait(cases: readonly Case[]): Case[] {
  return cases.map(c => {
    const wait = stackWaitOf(c, cases)
    return wait ? { ...c, stackWait: wait } : c
  })
}

/** 手動派工被擋、隊伍丟掉、確認規格沒派實作的原因：同一句。 */
export const stackWaitWhy = (name: string): string => `等原卡「${name}」合併`

/** 手動派工被擋時的下一步：原卡合併前沒有鍵可按；D-01：要先做就刪掉「疊放於」那行。 */
export const STACK_NEXT = '原卡合併後才能派；要先做就開卡片（o）刪掉「疊放於」那行'

/** 確認規格時被原卡擋下、這個對話記下了合併後自動派：toast 與動態的下一步。 */
export const STACK_AUTO_NEXT = '原卡合併後自動接著做'

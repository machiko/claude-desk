// 完成檢查的核准：按 g 派實作前，這張卡的檢查指令還沒核准過就先問；核准紀錄在 $.store（TRUST_KEY）。
// 從 register.tsx 搬出來（只搬不改）；吃 $ 的函式一律用 function 宣告。
import type { Case } from '../types'
import { TRUST_KEY } from './desk-io'

/** 這個對話核准過的完成檢查：卡片路徑 → 指令全文。 */
export async function trustedChecks($: any): Promise<Record<string, string>> {
  return ((await $.store.get(TRUST_KEY).catch(() => null)) as Record<string, string> | null) ?? {}
}

const APPROVE = '核准並派工'

/**
 * 按 g 開始一輪流程：這張卡的完成檢查還沒核准過（或指令改過），先問；做完實作會自動執行它，流程不用停下等你按 v。
 * 回傳能不能派：核准或早就核准過是 true；取消或關掉對話框是 false，什麼都不記。
 */
export async function approveCheck($: any, c: Case): Promise<boolean> {
  const trusted = await trustedChecks($)
  if (!c.verify || trusted[c.statusPath] === c.verify) return true
  const answer = await $.ui.ask(`在 ${c.root} 派實作。做完會自動執行這條完成檢查：\n${c.verify}\n核准後這張卡同一條指令不再問；不核准就不派工。`, { header: `${c.name} 核准檢查`, options: [APPROVE, '取消'] }).catch(() => '')
  if (answer !== APPROVE) return false
  await $.store.set(TRUST_KEY, { ...trusted, [c.statusPath]: c.verify })
  return true
}


// 完成檢查的核准：面板按兩次 v 或 g（第一次在檢查列列出全文），或確認規格時直接記下（trustCheck）。核准紀錄在 $.store（TRUST_KEY）。
// 吃 $ 的函式一律用 function 宣告。
import { atom, update } from 'claude-code'
import type { Case } from '../types'
import { TRUST_KEY } from './desk-io'

/**
 * 面板重繪用的核准紀錄（同 key 在 register.tsx 也宣告一次，引擎規定 read／update 的 atom 要同檔宣告）：
 * 每輪重新整理讀一次 store 放進來，這個對話核准時也一起更新；別的對話核准的要等下一輪重新整理才看得到。
 */
const trustedAtom = atom({ plugin: 'desk', key: 'trusted' } as const, {} as Record<string, string>)

/** 這個對話核准過的完成檢查：卡片路徑 → 指令全文。 */
export async function trustedChecks($: any): Promise<Record<string, string>> {
  return ((await $.store.get(TRUST_KEY).catch(() => null)) as Record<string, string> | null) ?? {}
}

/** 這張卡現在的檢查指令核准過了（沒有檢查就不用核准）。核准綁指令全文，指令改過就要重新核准。 */
export const isApproved = (trusted: Record<string, string>, c: Pick<Case, 'statusPath' | 'verify'>): boolean => !c.verify || trusted[c.statusPath] === c.verify

/** 對話指令（`/desk go`、`/desk verify`）遇到沒核准的檢查：不派、不跑、不彈框，說去面板按兩次。 */
export const unapprovedText = (c: Pick<Case, 'name' | 'verify'>): string =>
  `${c.name}：測試指令還沒經你核准，這次沒派工也沒跑測試；到面板按兩次 v（或 g）核准：${c.verify}`

/**
 * 核准檢查欄當時那條指令，記進同一份紀錄：確認規格（面板 t、對話 spec-ok、教學）與面板第二次按 v／g 都走這裡。
 * 核准綁指令全文，之後指令改過就要重新核准。檢查欄空白或 `<…>` 佔位（c.verify 是空字串）不記；回傳有沒有記。
 */
export async function trustCheck($: any, c: Case): Promise<boolean> {
  if (!c.verify) return false
  const trusted = await trustedChecks($)
  const next = { ...trusted, [c.statusPath]: c.verify }
  if (trusted[c.statusPath] !== c.verify) await $.store.set(TRUST_KEY, next)
  // 面板下一次重繪就顯示已核准，不等下一輪重新整理。
  await update($, trustedAtom, () => next)
  return true
}

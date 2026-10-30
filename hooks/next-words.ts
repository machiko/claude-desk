// 下一步的寫法判斷：只剩等待（檢查、審查、合併、PR、CI、確認）或派審查時，沒有要 Agent 做的事。
import { saysNone } from './card'

/** 「等…」可以等的事；檢查與審查前面可以有「重新」（審查過關後 `/desk:card done` 寫的「等自動重新檢查與審查」）。新詞「測試」「驗收」同樣認。 */
const IDLE_WAIT = '(?:(?:自動|完成)?(?:重新)?(?:檢查|測試)(?:結果|通過)?|(?:程式碼|資安)?(?:重新)?(?:審查|驗收)(?:結果|通過)?|審閱(?:結果|通過)?|合併|PR(?:\\s*#?\\d+)?(?:合併|通過)?|CI(?:\\s*通過)?|(?:你|使用者|[A-Za-z][\\w-]*)\\s*(?:確認|拍板|審閱|決定)?)'
/**
 * `/desk:card done` 寫的下一步「到面板按 v 執行完成檢查」，與審查過關後那句「等自動重新檢查與審查；沒動靜就到面板按 v」的後半
 * （與「按 v」的幾種寫法，含新詞「到面板按 v 執行測試」）：也是等檢查，不派 Agent。
 */
const IDLE_PRESS_V = '(?:沒動靜就\\s*)?(?:到面板\\s*)?按\\s*[vV](?:\\s*(?:執行|跑)?\\s*(?:(?:完成)?檢查|測試))?'
/** 「開 PR」，與審查過關、之後沒有新 commit 時 `/desk:card done` 寫的「到面板照「輪到你」開 PR 或合併」：照面板走，不派 Agent。 */
const IDLE_OPEN_PR = '(?:到面板\\s*)?(?:照\\s*「輪到你」\\s*)?開\\s*PR(?:\\s*或\\s*合併)?'
const IDLE_CLAUSE = new RegExp(`^(?:${IDLE_PRESS_V}|(?:過了|通過後?)\\s*開\\s*PR|${IDLE_OPEN_PR}|(?:等|待)\\s*${IDLE_WAIT}(?:\\s*(?:與|和|、|及)\\s*${IDLE_WAIT})*)$`)

/**
 * 派審查的寫法（「審查」換成新詞「驗收」一樣）：「（派）（獨立）審查」可接按鍵註記「（w）」或「：/desk review …」；整段是 `/desk review …`；「按 w（派審查）」。
 * 整段比對，「修正審查的 HIGH」不算；`/desk review` 後面的說明有修／補／改／寫／實作，是要改程式，也不算。
 */
const REVIEW_WORD = '(?:派|送|做|進行)?(?:獨立|重新|資安)?(?:審查|驗收)'
const REVIEW_CMD = '/desk\\s+review(?:\\s+(?!.*(?:修|補|改|寫|實作)).*)?'
const REVIEW_CLAUSE = new RegExp(`^(?:${REVIEW_WORD}(?:\\s*[（(]\\s*(?:按\\s*)?[wW]\\s*[）)])?(?:\\s*[:：]\\s*${REVIEW_CMD})?|${REVIEW_CMD}|按\\s*[wW](?:\\s*${REVIEW_WORD})?)$`)
export const REVIEW_NEXT = '下一步是驗收：先按 v 執行測試，再按 w 派驗收（g 派的是繼續，不會驗收）'
export const REVIEW_NEXT_AT_REVIEW = '下一步是驗收：按 w 派驗收（g 派的是繼續，不會驗收）'

const nextParts = (next: string) => next.split(/[；;]/).map(s => s.trim()).filter(Boolean)

/** 下一步至少一件是派審查、其他都是等檢查類：g 派的「繼續」不會審查，要先 v 再 w。 */
export function reviewNext(next: string): boolean {
  const parts = nextParts(next)
  return parts.some(p => REVIEW_CLAUSE.test(p)) && parts.every(p => REVIEW_CLAUSE.test(p) || IDLE_CLAUSE.test(p))
}

/** 下一步每一件都只是「等檢查／審查／合併／PR／CI／確認」或「開 PR」（或派審查）時，沒有要 Agent 做的事；回傳拒絕原因，否則空字串。 */
export function idleNext(next: string): string {
  if (saysNone(next)) return ''
  if (reviewNext(next)) return REVIEW_NEXT
  const parts = nextParts(next)
  return parts.length > 0 && parts.every(p => IDLE_CLAUSE.test(p))
    ? '下一步只剩等測試／驗收／開 PR，沒有要 Agent 做的事；要改程式先把下一步寫成要做的事'
    : ''
}

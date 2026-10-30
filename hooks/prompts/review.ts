// 審查（review）派工的提示詞：程式碼審查、資安審查、修正後的複審與重新審查。
import type { Case } from '../../types'
import { MAX_FIX_ROUNDS } from '../chain'
import type { ReviewWords } from '../dispatch'

export const REVIEW_FILE = '.task/REVIEW.md'
export const SECURITY_FILE = '.task/SECURITY.md'

/** 審查的參數：第幾輪、複審只看哪個 commit 之後、是不是資安審查、常犯錯誤清單與過去審查紀錄在哪。 */
export type ReviewOpts = { round: number; base?: string; /** 第一次審查的 diff 基準分支（例如 origin/main）；不知道就請審查自己找。 */ target?: string; security?: boolean; /** 審查通過後又有新 commit 的重新審查：只看 base 之後的 diff。 */ recheck?: boolean; pitfalls: string; history: string; /** 審查契約檔；沒給就用設定檔的 review.template。 */ template?: string }

/** 下一步以 .task/review-… 開頭時，那個路徑。 */
export function reviewTask(c: Case): string {
  const m = c.next.match(/^\s*(\.task\/review-[^\s（(]+\.md)/)
  return m ? m[1]! : ''
}

// 專案可以用 review.template 換掉契約檔，換了也要拿得到這條，所以放在提示裡。
const MEDIUM_RECORD = 'MEDIUM 分兩種：只關於規格紀錄、文件、命名、重複、註解、可維護性（改不改程式行為都一樣）的，在審查檔那條結尾標「（記錄、不修）」、不寫進卡片 等你，在卡片歷程記一筆「審查 MEDIUM n 條記錄、不修（摘要），見審查檔」；'
const MEDIUM_ASK = '在 等你 寫成「審查 MEDIUM n 條（摘要）怎麼處理：A) 不修，記錄原因 B) 修掉 C) 改規格」'
const MEDIUM_COUNT = '都算進關卡的 MEDIUM 數。'
/**
 * 還有修正輪數（工作桌派的審查都由流程接手）：可能影響行為的 MEDIUM 不加註記、不問，工作桌跟 CRITICAL／HIGH 一起自動派修正；
 * 要你決定才能處理的才標「（等你決定）」並問。輪數用完：這次不會自動修，可能影響行為的照舊標「（等你決定）」並問。
 */
function mediumRule(round: number): string {
  const decide = `審查檔那條結尾標「（等你決定）」並${MEDIUM_ASK}`
  return round < MAX_FIX_ROUNDS
    ? `${MEDIUM_RECORD}其他 MEDIUM（拿不準的也算可能影響行為）不加註記、不寫進 等你，工作桌會跟 CRITICAL／HIGH 一起自動派修正；要你決定才能處理的（驗收情境無法驗證、要改規格才能修）才${decide}。${MEDIUM_COUNT}`
    : `${MEDIUM_RECORD}其他 MEDIUM（拿不準的也算可能影響行為）這次不會自動修（修正輪數已用完）：${decide}。${MEDIUM_COUNT}`
}

/**
 * 重新審查的那段含把基準分支併進來的 merge commit（例如自動解衝突）時：基準分支帶進來的改動不審，
 * 看 merge commit 怎麼解衝突（--remerge-diff 只顯示解衝突的部分），其他照看分支自己的 commit。
 */
function mergedBase(base: string, target?: string): string {
  const into = target ? target.replace(/^origin\//, '') : '基準分支'
  return `這段含把 ${into} 併進來的 merge commit 時，${into} 帶進來的改動不審，改看 \`git log -p --remerge-diff --first-parent ${base}..HEAD\`（merge commit 只顯示衝突怎麼解，其他是分支自己的 commit）。`
}

export function reviewPrompt(c: Case, words: ReviewWords, r: ReviewOpts | undefined): string {
  const file = r?.security ? SECURITY_FILE : REVIEW_FILE
  // 「MEDIUM 不加註記」只在還有修正輪數時說：輪數用完時 mediumRule 要可能影響行為的標「（等你決定）」，兩句不能相反。
  const relist = r && r.round < MAX_FIX_ROUNDS ? '沒修好的照原樣再列（MEDIUM 不加註記）' : '沒修好的照原樣再列'
  const scope = r?.base && r.recheck
    ? `這是審查通過後又有新 commit 的重新審查：只看 \`git diff ${r.base}..HEAD\`。${mergedBase(r.base, r.target)}先讀現有 ${file} 當上一次結論，只判斷這段新 diff 有沒有問題、有沒有處理到上一次列的項目；上一次已列過且沒被改到的 MEDIUM／LOW 不要再提。`
    : r?.base && r.round > 0
    ? `這是修正後的複審（第 ${r.round} 輪）：只看 \`git diff ${r.base}..HEAD\`。先讀現有 ${file} 當上一輪結論，只判斷上一輪的 CRITICAL／HIGH 與沒加註記的 MEDIUM 有沒有修好、這段新 diff 有沒有新問題；${relist}，卡片 等你 已在問的那條標「（等你決定）」；上一輪已列過的 LOW 與標「不修」「等你決定」的項目不要再提。`
    : r?.target ? `看這個分支相對 ${r.target} 的 diff（從 git merge-base 起算）。` : '看這個分支相對它要併進去的分支的 diff（從 git merge-base 起算；先看 PR 目標，沒有就看 origin/HEAD）。'
  return [
    `${r?.security ? '資安審查' : '程式碼審查'}：這是新的對話，不接續 Agent、不參考 Agent 的結論。`,
    `契約：${reviewTask(c) || r?.template || words.template || 'templates/review.md'}。自己重跑完成檢查 \`${c.verify}\`。`,
    scope,
    ...(r?.pitfalls ? [`先讀專案常犯錯誤清單 ${r.pitfalls}，逐條對照這次的改動。`] : []),
    ...(r?.security ? [`資安審查只看：${words.security}；其他交給程式碼審查。`] : []),
    `問題分 CRITICAL（資安、資料外洩、資料毀損）、HIGH（${words.high}）、MEDIUM（可維護性）、LOW（風格）四級。每條寫成「- [等級][類別] 檔案:行 — 說明」，類別用短詞（例如 ${words.categories}）。寫進 ${file}（整份覆寫）。`,
    mediumRule(r?.round ?? 0),
    '最後把卡片 關卡 寫成這個格式，四個數字都要有：review：CRITICAL <n>、HIGH <n>、MEDIUM <n>、LOW <n>；<一句結論>',
    ...(r?.pitfalls && r.history ? [`審完後看 ${r.history} 裡過去的審查紀錄：這次某條發現的類別若過去已出現過、而清單沒有，在 ${r.pitfalls} 檔尾追加一行「- 類別：怎麼避免」。這是唯一可以寫的根目錄外檔案；不要改既有條目。`] : []),
    '不改程式、不 commit。',
  ].join('\n')
}

// 每次派工都附的卡片規則，與會改程式的派工多附的幾條（規格、CHANGELOG、測試、push）。
import type { Case } from '../../types'
import { named } from '../card'
import { slugOf } from '../model'

/**
 * 每次派工都附的規則；canPush（會改程式的派工與推送）可以 push 自己的分支、開 PR，其他的不寫遠端。
 * publishing（推送）不做實作，關卡與檢查留原樣。專案規則（dispatch.json 的 rules 與任務的 rules，由 dispatch.ts 先接好）接在最後。
 */
export function cardRules(user: string, projectRules: string[], canPush = false, doneRule = DONE_RULE): string[] {
  return [
    '卡片要精簡：狀態一句話 60 字內、下一步 40 字內，多件事用「；」分開；狀態只寫發生了什麼，不寫下一步，也不寫 commit 編號、AC／D 編號；commit、測試數字、檔案清單等細節寫在卡片下方的歷程，不要塞進這兩欄。',
    '卡片在 .desk/CARD.md（或 .console/STATUS.md）；結束這一輪前把五欄寫回，每欄一行。保留卡片既有的欄位名，不要改名：舊卡用「驗證」「等使用者」，新卡用「檢查」「等你」，工作桌兩種都讀得懂。',
    '寫入前重讀卡片；內容與你開始時讀到的不同就停止並回報衝突，不要覆寫。',
    '檢查欄只放一條可執行的完成檢查（反引號），exit 0 代表做完；發現寫在 狀態 或 .task/REPORT.md。',
    `要${named(user)}決定的事寫進 等你（有選項寫成 問題：A) … B) …）後結束這一輪，不要提問等待。`,
    doneRule,
    '只在此任務根目錄作業；不碰正式環境、不啟動或重建容器、不改 port、不在主工作區切分支。',
    canPush ? PUSH_RULE : NO_PUSH_RULE,
    ...projectRules,
  ]
}

/** 會改程式的派工（繼續、回覆、修正）多這一條：照規格做，審查會逐條對照驗收情境。 */
export const SPEC_RULE = '實作或修正前先讀卡片「## 規格」：非目標不要做；每條驗收情境（AC-n）都要做到，並有測試斷言到「則」那欄的結果，測試名稱照「對應測試」欄。規格做不到、互相矛盾或需要改，寫進 等你 後結束這一輪，不要自己改規格。有實作計畫時照「### 實作計畫」做，不用再停下來交計畫（規格確認時已一起確認）；實際改的檔跟計畫不同時在歷程寫明原因，要改範圍或做法寫進 等你。卡片沒有規格段就照下一步做。'

export const DONE_RULE = '做完實作：關卡留 無；完成檢查與審查由工作桌自動接手，你不用自己送審查。'

/** 會改程式的派工（繼續、回覆、修正）與推送可以 push 自己的分支、開 PR；寫遠端的範圍只到這裡。 */
export const PUSH_RULE = '可以 push 這件任務自己的分支（git push -u origin \u003c分支\u003e）並對基準分支開 PR；不 force push、不 push 到其他分支（main、release/* 等）、不合併 PR、不打 tag。push 或開 PR 後把分支頂端 commit 與 PR 網址寫進歷程。'
/** 同步與審查只讀不寫遠端。 */
export const NO_PUSH_RULE = '不 push、不開 PR。'

/** 會改程式的派工再多一條：CHANGELOG 條目寫片段檔，不碰 CHANGELOG.md（發版時由 card.py changelog 合併，分支之間才不會搶「## 未發布」）。 */
export const changelogRule = (c: Case) => `專案有 changelog.d/ 資料夾時，使用者看得到的改動寫成 CHANGELOG 條目放在 changelog.d/${slugOf(c)}.md（一行或多行「- 」開頭、動詞開頭：新增／修復／調整／移除，沒有標題與版本；沒有使用者看得到的改動就不建這個檔），不要改 CHANGELOG.md，發版時才合併。沒有這個資料夾就照專案原本的慣例。`

/**
 * 會改程式的派工再多一條：改的過程只跑相關測試、收尾跑一次完成檢查。整套測試很慢，好幾個 Agent 同時反覆跑會把機器拖垮、測試逾時重跑。
 * 審查照舊自己重跑完成檢查，不加這條。
 */
export const testRule = (c: Case) => {
  const check = c.verify ? `完成檢查 \`${c.verify}\`` : '卡片「檢查」欄的完成檢查'
  return `改程式的過程中只跑跟這次改動有關的測試（目標測試或相關的測試檔），不要每改一次就跑整套；收尾 commit 前跑一次${check}。沒過時只修失敗的部分、只重跑失敗的那幾支，修好再跑一次完成檢查；做完後工作桌還會自動再跑一次。`
}

# 格式版本

desk 讀寫三種檔：卡片、`dispatch.json`、登錄表。每種各有一個格式版號，寫在檔案裡的標記；舊版 desk 讀到比自己認得的新的格式時，會說「請更新 desk」，不會默默讀錯或寫壞。

## 目前的格式

| 檔案 | 目前格式 | 標記長相 | 程式裡的常數 |
| --- | --- | --- | --- |
| 卡片（`.desk/CARD.md`） | 1 | DESK 區塊開頭標記 `<!-- DESK 格式=1：工作桌只讀這個區塊。… -->` | `CARD_FORMAT` |
| `dispatch.json` | 1 | 頂層 `"format": 1` | `SETTINGS_FORMAT` |
| 登錄表（`projects-scope.md`） | 1 | 第一行標題下一行 `<!-- desk 登錄表 格式=1 -->` | `REGISTRY_FORMAT` |

- 常數在 `hooks/formats.ts` 與 `skills/card/scripts/card.py` 各一份，數字要跟上表一樣；`scripts/tests/test_formats_doc.py` 核對兩端、這份文件、卡片模板與空登錄表的標記，不一致就失敗。
- 沒有標記的檔一律當格式 1：升級前開的卡、舊的 `<!-- CARD -->` 卡、沒寫 `format` 的設定、既有的登錄表都照常讀寫，desk 不會自動補標記。
- 標記只認開頭標記裡的「格式=n」（`=` 全形半形都可，前後可有空白）；開頭標記的其他文字照舊，區塊與表格的解析不變。

## 讀到較新的格式時

| 檔案 | 面板 | `/desk:card` |
| --- | --- | --- |
| 卡片 | 動態警告一次（寫卡名、請更新 desk）；這張卡照常顯示，不自動派工，手動派工與回覆也拒絕 | 會寫卡的子指令（spec-init、gate、spec-ok、done、archive）不改檔、結束碼非 0；card、read、overlap 照常 |
| `dispatch.json` | 走設定檢查：動態指出檔名、說明是較新版 desk 的設定；認得的鍵照常套用，新版多的鍵列在「認不得的鍵」 | 照常讀認得的鍵 |
| 登錄表 | 動態警告一次；照常讀表格列 | 照常讀寫 |

同一份檔、同一個版號只報一次；報過的紀錄跟動態一起在教學開始／結束清掉，之後會再報一次。`/desk off` 不清動態，紀錄也留著，重開 `/desk` 不再報。

## 升格式版號的時機

只有舊版 desk 讀了會讀錯或寫壞時才升：例如改欄位名、改區塊結構、改某個鍵的意思。只是多一個欄位或多一個鍵（舊版略過也不出錯）不用升。升的時候同一個 PR 要：

1. 改兩端的常數與上表。
2. 改模板或空登錄表的標記（卡片、登錄表），或文件裡的 `format` 範例（`dispatch.json`）。
3. 在下面的舊格式清單加一條「格式 n 的寫法」，寫明在哪裡處理、何時可以拿掉。

## 舊格式清單

desk 還認得、但新檔不再這樣寫的舊寫法。目前都還分散在各模組，沒有收進同一處；「何時可以拿掉」是建議，拿掉前先確認沒有還在用的舊卡或紀錄。

| 舊寫法 | 在哪裡處理 | 何時可以拿掉 |
| --- | --- | --- |
| 舊卡 `.console/STATUS.md` 與 `<!-- CARD -->` 區塊 | `hooks/card.ts` 的 `parseCard`、`projectRoot`；`card.py` 的 `CARD_FILES`、`CARD_BLOCK`、`card_root` | 所有專案的 CARD 卡都歸檔或改成 DESK 卡之後 |
| 舊欄名「驗證」「等使用者」 | `hooks/card.ts` 與 `card.py` 的 `FIELD_ALIAS`；派工提示 `hooks/prompts/rules.ts` 叫 Agent 保留舊欄名 | 同上（只有 CARD 卡用舊欄名） |
| 舊卡「更新」欄的 rev（每次寫入加 1） | `hooks/card.ts` 的 `confirmShip`；`card.py` 的 `set_fields` | 同上 |
| 自訂模板的卡名佔位 `<案名>`（0.24.0 以前） | `card.py` 的 `LEGACY_NAME_SLOT` | 確認沒有人的 `card.template` 還寫 `<案名>` 之後 |
| DESK 卡沒有「基準」欄 | `hooks/model.ts` 的 `cardBaseOf`（沒有就用 `card.base` 與 PR 目標） | 不拿：沒有這欄本來就是合法的 |
| spec-ok 的 History 舊寫法「規格確認，關卡清為無，可派實作」 | `hooks/touch.ts` 的 `SPEC_OK_HISTORY` | 舊寫法的卡都歸檔之後 |
| History 只寫日期、沒有時間 | `hooks/extras.ts` 的 `historyEntries`；`hooks/pane.tsx` 歷程時間欄 | 只寫日期的卡都歸檔之後 |
| 卡片規則段跟目前模板不同（模板改版前開的卡） | `hooks/card-rules.ts`、`hooks/prompt-sync.ts`：規則段沒動就不拿新模板比 | 不拿：模板會一直改版 |
| 審查 MEDIUM 在「等你」問 A～D（MEDIUM 一律記錄之前） | `hooks/card.ts` 的 `picksMediumFix`／`picksMediumFollowUp`（認答案）；`hooks/prompt-sync.ts` 的 `noteMediumFix`（記下選了修掉）；`hooks/auto-chain.ts` 的 `fixPickedMedium`（派修正）；`hooks/prompts/review.ts` 的 `MEDIUM_ASK_FORM`、`OLD_ASKED_KEEP`、`RECHECK_ASKED` | 有這種題目的卡都歸檔之後 |
| 流程紀錄沒有版本號 `rev` | `hooks/chain.ts`（視為 0） | 不拿：寫回一次就補上 |
| 流程紀錄的 `mediumFix`（MEDIUM 還會自動修時） | `hooks/auto-chain.ts` 寫回時拿掉；`hooks/chain.ts` 型別 | 所有對話的流程紀錄都寫回過一次之後 |
| 流程紀錄沒有 `fixTotal` | `hooks/chain.ts` 的 `fixTotalOf`（用這一輪的 round） | 同上 |
| 流程紀錄存分支名稱當 HEAD（0.21.1 以前） | `hooks/pipeline.ts` 的 `movedSince`；`hooks/dispatch-runner.ts` 審查基準 | 0.21.1 以前的流程紀錄都換過之後 |
| 流程紀錄沒記分支 | `hooks/chain.ts` 的 `seenHeads` 等（不認，退回整條分支） | 同上 |
| 流程停下原因存成中文句（改存代碼之前，含換詞前的完成檢查核准句） | `hooks/stop-reason.ts` 的 `LEGACY_RENAMED`、`LEGACY_FIXED`、`LEGACY_PATTERNS`（讀時還原成代碼，不回寫） | 存著舊句的流程紀錄都重開過之後 |

`$.store` 裡的流程紀錄不帶格式版號，這次不處理；上表只列出還認得的舊欄位。

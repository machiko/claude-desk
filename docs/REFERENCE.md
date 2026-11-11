# desk 參考手冊

已經會用 desk、要查完整的指令、按鍵、面板細節與設定時看這份；第一次用先看 [README](../README.md)，流程與規則見 [WORKFLOW](WORKFLOW.md)。

## 選用工具

- 選用：讀 PR 與 CI——GitHub 的 repo 用 [`gh`](https://cli.github.com/)（要先 `gh auth login`，desk 自己只執行 `gh pr list`）、Bitbucket 的 repo 用 Bitbucket MCP 伺服器（desk 自己只呼叫 `bb_get`）；都沒有時合併改看 git。合併段派出的推送 Agent 開 PR 也看 origin：GitHub 用 `gh pr create`、Bitbucket 用 MCP 的 `bb_post`（這一種派工會載入 MCP）、其他平台只 push 並把開 PR 的網址寫進「等你」，或在專案 `dispatch.json` 設 `pr.open` 指定指令。`docker compose`（完成檢查前確認容器）。

## 指令

| 指令 | 作用 |
|---|---|
| `/desk` | 開啟面板並把鍵盤焦點移過去；第一次會開始定時更新 |
| `/desk close` | 收起面板（也可以點摘要列的「⌗ desk」；面板裡按 Esc 只回輸入框、面板留著） |
| `/desk refresh` | 立刻重讀 |
| `/desk go\|sync\|review <任務名>` | 派工：繼續（開始一輪流程；完成檢查還沒核准過就不派、回一句請你到面板按兩次 `g` 核准，走過 spec 確認的卡不用再核准）、同步、審查 |
| `/desk reply <任務名> [回覆]` | 回覆停下來問的 Agent |
| `/desk verify <任務名>` | 執行卡片的完成檢查（只跑核准過的指令；還沒核准就回一句請你到面板按兩次 `v`） |
| `/desk open <任務名>` | 用系統預設程式開卡片 |
| `/desk bar` | 收起／顯示摘要列 |
| `/desk update` | 把 desk 自己更新到 GitHub 上的最新版本（面板 footer 有新版時的「⇡ 更新到 <版本>」、沒查過時的「⇡ 檢查並更新」按鈕相同，只用點的、不綁快捷鍵；已是最新只顯示「✓ 已是最新版本」字樣，要重查就用這個指令）；更新後自動重新載入（不行就預填 `/reload-plugins`）；desk 自己發版後，工作桌會在回合結束自動跑一次 |
| `/desk tutorial` | 教學：在沙盒裡把六段走一遍，旁邊配幾件示範任務（`/desk tutorial end` 結束並刪除沙盒） |
| `/desk off` | 這個對話關閉工作桌 |
| `/desk:card new <分支> <卡名> [base] [--trivial]` | 建 worktree、DESK 卡、登錄表列；`--trivial`：瑣事卡，規格只寫一句、免前審，細節見 /desk:card |
| `/desk:card spec <目標> [需求]` | 產生規格草稿並設 `spec：` 關卡；`… ok` 確認（實作計畫跟其他進行中的卡同檔時一併預警） |
| `/desk:card overlap <slug>` | 列出實作計畫跟登錄表上其他進行中的卡同檔的檔案（`同檔預警：…`，沒有就印「無」） |
| `/desk:card done <slug> <狀態一句>` | 主對話告一段落時寫回卡片：狀態、下一步（平常是到面板按 v；依審查修完、關卡寫「未複審」的是到面板照「輪到你」接著做；驗收過關後有新 commit 是等自動重新測試，沒動靜就按 v；驗收過關後沒有新 commit 是照面板開 PR 或合併），History 記一筆「<人>：<狀態> → <結果>（commit <HEAD>）」；規格沒確認會拒絕 |
| `/desk:flow` | 在主對話（不派 Agent）走六段的說明：每段對話做什麼、面板怎麼看得到，末尾附一行 CLAUDE.md 規則 |
| `/desk:release <卡名與 PR>（<清理對象>）` | 發版規則：按兩次 z（「⚑ 發版」）填的就是這行，帶「已在面板確認」段就不出題、照慣例版號依序發版到 CI 通過再清理；手打的或判斷不了版號才出一題 A／B／C 寫進那幾張卡的「等你」；失敗就停 |
| `/desk:card archive <slug>… [--cleanup]` | 卡、審查檔與 .task 的計畫／報告複製到歸檔資料夾、登錄表移到已歸檔段（不刪 worktree）；發版時帶 `--cleanup` 再移除已合併又乾淨的 worktree 與分支（`git worktree remove`、`git branch -d`），保留的寫進登錄表「## 提醒」 |
| `/desk:card changelog <版本>` | 發版：把 `changelog.d/*.md` 片段合併成 CHANGELOG.md 的 `## <版本>` 段並刪掉片段檔（在要發版的那份 main 執行：主 repo，照「⚑ 發版」流程時是從 origin/main 開的暫存 worktree；沒有片段、版本段已存在、片段格式錯都不改檔） |
| `/desk:card emit\|read\|wait\|send <目標> …` | 跨 Agent 協作：`emit` 推播 Agent 狀態（面板即時看得到外部 Agent 在跑或卡住）、`read` 讀任務的 Agent 輸出或審查檔等產物、`wait` 等任務到某個狀態、`send` 在任務 worktree 啟動另一個 Agent（`claude`、`agy` 或任意指令）；參數見 [/desk:card](../skills/card/SKILL.md) |

焦點：`/desk` 或 ctrl+x tab 移到面板；面板裡按 Esc（或 ctrl+x tab）回輸入框，面板留著。面板裡按 `i` 看完整快捷鍵。

| 鍵 | 作用 |
|---|---|
| 1–9 | 選任務：清單照開卡順序（登錄表順序）列出全部任務，狀態或卡片改了也不跳動，數字固定不因選取或狀態而換號，選中的那件以 `▸` 開頭並反白，現在卡標題寫「現在 · 你選的」。選了的那件是對話的主角：之後你打的每則都附上它的卡，摘要列標「已選」；點現在卡的任務名不會有動作，要取消選取，點「現在 · 你選的」那列的「✕ 取消選取」，或按 `m` 展開更多動作、點「✕ 取消選取」 |
| a b c d、f | 選決策選項、填入輸入框；送出後那題鎖住，等對話寫回卡片 |
| g／w／s | 繼續／驗收／同步（**按兩次確認**，確認文字寫出模型與 effort）；同步平常收在 `m` 更多動作，卡片落後分支時才出現在 footer |
| y | 回覆停下來問的 Agent |
| k | 停止 desk 派出去的 Agent（按兩次確認；對話保留） |
| l | 展開 Agent 最近 10 行輸出 |
| v | 測試；指令還沒核准（或改過）時按兩次，第一次在測試列列出全文，第二次核准並執行，不跳對話框；流程停在測試段（指令改過、容器沒啟動、測試中斷）時，跑完流程接著走 |
| u | 上線確認：有 tag 包含這個 commit、關卡是 `release：…` 時才出現；按兩次清關卡、記 History 並歸檔（worktree 與分支保留；發版線與教學那件只清關卡） |
| o／e／p | 開卡片／審查檔／PR；合併之後 footer 只列該段的主動作（沒打 tag：⚑ 發版與開啟；有 `release：` 關卡：上線確認與開啟；可歸檔：只剩 ⌫ 歸檔），輸出、審查檔、PR 收進 `m` |
| ⇡ 開 PR／⇡ push | 合併段才出現、快捷鍵 `n`，**按兩次確認**：派推送 Agent push 分支並對基準分支開 PR，或 PR 已開時只 push（不合併、不打 tag）。專案設了 `autoPr` 時驗收過關會自動派，按鈕照樣可用 |
| ⚑ 發版 | 上線段、還沒打 tag 時出現、快捷鍵 `z`，按兩次（第二次就算同意照慣例版號）把一行 `/desk:release …` 短請求（所有待發版的卡名與 PR、發版後要歸檔並移除 worktree 與分支的卡；有 `release：` 關卡的卡改由按 `u` 歸檔）填入輸入框；Enter 送出後對話照 [`/desk:release`](../skills/release/SKILL.md) 的規則做（帶確認段就不出題照做到底；判斷不了版號才出題；失敗處理都寫在那裡），desk 自己的發版步驟見 [docs/WORKFLOW.md](WORKFLOW.md)。面板不打 tag、不 push |
| ⌫ 歸檔 | 可歸檔時出現、快捷鍵 `q`，**按兩次確認**：卡、審查檔與 .task 的計畫／報告複製到歸檔資料夾、登錄表移到已歸檔段（不刪 worktree 與分支） |
| t | 確認規格：停在 `spec：…` 關卡、沒有 Agent 在跑時出現，按兩次（同 `/desk:card spec <slug> ok`），確認後自動派實作（確認同時核准檢查欄的指令，不再多問；「等你」有事、manual、worktree 有別人的改動時只確認不派；疊放卡等原卡合併後才派；Agent 已滿就排隊）；教學模式則是下一步（確認規格、合併、打 tag，按一次） |
| x／m／i | 展開全文（歷程每筆換行看全文）／更多動作／說明 |
| r | 重新整理（在 `m` 更多動作裡；平常定時、每回合結束、對話改了卡片或跑了 git 之後都會自動重讀） |

## DESK 卡

每件任務一張 `.desk/CARD.md`，工作桌只讀這個區塊：

```
<!-- DESK -->
- 狀態：一句話
- 檢查：`一條指令，exit 0 代表做完`
- 等你：無 | 問題：A) … B) …；問題二：1) … 2) … | 一句沒有選項的話（只顯示，不填入）
- 下一步：一件事
- 關卡：無 | spec：… | review：CRITICAL n、HIGH n、MEDIUM n、LOW n；結論 | release：…
<!-- /DESK -->
```

完整模板在 [templates/DESK-template.md](../templates/DESK-template.md)，包含「## 規格」（目標、非目標、驗收情境表）。舊格式 `<!-- CARD -->`（欄位「驗證」「等使用者」）也讀得懂。

## 面板

- **輪到誰**：現在卡第二列一定是 **▶ 輪到你**（後面寫要按什麼或輸入什麼）、**◐ 處理中**（AI 或機器在做，等著就好）或 **— 沒有待辦**。摘要列用同一句。
- **只列能做的動作**：實作段只有 `g`、測試段只有 `v`、驗收段只有 `w`、上線段只有 `u`；已經過了的段落不再出現它的鍵。`m` 展開全部動作。
- **輪到你的鍵在 footer 帶頭**：「▶ 輪到你」叫你按的鍵，一定是 footer 上帶頭的那顆。Agent 或測試處理中時，footer 只留停止、輸出、開卡片這類不會派工的動作，其他收在 `m`。
- **header／content／footer**：header 與 footer 常駐，只有中間捲動（滾輪、↑ ↓ PageUp PageDown）。寬 100 欄以上時現在卡與進度表左右並排。
- **六段圖示**：● 已過、◉ 進行中、◆ 等你、✕ 卡住、○ 未到、· 不適用；上線確認後六個 ● 轉綠、狀態是 ✓「已上線」。
- **狀態計數**：「全部任務」標題列右邊列各狀態幾件（例如「● 2 ◆ 1 ▶ 1 ○ 3」），依等你、關卡、失敗、進行中、待辦、閒置排序，0 件的不列；等回覆、等批准併進等你的 ●，教學的示範任務不算。標題列同一列放不下時（任務名長，或寬版並排時清單那欄只有 49–64 格），計數改接在「全部任務」後面、六段欄名另起一列。
- **還有幾件等你**：現在卡上方的「現在 · 自動挑選」後面寫「另有 n 件等你」（現在卡以外的等你、等回覆、等批准、關卡、失敗）；只有現在卡在等你時不寫。
- **你選的那件**：按數字鍵選了任務時，區段標題寫「現在 · 你選的」＋「<任務名> · 之後每則對話都附上它的卡」與「✕ 取消選取」按鈕（只用點的；「更多動作」裡也有一顆）。放不下時由寬到窄退讓、不截字：先省掉提示字只留任務名與按鈕，再只留按鈕（寬版並排時現在卡那欄只有 46–61 格）。
- **任務名太長**：進度表有任務名在欄位版會被截掉時，不列六段的欄名，每列六段縮成連續六個圖示，讓名字完整顯示。
- **卡片可能過期**：分支最近一次 commit 改到的程式（只改卡片的 commit 不算）比卡片新、又沒有 Agent 在跑時，現在卡提示「按 s 同步」，footer 也才列出「↻ 同步」（這一段沒有別的該按的鍵時它帶頭）。先寫卡、測試跑完才 commit 的不算過期。
- **提醒**：登錄表「## 提醒」段 `- YYYY-MM-DD 事項` 到期前三天出現；`- 事項` 不寫日期時一直列在面板。面板上收成一列（多件寫「提醒 n 件 · 第一條」），按 `m` 展開全文（最多 4 列，其餘寫「還有 k 件」）。打勾 `[x]`、劃掉 `~~…~~`、縮排子項目與日期格式不對的行不算提醒。
- **歷程**：現在卡下方列出這件卡片「## History」的全部歷程，新的在前，每筆「MM-DD HH:MM  內容」一行（太長截斷，按 `x` 換行看全文）；比畫面高時捲動中間的內容看。History 行寫成 `- YYYY-MM-DD HH:MM：…`（`/desk:card spec ok`、`/desk:card done`、按 `u` 上線確認與卡片範本都這樣寫）；舊卡只寫日期的照樣顯示「MM-DD」、時間留白。
- **總執行時間**：卡片頭一列寫「總執行 N 分」（Agent 每次派工加上自動測試，已結束的加上正在跑的；等你回答與主對話的時間不算，換分支從 0 起算）。超過 15 分改寫「（超過 15 分）」並用警示色，任務清單那一列的時間欄也改成「⏱ N 分」。
- **測試沒過時列失敗摘要**：測試沒過時現在卡列出幾支失敗、哪幾支與原因，原始輸出尾巴改成按 `x` 展開才看。
- **審查前置結果**：審查過後現在卡多一列「前置」：審查前置指令（`review.preflight`）的結果，成功寫候選幾條、採用幾條，失敗寫原因；審查檔第一行沒有這行（沒設前置指令、沒裝工具）就不顯示。
- **通知**：等你、流程暫停（含額度煞車：5 小時額度低於 `chainQuotaStop` 時自動流程停在派下一個 Agent 前）、可開 PR、自動開 PR、按 `v` 的測試未通過會送一次通知（走 Claude Code 的通知管道；自動流程的測試沒過直接派修正，修到上限停下時送「流程已暫停」）。
- **新版本**：每 24 小時查一次 GitHub 上有沒有新的 desk（時間記在本機，重開也算），有就在面板與摘要列顯示「有新版本 x.y.z」；只提示、不安裝，查不到就不出聲。專案 `dispatch.json` 設 `"updateCheck": "off"` 關掉。

## desk 會寫什麼

- 卡片：只有按 `u` 上線確認時清掉 `release：` 關卡並記一行 History（接著跑 `/desk:card archive` 那支腳本歸檔，同 ⌫ 歸檔）；寫入前重讀，關卡已不是 release 就不動。其他欄位都是 Agent 或 `/desk:card` 寫的。
- 審查存底：每次審查結束，把審查檔複製一份到 `reviewsDir`。
- 派工：用 `claude --bg` 在任務根目錄開背景 Agent，權限照你的 Claude Code 設定。背景 Agent 預設不載入 MCP server（`--strict-mcp-config`）：每個 MCP 都是一支常駐程序，一件任務就會多出好幾支，派工一多記憶體就被吃光；Agent 要用 MCP 時在 `dispatch.json` 設 `"mcp": true`。做完的 Agent 由 desk 在下一次重新整理時 `claude stop` 收掉（對話保留，之後派工照常 `--resume`），不再閒置到 daemon 回收；全域 `dispatch.json` 設 `"stopDone": false` 關掉。提示詞允許實作的 Agent 與合併段的推送 Agent（「⇡ 開 PR」「⇡ push」）push 這件任務自己的分支、開 PR，但不 force push、不推別的分支、不合併 PR、不打 tag、不碰正式環境、不啟動容器；同步、審查與合併段自動派的解衝突 Agent（把基準分支 merge 進來、不 rebase）不 push、不開 PR。專案設了 `autoPr` 時，審查過關（含只動文件、免審查過關）後自動派同一種推送 Agent，高風險改動照舊等你看；desk 自己不跑 git push 或 gh。推送 Agent 怎麼開 PR依 origin：GitHub 用 `gh pr create`（先 `gh pr list` 查有沒有開著的）、Bitbucket 用 MCP 的 `bb_get` 查重複再 `bb_post`（origin 是 Bitbucket 時推送這一種派工就算沒設 `mcp` 也載入 MCP，做完照 `stopDone` 收掉）、認不出的平台只 push 並把開 PR 網址寫進「等你」；專案 `dispatch.json` 的 `pr.open` 可覆寫成任何指令（例如 GitLab 的 `glab mr create`）。
- desk 自己的更新（`/desk update`）：GitHub marketplace 安裝更新 marketplace 再更新 plugin；本機資料夾安裝要在預設分支、沒有未提交改動、沒有 GitHub 上沒有的 commit，才快轉預設分支再更新 plugin，否則什麼都不動並說明原因。不 stash、不切換分支、不 push；更新成功後自動執行 `/reload-plugins`，不重新啟動 Claude Code。desk 自己發版後，工作桌會在回合結束自動跑一次（同一版只跑一次，失敗只回報不重試）。
- desk 自己不跑 `git push`、不開或合併 PR、不會部署；push、開 PR 交給它派的 Agent，合併由你按。合併段會 `git fetch origin <基準分支>`（只更新遠端追蹤分支）並用 `git merge-tree` 試合併，不動工作區與 HEAD。

## 限制

- 介面、提示詞與卡片欄位都是繁體中文。
- 預設的發版慣例：發版線是 `release/*` 分支、上線看 `v*` tag。用 main 直接發版也可以，只是「開發中版本」那一欄不會出現。
- PR 狀態只讀 GitHub 與 Bitbucket；其他平台（或沒裝 `gh`）的合併靠 git 判斷，只認得 merge commit，squash、rebase、fast-forward 合併看不出來，要自己在卡片寫回。其他平台要讓推送 Agent 開 PR，在專案 `dispatch.json` 設 `pr.open`，沒設就只 push、留網址給你開。
- 背景 Agent 沒有沙盒，push 範圍與不碰正式環境只靠提示詞，見 [README 的「安全須知」](../README.md#安全須知)。
- 背景 Agent 停在權限提示時，面板只會標「等批准」並告訴你到終端機跑 `claude agents` 批准；Claude Code 沒有給面板代為批准的介面。

## 設定

plugin 選項（安裝時或 `claude plugin configure desk` 設定）：

| 選項 | 預設 | 作用 |
|---|---|---|
| `registryPath` | 空白 | 任務登錄表：每列 `\| 任務名 \| \`卡片路徑\` \|`。空白＝目前專案的 `projects-scope.md`；填了就每個專案都讀這一份 |
| `dispatchSettingsPath` | `~/.claude/handoffs/dispatch.json` | 全域派工設定；目前專案的 `dispatch.json` 疊在上面（見下） |
| `refreshSeconds` | `30` | 重讀間隔（10–600） |
| `bitbucketServer` | `bitbucket` | Bitbucket 的 repo 讀 PR 與 CI 的 MCP 伺服器名稱（GitHub 用 `gh`，不用設定） |
| `pitfallsPath` | 空白 | 常犯錯誤清單，審查先讀；空白＝目前專案的 `review-pitfalls.md` |
| `reviewsDir` | 空白 | 審查存底；空白＝目前專案的 `reviews/` |
| `composeDir` | 空白 | `docker-compose.yml` 所在資料夾；專案 `dispatch.json` 的 `composeDir` 優先；都空白就不看容器 |
| `summaryModel` | `haiku` | 把卡片狀態濃縮成一句的模型；`off` 不呼叫模型 |
| `activation` | `auto` | `auto`：輸入過 `/desk` 的對話才啟用；`always`：每個對話都啟用 |

### 專案資料夾

目前專案＝session 根目錄所在的 git repo（看 `git rev-parse --git-common-dir`，所以 worktree 跟主 repo 算同一個），資料夾是 `~/.claude/handoffs/<repo 資料夾名>/`：

| 檔案 | 作用 |
|---|---|
| `projects-scope.md` | 這個專案的任務登錄表 |
| `dispatch.json` | 專案設定，疊在全域 `dispatch.json` 上：頂層同名鍵整個以專案的為準 |
| `review-pitfalls.md`、`reviews/` | 常犯錯誤清單與審查存底 |
| `archive/` | `/desk:card archive` 的歸檔 |

專案只用 repo 資料夾名區分：放在不同位置、但資料夾同名的兩個 repo 會共用同一個專案資料夾，這種情況請在其中一邊用 `registryPath` 等選項指定別的路徑。

不在 git repo 裡開 `/desk` 會提示到專案裡開；repo 還沒有登錄表就顯示要建在哪裡，並提供「＋ 建立空的登錄表」（`n`，已經有就不覆寫），不會列出別的專案的任務。共用的設定（`model`、`effort`、`kinds`、`sync`、`user`、`maxAgents`、`mcp`、`stopDone`、`chainQuotaStop`）放全域，`rules`、`review`、`risk`、`checkServices`、`composeDir`、`card`、`autoPr` 放專案。

`dispatch.json`（每一項都可以省略）：

```json
{
  "model": "opus",
  "effort": "high",
  "sync": { "claude": { "model": "haiku", "effort": "low" }, "session": "fresh" },
  "kinds": { "review": { "effort": "xhigh" }, "publish": { "model": "haiku", "effort": "low" } },
  "projects": { "~/code/shop-worktrees/order-export": { "effort": "xhigh", "rules": ["只改 api/ 底下"] } },
  "user": "Alex",
  "maxAgents": 3,
  "chainQuotaStop": 30,
  "mcp": false,
  "autoPr": true,
  "pr": { "open": "glab mr create --source-branch {branch} --target-branch {target}" },
  "rules": ["測試只能用 make test，不要自己起資料庫"],
  "review": {
    "high": "實際的 bug、漏做權限檢查、漏寫稽核紀錄、測試沒測到需求",
    "security": "授權與資料範圍、輸入驗證、SQL 與 XSS、個人資料外洩、機密與金鑰",
    "categories": "授權、稽核、個資、測試、命名",
    "template": "~/my-templates/review.md",
    "preflight": "my-review-tool --root {root} --base {base}",
    "pitfalls": "~/code/shop/docs/review-pitfalls.md"
  },
  "risk": { "high": [{ "pattern": "(^|/)Billing/", "label": "金流" }] },
  "checkServices": { "run-tests": ["mysql"] },
  "card": {
    "main": "~/code/shop",
    "worktrees": "~/code/shop-worktrees",
    "base": "origin/main",
    "check": "make test-worktree SLUG={slug}",
    "template": "~/my-templates/DESK-template.md",
    "specRules": ["寫入操作的「則」要包含稽核紀錄"],
    "specPreflight": "my-spec-tool --root {root} --card {card} --paths {paths}",
    "retro": "desk-retro {slug}",
    "changelog": { "format": "keepachangelog" }
  }
}
```

| 鍵 | 作用 |
|---|---|
| `model`／`effort`、`projects.<根目錄>` | 派工用的模型與 effort，任務可以覆寫 |
| `sync` | 同步用的模型與 effort：`sync.claude.model`、`sync.claude.effort`，沒設的沿用任務覆寫或全域；`session: fresh` 每次開新對話 |
| `kinds.<種類>` | 依派工種類各設 `model`／`effort`，可設 `continue`（繼續、修正輪與自動解衝突）、`reply`（回覆）、`review`（審查與資安審查）、`publish`（推送）；只寫其中一個的，另一個沿用任務覆寫或全域。優先順序：種類 > 任務覆寫 > 全域；同步仍用 `sync`。面板狀態列在「派工」後列出跟派工不同的種類 |
| `user` | 寫進提示詞與卡片的人名（預設「使用者」） |
| `maxAgents` | 同時在跑的工作桌背景 Agent 上限（預設 3，`0`＝不限）；整台機器一起算（別的專案、別的對話派的也算），停在提問或等批准的不算。超過的派工（含自動流程）排隊，面板寫第幾位、有空位依序派出，`k` 取消排隊；隊伍只在這個對話，重新載入就清空 |
| `chainQuotaStop` | 自動流程的額度煞車：5 小時額度剩餘低於這個百分比（剛好等於不停）時，自動流程要派下一個 Agent（修正、審查、資安審查、解衝突、`autoPr` 推送，含排隊中的）前停下，不派、流程暫停，動態、提示與通知寫「5 小時額度剩 25%，低於門檻 30%，22:30 重置後按 g 重開」（解衝突被擋時合併段沒有 g，結尾改寫「重置後在對話合併基準分支、解衝突」；擋在派驗收或資安審查前的，按 g 直接派那次審查接續原本那輪，不多派實作）；本機的完成檢查與免審查過關照跑，你手動按 `g`／`w`／`s`／`y` 或 `/desk go` 不看額度，正在跑的 Agent 不停，重置後不會自己重開。預設 30，整數 1–100 照用，`"off"` 或 `false` 關掉，其他值用預設；讀不到額度（含重置時間已過、還沒更新的舊用量）時不擋。放全域 |
| `stopDone` | 做完（done／failed）、程序還活著的工作桌 Agent 在下一次重新整理時 `claude stop` 收掉，每個只試一次，停不掉才在「最近」寫一筆；停在提問的不停。預設開，只有 `false` 關掉；放全域 |
| `autoPr` | `true` 時審查過關（含只動文件、免審查過關）後自動派推送 Agent：還沒有 PR 就 push 並開 PR，PR 已開就只 push（已是最新就不派）。高風險改動、被拒絕過的 PR、流程暫停或別的對話開的流程都不自動開；不合併 PR、不打 tag。預設關，只認 `true`；建議寫在專案的 `dispatch.json`（例如每次過關都開 PR 的專案開、常先不 push 的專案不開） |
| `pr.open` | 推送 Agent 開 PR 的覆寫指令，`{branch}`、`{target}` 換成分支與目標分支（去掉 `origin/`），給 GitLab、自架等 desk 認不出的平台；有填就不看 origin。空白＝依 origin：GitHub 用 `gh pr create`、Bitbucket 用 MCP 的 `bb_post`（推送這一種派工會載入 MCP）、其他只 push 並把網址寫進「等你」 |
| `rules`、`projects.<根目錄>.rules` | 每次派工都附上的專案規則 |
| `review.high`／`security`／`categories` | 審查分級說明、資安審查範圍、類別範例 |
| `review.template` | 審查契約檔（預設內附的 [templates/review.md](../templates/review.md)） |
| `review.preflight` | 審查前置指令：每次審查（程式碼審查、資安審查、複審、重新審查）先執行（設了 `review.preflightMinFiles` 時，diff 少於門檻的審查不跑），輸出當候選清單、逐條驗證過才列進審查檔，審查檔第一行記前置成功與否；指令失敗就略過照常審。任何會輸出候選清單的工具都行（lint、SAST、另一個模型的 CLI…）。`{root}` 換成任務根目錄、`{base}` 換成這次審查看的基準（不明時空字串），其他佔位原樣保留。desk 不執行也不檢查這條指令；空白＝不加 |
| `review.preflightMinFiles` | 審查前置的檔數門檻：diff 少於這麼多檔的審查與複審（修正後、重新審查）不跑 `review.preflight`；正整數，0 或不設（預設）＝都跑 |
| `review.combineSecurity` | `true` 時，高風險分支的資安重點併進程式碼審查，過關後不另派資安審查，照樣停下來等你看；只認 JSON 的 `true`，預設關閉 |
| `review.pitfalls` | 常犯錯誤清單路徑（可用 `~`），讓清單跟著 repo 走；優先於 plugin 選項 `pitfallsPath` 與專案資料夾的 `review-pitfalls.md`，空白照原本順序 |
| `risk.high` | 額外的高風險路徑（正規式）；碰到就加跑資安審查並停下來等你看 |
| `checkServices` | 完成檢查裡出現這個指令名時需要哪些容器服務 |
| `composeDir` | 這個專案的 `docker-compose.yml` 所在資料夾（容器列與檢查前的容器確認） |
| `updateCheck` | `"off"` 不自動檢查 desk 新版本；沒設＝每 24 小時查一次（`/desk update` 不受影響） |
| `format` | 設定檔的格式版號：`1` 或不寫；比這版 desk 認得的新時，面板報一筆「較新版 desk 的設定，請更新 desk」，認得的鍵照常套用。卡片、登錄表的格式標記與舊格式清單見 [docs/FORMATS.md](FORMATS.md) |
| `card.*` | `/desk:card` 用：主 repo、worktree 位置、`card.base`（`new` 沒帶 base 且主 repo 是 detached HEAD 時才用；平常從主 repo 當下的分支切出、記在卡片「基準」欄，desk 的 diff 與合併判斷先看這欄）、建議的完成檢查（`{slug}`）、卡片模板、寫規格的專案規則；另有 `registry`、`archive`（預設在專案資料夾） |
| `card.specPreflight` | 規格前審指令：`/desk:card spec` 讀現況後提示執行，輸出當候選清單（`.task/SPEC-gemini.md`）供對話篩選併入規格；在背景執行，對話同時繼續讀程式與擬草稿，相關檔少於 `card.specPreflightMinFiles` 的小卡跳過；指令失敗跳過照常寫規格。任何會輸出規格候選的工具都行。`{root}` 換成任務根目錄、`{card}` 換成卡片路徑、`{paths}` 換成相關模組檔案路徑（逗號分隔），其他佔位原樣保留。desk 不執行也不檢查這條指令；空白＝不加 |
| `card.specPreflightMinFiles` | 規格前審的檔數門檻：相關檔少於這個數就不跑 `card.specPreflight`；正整數，預設 3 |
| `card.retro` | 歸檔回顧指令：`card.py archive` 複製完 `.task` 檔後、清理 worktree 之前執行，`{slug}` 換成任務名稱，stdout 原樣印出；指令失敗印一行警示但不中斷歸檔。任何會做歸檔統計或產出回顧的工具都行。desk 不執行也不檢查這條指令；空白＝不加 |
| `card.changelog.format` | `/desk:card changelog` 合併片段的格式：不設是「## 未發布」加扁平條目；`"keepachangelog"` 改依 Keep a Changelog，片段與「## [Unreleased]」的手寫內容一起移進「## [<版本>] - <日期>」段，條目依動詞分進 Added（新增）、Changed（調整）、Removed（移除）、Fixed（修復）、Security（修補） |

### 環境變數

多半是測試或特殊安裝才用，平常不用設：

| 變數 | 作用 |
|---|---|
| `DESK_SETTINGS` | `/desk:card` 讀的全域 `dispatch.json` 路徑（預設 `~/.claude/handoffs/dispatch.json`；從面板呼叫時帶 plugin 選項 `dispatchSettingsPath`） |
| `DESK_PROJECT_DIR` | `/desk:card` 的專案資料夾，取代依所在 repo 算出的 `~/.claude/handoffs/<repo 資料夾名>/`（測試用） |
| `DESK_CARD_MAIN`、`DESK_CARD_REGISTRY`、`DESK_CARD_TEMPLATE`、`DESK_CARD_ARCHIVE` | 覆寫 `card.main`、`card.registry`、`card.template`、`card.archive` |
| `DESK_AGENT` | `/desk:card emit` 沒帶 `--agent` 時記的 Agent 名（預設 `agy`） |
| `DESK_CLAUDE_CMD`、`DESK_AGY_CMD` | `/desk:card send --to claude`／`--to agy` 啟動的執行檔（預設 `claude`、`agy`，可帶參數） |

`dispatch.json` 有 JSON 語法錯誤、認不得的鍵（`$schema` 與 `_` 開頭的註解鍵除外）或型別、範圍不對的值時，面板在動態報一筆錯誤並跳通知，寫出是哪個檔、哪個鍵、改用了什麼值；設定照舊改用預設值繼續，不擋派工。同一份內容只報一次，內容改了再看；報過的檔改正、刪掉或不再屬於目前專案時記一筆，問題列跟著收掉。

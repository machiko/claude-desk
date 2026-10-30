# desk

Claude Code 的工作桌：一行摘要列看有沒有任務在等你，一張面板只放「現在該看的那一件」，並告訴你輪到誰、該按什麼。從規格、實作、檢查、審查、合併到上線，中間的實作、檢查、審查、修正由背景 Agent 自動走完流程。

> **English summary.** desk is a Claude Code mod (a plugin of function hooks) that turns each feature branch into a card with six stages — spec, build, check, review, merge, ship. A pane shows whose turn it is and which key to press; background agents (`claude --bg`) build, run the check, review in a fresh session and fix CRITICAL/HIGH findings for up to two rounds. The UI and prompts are in Traditional Chinese.

```
 desk 0.18.0  5 小時 剩 78%  本週 剩 31%            教學模式 · 20:00 讀取
 ──────────────────────────────────────────────────────────────────────
 現在
 ◆ 教學：會員折扣  關卡
   ▶ 輪到你  看過規格（o 開卡片）後按 t 確認（實際：/desk:card spec
             discount ok）
   規格◆ 實作○ 檢查○ 審查○ 合併○ 上線○
   狀態    規格草稿已寫好，等你確認
   git     feature/discount · 與遠端一致、無未提交變更

   ◆ 規格  待確認規格（AC-1～AC-3）
   檢查    尚未執行
           python3 -m unittest -q

 全部任務（示範任務只能看）     規格 實作 檢查 審查 合併 上線
   ● 主工作區（release/v1.4）   ·    ·    ◆    ·    ·    ○   20 分鐘前
      CHANGELOG 日期要現在補還是發版時補？
   ◆ 部署流程改版               ●    ◆    ○    ○    ○    ○    5 小時前
      合併取捨已完成，請確認 node:22 釘版
 1 ▸ ◆ 教學：會員折扣           ◆    ○    ○    ○    ○    ○
   ◐ 訂單匯出 CSV               ●    ◉    ○    ○    ○    ○    3 分鐘前
   ○ 會員登入改版               ●    ○    ○    ○    ○    ○      2 天前
 ──────────────────────────────────────────────────────────────────────
 t ✓ 確認規格  o ↗ 開啟
 r ↻ 重新整理  x ▾ 展開  m ⋯ 更多動作  i ? 說明
```

（`/desk tutorial` 剛開始的畫面，72 欄寬。）

## 需要什麼

- Claude Code：以 2.1.302 開發與測試。mod API 仍是 early access，Claude Code 改版可能讓 desk 需要跟著更新。
- macOS 或 Linux（開檔案用 `open`／`xdg-open`）；Windows 沒有測試過。
- `git`、`python3`（`/desk:card` 用）。
- 選用：讀 PR 與 CI——GitHub 的 repo 用 [`gh`](https://cli.github.com/)（要先 `gh auth login`，只執行 `gh pr list`）、Bitbucket 的 repo 用 Bitbucket MCP 伺服器（只呼叫 `bb_get`）；都沒有時合併改看 git。`docker compose`（完成檢查前確認容器）。

## 安裝

在 Claude Code 的對話輸入：

```
/plugin install desk --marketplace machiko/claude-desk
```

或在終端機：`claude plugin install desk --marketplace machiko/claude-desk`。

## 第一次使用：教學

輸入 `/desk tutorial`。它會在 `~/.claude/desk-tutorial` 建一個小 repo 和一件任務「教學：會員折扣」放在現在卡；「全部任務」列出教學這件和幾件示範任務；示範任務只能看，讓你看到多件任務同時進行時面板的樣子。照現在卡第二列「▶ 輪到你」的指示把六段走完：

1. 規格：看過預先寫好的規格，按 `t` 確認（實際使用時按兩次 `t`，或輸入 `/desk:card spec <slug> ok`）。
2. 實作：確認規格後自動派 Agent（實際使用時一樣，不用再按 `g`）。教學裡的 Agent 和審查由腳本扮演，不花額度，也不需要信任資料夾。
3. 檢查：自動執行，會真的跑 `python3 -m unittest`。
4. 審查：第一輪會挑出一條 HIGH，自動修正、重新檢查、複審；過關後留一條 MEDIUM 讓你決定。
5. 合併：回答審查建議，再按 `f` 寫回卡片；然後按 `t` 在本機合併。選 c（現在改）會改程式並 commit，接著自動退回重新檢查、重新審查，過關後才輪到合併。
6. 上線：按 `t` 打 tag，再按兩次 `u` 確認上線。

做完輸入 `/desk tutorial end`，沙盒會刪除，面板回到你自己的任務。需要 `git` 與 `python3`。

## 快速開始

desk 一次只看一個專案：你在哪個 repo（或它的 worktree）開 `/desk`，就列那個 repo 的任務。每個專案的登錄表與設定放在 `~/.claude/handoffs/<repo 資料夾名>/`，以主 repo `~/code/shop` 為例是 `~/.claude/handoffs/shop/`。

1. 在專案的 `dispatch.json`（`~/.claude/handoffs/shop/dispatch.json`）指定主 repo（`/desk:card new` 從這裡建 worktree）：

   ```json
   { "card": { "main": "~/code/shop", "base": "origin/main" } }
   ```

2. 在 repo 裡開一件任務：`/desk:card new feature/order-export 訂單匯出`，會建 worktree、DESK 卡，並把一列寫進這個專案的登錄表（`projects-scope.md`，還沒有就自動建立）。想先開工作桌、還不開卡，就在面板按 `n`（「＋ 建立空的登錄表」）。
3. 寫規格：`/desk:card spec order-export 管理員可以把訂單匯出成 CSV`。它會問幾個釐清問題，把目標、非目標、驗收情境與完成檢查寫進卡片。看過後在面板按兩次 `t` 確認（或輸入 `/desk:card spec order-export ok`）。按 `t` 確認後會自動派實作；在對話用指令確認的，回合結束後一樣自動派。
4. 輸入 `/desk` 開工作桌，照現在卡第二列的指示按鍵（例如按兩次 `g` 派 Agent）。

背景 Agent 只會在「信任過的 repo」裡啟動：第一次用某個 repo 前，先在那個 repo 根目錄開一次 `claude`，信任提示選 Yes。

完整流程（角色、六段、自動流程、風險分級、常見狀況）見 [docs/WORKFLOW.md](docs/WORKFLOW.md)。

## 指令

| 指令 | 作用 |
|---|---|
| `/desk` | 開啟面板並把鍵盤焦點移過去；第一次會開始定時更新 |
| `/desk close` | 收起面板（面板有焦點時按 Esc 也可以） |
| `/desk refresh` | 立刻重讀 |
| `/desk go\|sync\|review <任務名>` | 派工：繼續（開始一輪流程；完成檢查還沒核准過會先問）、同步、審查 |
| `/desk reply <任務名> [回覆]` | 回覆停下來問的 Agent |
| `/desk verify <任務名>` | 執行卡片的完成檢查（第一次會先確認） |
| `/desk open <任務名>` | 用系統預設程式開卡片 |
| `/desk bar` | 收起／顯示摘要列 |
| `/desk update` | 把 desk 自己更新到 GitHub 上的最新版本（面板 footer 有新版時的「⇡ 更新到 <版本>」、沒查過時的「⇡ 檢查並更新」按鈕相同，只用點的、不綁快捷鍵；已是最新只顯示「✓ 已是最新版本」字樣，要重查就用這個指令）；更新後自動重新載入（不行就預填 `/reload-plugins`） |
| `/desk tutorial` | 教學：在沙盒裡把六段走一遍，旁邊配幾件示範任務（`/desk tutorial end` 結束並刪除沙盒） |
| `/desk off` | 這個對話關閉工作桌 |
| `/desk:card new <分支> <卡名> [base]` | 建 worktree、DESK 卡、登錄表列 |
| `/desk:card spec <目標> [需求]` | 產生規格草稿並設 `spec：` 關卡；`… ok` 確認 |
| `/desk:card done <slug> <狀態一句>` | 主對話告一段落時寫回卡片：狀態、下一步（平常是到面板按 v；審查過關後有新 commit 是等自動重新檢查與審查，沒動靜就按 v；審查過關後沒有新 commit 是照面板開 PR 或合併）與 History（分支、HEAD）；規格沒確認會拒絕 |
| `/desk:flow` | 在主對話（不派 Agent）走六段的說明：每段對話做什麼、面板怎麼看得到，末尾附一行 CLAUDE.md 規則 |
| `/desk:card archive <slug>… [--cleanup]` | 卡、審查檔與 .task 的計畫／報告複製到歸檔資料夾、登錄表移到已歸檔段（不刪 worktree）；發版時帶 `--cleanup` 再移除已合併又乾淨的 worktree 與分支（`git worktree remove`、`git branch -d`），保留的寫進登錄表「## 提醒」 |
| `/desk:card changelog <版本>` | 發版：把 `changelog.d/*.md` 片段合併成 CHANGELOG.md 的 `## <版本>` 段並刪掉片段檔（在要發版的那份 main 執行：主 repo，照「⚑ 發版」流程時是從 origin/main 開的暫存 worktree；沒有片段、版本段已存在、片段格式錯都不改檔） |

焦點：`/desk` 或 ctrl+x tab 移到面板，ctrl+x tab 回輸入框。面板裡按 `i` 看完整快捷鍵。

| 鍵 | 作用 |
|---|---|
| 1–9 | 選任務：清單列出全部任務，數字固定不因選取而換號，選中的那件以 `▸` 開頭並反白，現在卡標題寫「現在 · 你選的」。選了的那件是對話的主角：之後你打的每則都附上它的卡，摘要列標「已選」；點現在卡的任務名不會有動作，要取消選取就按 `m` 展開更多動作、點「✕ 取消選取」 |
| a b c d、f | 選決策選項、填入輸入框；送出後那題鎖住，等對話寫回卡片 |
| g／w／s | 繼續／審查／同步（**按兩次確認**，確認文字寫出模型與 effort）；同步平常收在 `m` 更多動作，卡片落後分支時才出現在 footer |
| y | 回覆停下來問的 Agent |
| k | 停止 desk 派出去的 Agent（按兩次確認；對話保留） |
| l | 展開 Agent 最近 10 行輸出 |
| v | 完成檢查；流程停在檢查段（指令改過、容器沒啟動、檢查中斷）時，跑完流程接著走 |
| u | 上線確認：有 tag 包含這個 commit、關卡是 `release：…` 時才出現；按兩次清關卡、記 History 並歸檔（worktree 與分支保留；發版線與教學那件只清關卡） |
| o／e／p | 開卡片／審查檔／PR；合併之後 footer 只列該段的主動作（沒打 tag：⚑ 發版與開啟；有 `release：` 關卡：上線確認與開啟；可歸檔：只剩 ⌫ 歸檔），輸出、審查檔、PR 收進 `m` |
| ⇡ 開 PR／⇡ push | 合併段才出現、沒有快捷鍵，**按兩次確認**：派推送 Agent push 分支並對基準分支開 PR，或 PR 已開時只 push（不合併、不打 tag） |
| ⚑ 發版 | 上線段、還沒打 tag 時出現、沒有快捷鍵，按一下把發版請求（列出所有待發版的卡）填入輸入框，請求也列出發版後要歸檔並移除 worktree 與分支的卡（CI 通過、各卡狀態寫好之後才做；有 `release：` 關卡的卡改由按 `u` 歸檔）；Enter 送出後由對話照 [docs/WORKFLOW.md](docs/WORKFLOW.md) 的發版步驟做；對話只問一次：建議版號與理由、包含的卡、選照做後要做的動作（有要清理的卡時最後一項是歸檔並移除 worktree 與分支）寫成一題放進那幾張卡的「等你」，你在面板按 a（照做）、b（改用另一個版號）或 c（先不發）再按 `f`；選照做後一路做完不再問，失敗就停下寫進卡片。面板不打 tag、不 push |
| t | 確認規格：停在 `spec：…` 關卡、沒有 Agent 在跑時出現，按兩次（同 `/desk:card spec <slug> ok`），確認後自動派實作（同 `g`：第一次先問核准檢查；「等你」有事、manual、worktree 有別人的改動時只確認不派；Agent 已滿就排隊）；教學模式則是下一步（確認規格、合併、打 tag，按一次） |
| x／m／i | 展開全文（含完整歷程）／更多動作／說明 |
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

完整模板在 [templates/DESK-template.md](templates/DESK-template.md)，包含「## 規格」（目標、非目標、驗收情境表）。舊格式 `<!-- CARD -->`（欄位「驗證」「等使用者」）也讀得懂。

## 面板

- **輪到誰**：現在卡第二列一定是 **▶ 輪到你**（後面寫要按什麼或輸入什麼）、**◐ 處理中**（AI 或機器在做，等著就好）或 **— 沒有待辦**。摘要列用同一句。
- **只列能做的動作**：實作段只有 `g`、檢查段只有 `v`、審查段只有 `w`、上線段只有 `u`；已經過了的段落不再出現它的鍵。`m` 展開全部動作。
- **header／content／footer**：header 與 footer 常駐，只有中間捲動（滾輪、↑ ↓ PageUp PageDown）。寬 100 欄以上時現在卡與進度表左右並排。
- **六段圖示**：● 已過、◉ 進行中、◆ 等你、✕ 卡住、○ 未到、· 不適用；上線確認後六個 ● 轉綠、狀態是 ✓「已上線」。
- **卡片可能過期**：分支最近一次 commit 改到的程式（只改卡片的 commit 不算）比卡片新、又沒有 Agent 在跑時，現在卡提示「按 s 同步」，footer 也才列出「↻ 同步」（這一段沒有別的該按的鍵時它帶頭）。先寫卡、測試跑完才 commit 的不算過期。
- **提醒**：登錄表「## 提醒」段 `- YYYY-MM-DD 事項` 到期前三天出現；`- 事項` 不寫日期時一直列在面板。面板上收成一列（多件寫「提醒 n 件 · 第一條」），按 `m` 展開全文（最多 4 列，其餘寫「還有 k 件」）。打勾 `[x]`、劃掉 `~~…~~`、縮排子項目與日期格式不對的行不算提醒。
- **通知**：等你、流程暫停、可開 PR、按 `v` 的檢查未通過會送一次通知（走 Claude Code 的通知管道；自動流程的檢查沒過直接派修正，修到上限停下時送「流程已暫停」）。
- **新版本**：每 24 小時查一次 GitHub 上有沒有新的 desk（時間記在本機，重開也算），有就在面板與摘要列顯示「有新版本 x.y.z」；只提示、不安裝，查不到就不出聲。專案 `dispatch.json` 設 `"updateCheck": "off"` 關掉。

## desk 會寫什麼

- 卡片：只有按 `u` 上線確認時清掉 `release：` 關卡並記一行 History（接著跑 `/desk:card archive` 那支腳本歸檔，同 ⌫ 歸檔）；寫入前重讀，關卡已不是 release 就不動。其他欄位都是 Agent 或 `/desk:card` 寫的。
- 審查存底：每次審查結束，把審查檔複製一份到 `reviewsDir`。
- 派工：用 `claude --bg` 在任務根目錄開背景 Agent，權限照你的 Claude Code 設定。提示詞允許實作的 Agent 與合併段的推送 Agent（「⇡ 開 PR」「⇡ push」）push 這件任務自己的分支、開 PR，但不 force push、不推別的分支、不合併 PR、不打 tag、不碰正式環境、不啟動容器；同步與審查不 push、不開 PR。
- desk 自己的更新（`/desk update`）：GitHub marketplace 安裝更新 marketplace 再更新 plugin；本機資料夾安裝要在預設分支、沒有未提交改動、沒有 GitHub 上沒有的 commit，才快轉預設分支再更新 plugin，否則什麼都不動並說明原因。不 stash、不切換分支、不 push；更新成功後自動執行 `/reload-plugins`，不重新啟動 Claude Code。
- desk 自己不跑 `git push`、不開或合併 PR、不會部署；push、開 PR 交給它派的 Agent，合併由你按。

## 限制

- 介面、提示詞與卡片欄位都是繁體中文。
- 預設的發版慣例：發版線是 `release/*` 分支、上線看 `v*` tag。用 main 直接發版也可以，只是「開發中版本」那一欄不會出現。
- PR 狀態只讀 GitHub 與 Bitbucket；其他平台（或沒裝 `gh`）的合併靠 git 判斷，只認得 merge commit，squash、rebase、fast-forward 合併看不出來，要自己在卡片寫回。
- 背景 Agent 的權限照你的 Claude Code 設定；desk 只在提示詞裡限制 push 的範圍（只推自己的分支、不合併）與不碰正式環境，不是沙盒。
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

不在 git repo 裡開 `/desk` 會提示到專案裡開；repo 還沒有登錄表就顯示要建在哪裡，並提供「＋ 建立空的登錄表」（`n`，已經有就不覆寫），不會列出別的專案的任務。共用的設定（`model`、`effort`、`kinds`、`sync`、`user`、`maxAgents`）放全域，`rules`、`review`、`risk`、`checkServices`、`composeDir`、`card` 放專案。

`dispatch.json`（每一項都可以省略）：

```json
{
  "model": "opus",
  "effort": "high",
  "sync": { "claude": { "model": "haiku" }, "session": "fresh" },
  "kinds": { "review": { "effort": "xhigh" }, "publish": { "model": "haiku", "effort": "low" } },
  "projects": { "~/code/shop-worktrees/order-export": { "effort": "xhigh", "rules": ["只改 api/ 底下"] } },
  "user": "Alex",
  "maxAgents": 3,
  "rules": ["測試只能用 make test，不要自己起資料庫"],
  "review": {
    "high": "實際的 bug、漏做權限檢查、漏寫稽核紀錄、測試沒測到需求",
    "security": "授權與資料範圍、輸入驗證、SQL 與 XSS、個人資料外洩、機密與金鑰",
    "categories": "授權、稽核、個資、測試、命名",
    "template": "~/my-templates/review.md"
  },
  "risk": { "high": [{ "pattern": "(^|/)Billing/", "label": "金流" }] },
  "checkServices": { "run-tests": ["mysql"] },
  "card": {
    "main": "~/code/shop",
    "worktrees": "~/code/shop-worktrees",
    "base": "origin/main",
    "check": "make test-worktree SLUG={slug}",
    "template": "~/my-templates/DESK-template.md",
    "specRules": ["寫入操作的「則」要包含稽核紀錄"]
  }
}
```

| 鍵 | 作用 |
|---|---|
| `model`／`effort`、`projects.<根目錄>` | 派工用的模型與 effort，任務可以覆寫 |
| `sync` | 同步用的模型；`session: fresh` 每次開新對話 |
| `kinds.<種類>` | 依派工種類各設 `model`／`effort`，可設 `continue`（繼續與修正輪）、`reply`（回覆）、`review`（審查與資安審查）、`publish`（推送）；只寫其中一個的，另一個沿用任務覆寫或全域。優先順序：種類 > 任務覆寫 > 全域；同步仍用 `sync`。面板狀態列在「派工」後列出跟派工不同的種類 |
| `user` | 寫進提示詞與卡片的人名（預設「使用者」） |
| `maxAgents` | 同時在跑的工作桌背景 Agent 上限（預設 3，`0`＝不限）；整台機器一起算（別的專案、別的對話派的也算），停在提問或等批准的不算。超過的派工（含自動流程）排隊，面板寫第幾位、有空位依序派出，`k` 取消排隊；隊伍只在這個對話，重新載入就清空 |
| `rules`、`projects.<根目錄>.rules` | 每次派工都附上的專案規則 |
| `review.high`／`security`／`categories` | 審查分級說明、資安審查範圍、類別範例 |
| `review.template` | 審查契約檔（預設內附的 [templates/review.md](templates/review.md)） |
| `risk.high` | 額外的高風險路徑（正規式）；碰到就加跑資安審查並停下來等你看 |
| `checkServices` | 完成檢查裡出現這個指令名時需要哪些容器服務 |
| `composeDir` | 這個專案的 `docker-compose.yml` 所在資料夾（容器列與檢查前的容器確認） |
| `updateCheck` | `"off"` 不自動檢查 desk 新版本；沒設＝每 24 小時查一次（`/desk update` 不受影響） |
| `card.*` | `/desk:card` 用：主 repo、worktree 位置、預設 base（desk 也拿它當 diff 與合併判斷的基準之一）、建議的完成檢查（`{slug}`）、卡片模板、寫規格的專案規則；另有 `registry`、`archive`（預設在專案資料夾） |

## 開發

```
claude --plugin-dir .                 # 從這個資料夾載入；存檔就重新載入 hooks
claude plugin validate .
claude plugin test .                  # hooks 的測試
python3 -m unittest discover -s skills/card/tests   # /desk:card 的測試
```

測試時間與機器負載：`claude plugin test` 對每一支測試都重新載入整個 hooks 模組圖（約 5,500 行），單支的載入成本約 110–200 ms，測試本身的工作多半只有 20–200 ms；最重的一支（`tests/chain-flow.test.tsx` 第一支）單獨跑約 420 ms。runner 固定開「CPU 核心數」個子行程同時跑，所以每支測試的牆鐘時間會隨機器當時的負載放大：同一台機器有別的 worktree 也在跑整套時，單獨 420 ms 的那支可能被放大到 2–5 秒，超過 5000 ms 就逾時，而且每次逾時的那支都不同。跑整套前先看 `uptime`，避免幾個 worktree 同時跑；這種逾時不是測試或 hooks 壞了，不要用調逾時、重試或 skip 蓋掉，等負載降下來再跑一次就好。

### CHANGELOG 片段檔

每張卡（分支）的 CHANGELOG 條目寫在 `changelog.d/<slug>.md`（slug＝worktree 資料夾名＝分支最後一段，例如 `changelog.d/check-public.md`），不改 `CHANGELOG.md`，所以各分支之間不會再搶「## 未發布」。片段檔只放條目：一行或多行 `- ` 開頭、動詞開頭（新增／修復／調整／移除），一條一個使用者看得到的主題，沒有標題、沒有版本；沒有使用者看得到的改動就不建這個檔（空檔會讓發版報錯）。目錄裡的 `.gitkeep` 讓它在沒有片段時也存在。

發版（要發的 PR 都合併之後，在要發版的那份 main：主 repo，或照「⚑ 發版」流程從 origin/main 開的暫存 worktree）：

```
python3 skills/card/scripts/card.py changelog 0.27.0   # 或 /desk:card changelog 0.27.0
```

它把片段合併成 `## 0.27.0` 段（插在「## 未發布」之後、上一版之前；順序 新增 → 調整 → 修復 → 移除，同類依檔名）並刪掉片段檔；沒有片段、版本段已存在、片段有一行不是 `- ` 開頭都會報錯、不改檔。接著改 `.claude-plugin/plugin.json` 的版號，`git add CHANGELOG.md changelog.d .claude-plugin/plugin.json`，commit、打 tag。「## 未發布」標題留著（空的）。

型別檢查：`npx -y -p typescript@5 tsc -p tsconfig.json --noEmit`。它要讀 `.claude-plugin/types/`（Claude Code 產生的 mod 型別，不進版控），所以只在本機跑；GitHub Actions 跑 `plugin validate`、`plugin test` 與 `/desk:card` 的測試（`.github/workflows/ci.yml`）。

## 授權

[MIT](LICENSE)

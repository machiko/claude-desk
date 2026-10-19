# desk

Claude Code 的工作桌：一行摘要列看有沒有案子在等你，一張面板只放「現在該看的那一件」，並告訴你輪到誰、該按什麼。從規格、實作、檢查、審查、合併到上線，中間的實作、檢查、審查、修正由背景 agent 自動接力。

> **English summary.** desk is a Claude Code mod (a plugin of function hooks) that turns each feature branch into a card with six stages — spec, build, check, review, merge, ship. A pane shows whose turn it is and which key to press; background agents (`claude --bg`) build, run the check, review in a fresh session and fix CRITICAL/HIGH findings for up to two rounds. The UI and prompts are in Traditional Chinese.

```
 desk 0.17.0  5 小時 剩 78%  本週 剩 31%            示範資料 · 20:00 更新
 ──────────────────────────────────────────────────────────────────────
 現在
 ● 主工作區（release/v1.4）  等你 · 20 分鐘
   ▶ 輪到你  按選項字母 → f 填入 → Enter 送出
   檢查◆ 上線○
   狀態    release/v1.4 與 origin 同步

   CHANGELOG 日期要現在補還是發版時補？
    a ○ 現在
    b ○ 發版時
   檢查    尚未執行
           npm test

 其他案子           規格 實作 檢查 審查 合併 上線
 1 ◆ 部署流程改版   ●    ◆    ○    ○    ○    ○                  5 小時
      合併取捨已完成，請確認 node:22 釘版
 2 ◐ 訂單匯出 CSV   ●    ◉    ○    ○    ○    ○                  3 分鐘
 3 ○ 會員登入改版   ●    ○    ○    ○    ○    ○                    2 天
 ──────────────────────────────────────────────────────────────────────
 f ✎ 填入決策  s ↻ 同步  v ▶ 檢查  o ↗ 開啟
 r ↻ 重新整理  x ▾ 展開  n → 下一件  m ⋯ 更多動作  i ? 說明
 ● 容器 7 · Opus 5.5 high · 派工 opus high · 同步 haiku・新對話 · 開發中 v1.4
```

（`/desk demo` 的示範資料，72 欄寬。）

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

輸入 `/desk tutorial`。它會在 `~/.claude/desk-tutorial` 建一個小 repo 和一件案子「教學：會員折扣」，面板只顯示這一件，照現在卡第二列「▶ 輪到你」的指示把六段走完：

1. 規格：看過預先寫好的規格，按 `t` 確認（實際使用時是 `/desk:card spec <slug> ok`）。
2. 實作：按兩次 `g`。教學裡的執行者和審查由腳本扮演，不花額度，也不需要信任資料夾。
3. 檢查：自動執行，會真的跑 `python3 -m unittest`。
4. 審查：第一輪會挑出一條 HIGH，自動修正、重新檢查、複審；過關後留一條 MEDIUM 讓你決定。
5. 合併：回答審查建議，再按 `f` 寫回卡片；然後按 `t` 在本機合併。選 c（現在改）會改程式並 commit，接著自動退回重新檢查、重新審查，過關後才輪到合併。
6. 上線：按 `t` 打 tag，再按兩次 `u` 確認上線。

做完輸入 `/desk tutorial end`，沙盒會刪除，面板回到你自己的案子。需要 `git` 與 `python3`。

## 快速開始

desk 一次只看一個專案：你在哪個 repo（或它的 worktree）開 `/desk`，就列那個 repo 的案子。每個專案的登錄表與設定放在 `~/.claude/handoffs/<repo 資料夾名>/`，以主 repo `~/code/shop` 為例是 `~/.claude/handoffs/shop/`。

1. 在專案的 `dispatch.json`（`~/.claude/handoffs/shop/dispatch.json`）指定主 repo（`/desk:card new` 從這裡建 worktree）：

   ```json
   { "card": { "main": "~/code/shop", "base": "origin/main" } }
   ```

2. 在 repo 裡開一件案子：`/desk:card new feature/order-export 訂單匯出`，會建 worktree、DESK 卡，並把一列寫進這個專案的登錄表（`projects-scope.md`，還沒有就自動建立）。
3. 寫規格：`/desk:card spec order-export 管理員可以把訂單匯出成 CSV`。它會問幾個釐清問題，把目標、非目標、驗收情境與完成檢查寫進卡片。看過後輸入 `/desk:card spec order-export ok`。
4. 輸入 `/desk` 開工作桌，照現在卡第二列的指示按鍵（例如按兩次 `g` 派執行者）。

背景執行者只會在「信任過的 repo」裡啟動：第一次用某個 repo 前，先在那個 repo 根目錄開一次 `claude`，信任提示選 Yes。

完整流程（角色、六段、自動接力、風險分級、常見狀況）見 [docs/WORKFLOW.md](docs/WORKFLOW.md)。

## 指令

| 指令 | 作用 |
|---|---|
| `/desk` | 開啟面板並把鍵盤焦點移過去；第一次會開始定時更新 |
| `/desk close` | 收起面板（面板有焦點時按 Esc 也可以） |
| `/desk refresh` | 立刻重讀 |
| `/desk go\|sync\|review <案名>` | 派工：繼續（開始一輪接力）、同步、審查 |
| `/desk reply <案名> [回覆]` | 回覆停下來問的執行者 |
| `/desk verify <案名>` | 執行卡片的完成檢查（第一次會先確認） |
| `/desk open <案名>` | 用系統預設程式開卡片 |
| `/desk bar` | 收起／顯示摘要列 |
| `/desk demo` | 示範資料 |
| `/desk tutorial` | 教學：在沙盒裡把六段走一遍（`/desk tutorial end` 結束並刪除沙盒） |
| `/desk off` | 這個對話關閉工作桌 |
| `/desk:card new <分支> <卡名> [base]` | 建 worktree、DESK 卡、登錄表列 |
| `/desk:card spec <目標> [需求]` | 產生規格草稿並設 `spec：` 關卡；`… ok` 確認 |
| `/desk:card archive <slug>` | 卡與審查檔複製到歸檔資料夾、登錄表移到已歸檔段（不刪 worktree） |

焦點：`/desk` 或 ctrl+x tab 移到面板，ctrl+x tab 回輸入框。面板裡按 `i` 看完整快捷鍵。

| 鍵 | 作用 |
|---|---|
| 1–9、n | 選其他案子；n 跳到下一件（需要你的優先） |
| a b c d、f | 選決策選項、填入輸入框 |
| g／w／s | 繼續／審查／同步（**按兩次確認**，確認文字寫出模型與 effort） |
| y | 回覆停下來問的執行者 |
| k | 停止 desk 派出去的執行者（按兩次確認；對話保留） |
| l | 展開執行者最近 10 行輸出 |
| v | 完成檢查 |
| u | 上線確認：有 tag 包含這個 commit、關卡是 `release：…` 時才出現；按兩次清關卡並記 History |
| o／e／p | 開卡片／審查檔／PR |
| t | 教學模式的下一步：確認規格、合併、打 tag |
| r／x／n／m／i | 重新整理／展開全文／下一件／更多動作／說明 |

## DESK 卡

每件案子一張 `.desk/CARD.md`，工作桌只讀這個區塊：

```
<!-- DESK -->
- 狀態：一句話
- 檢查：`一條指令，exit 0 代表做完`
- 等你：無 | 問題：A) … B) …；問題二：1) … 2) …
- 下一步：一件事
- 關卡：無 | spec：… | review：CRITICAL n、HIGH n、MEDIUM n、LOW n；結論 | release：…
<!-- /DESK -->
```

完整模板在 [templates/DESK-template.md](templates/DESK-template.md)，包含「## 規格」（目標、非目標、驗收情境表）。舊格式 `<!-- CARD -->`（欄位「驗證」「等使用者」）也讀得懂。

## 面板

- **輪到誰**：現在卡第二列一定是 **▶ 輪到你**（後面寫要按什麼或輸入什麼）、**◐ AI 處理中**（等著就好）或 **— 沒有待辦**。摘要列用同一句。
- **只列能做的動作**：實作段只有 `g`、檢查段只有 `v`、審查段只有 `w`、上線段只有 `u`；已經過了的段落不再出現它的鍵。`m` 展開全部動作。
- **header／content／footer**：header 與 footer 常駐，只有中間捲動（滾輪、↑ ↓ PageUp PageDown）。寬 100 欄以上時現在卡與進度表左右並排。
- **六段圖示**：● 已過、◉ 進行中、◆ 等你、✕ 卡住、○ 未到、· 不適用；上線確認後六個 ● 轉綠、狀態是 ✓「已上線」。
- **提醒**：登錄表「## 提醒」段 `- YYYY-MM-DD 事項`，到期前三天出現。
- **通知**：等你、接力暫停、可開 PR、檢查未通過會送一次通知（走 Claude Code 的通知管道）。

## desk 會寫什麼

- 卡片：只有按 `u` 上線確認時清掉 `release：` 關卡並記一行 History；寫入前重讀，關卡已不是 release 就不動。其他欄位都是執行者或 `/desk:card` 寫的。
- 審查存底：每次審查結束，把審查檔複製一份到 `reviewsDir`。
- 派工：用 `claude --bg` 在案子根目錄開背景 agent，權限照你的 Claude Code 設定。提示詞要求執行者不 push、不開 PR、不碰正式環境、不啟動容器。
- 不會 push、不會開或合併 PR、不會部署。

## 限制

- 介面、提示詞與卡片欄位都是繁體中文。
- 預設的發版慣例：發版線是 `release/*` 分支、上線看 `v*` tag。用 main 直接發版也可以，只是「開發中版本」那一欄不會出現。
- PR 狀態只讀 GitHub 與 Bitbucket；GitLab 等其他平台的合併靠 git 判斷，squash 合併在這種情況下看不出來，要自己在卡片寫回。
- 背景執行者的權限照你的 Claude Code 設定；desk 只在提示詞裡要求不 push、不開 PR、不碰正式環境，不是沙盒。

## 設定

plugin 選項（安裝時或 `claude plugin configure desk` 設定）：

| 選項 | 預設 | 作用 |
|---|---|---|
| `registryPath` | 空白 | 案子登錄表：每列 `\| 案名 \| \`卡片路徑\` \|`。空白＝目前專案的 `projects-scope.md`；填了就每個專案都讀這一份 |
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
| `projects-scope.md` | 這個專案的案子登錄表 |
| `dispatch.json` | 專案設定，疊在全域 `dispatch.json` 上：頂層同名鍵整個以專案的為準 |
| `review-pitfalls.md`、`reviews/` | 常犯錯誤清單與審查存底 |
| `archive/` | `/desk:card archive` 的歸檔 |

專案只用 repo 資料夾名區分：放在不同位置、但資料夾同名的兩個 repo 會共用同一個專案資料夾，這種情況請在其中一邊用 `registryPath` 等選項指定別的路徑。

不在 git repo 裡開 `/desk` 會提示到專案裡開；repo 還沒有登錄表就顯示要建在哪裡，不會列出別的專案的案子。共用的設定（`model`、`effort`、`sync`、`user`）放全域，`rules`、`review`、`risk`、`checkServices`、`composeDir`、`card` 放專案。

`dispatch.json`（每一項都可以省略）：

```json
{
  "model": "opus",
  "effort": "high",
  "sync": { "claude": { "model": "haiku" }, "session": "fresh" },
  "projects": { "~/code/shop-worktrees/order-export": { "effort": "xhigh", "rules": ["只改 api/ 底下"] } },
  "user": "Alex",
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
| `model`／`effort`、`projects.<根目錄>` | 派工用的模型與 effort，案子可以覆寫 |
| `sync` | 同步用的模型；`session: fresh` 每次開新對話 |
| `user` | 寫進提示詞與卡片的人名（預設「使用者」） |
| `rules`、`projects.<根目錄>.rules` | 每次派工都附上的專案規則 |
| `review.high`／`security`／`categories` | 審查分級說明、資安審查範圍、類別範例 |
| `review.template` | 審查契約檔（預設內附的 [templates/review.md](templates/review.md)） |
| `risk.high` | 額外的高風險路徑（正規式）；碰到就加跑資安審查並停下來等你看 |
| `checkServices` | 完成檢查裡出現這個指令名時需要哪些容器服務 |
| `composeDir` | 這個專案的 `docker-compose.yml` 所在資料夾（容器列與檢查前的容器確認） |
| `card.*` | `/desk:card` 用：主 repo、worktree 位置、預設 base（desk 也拿它當 diff 與合併判斷的基準之一）、建議的完成檢查（`{slug}`）、卡片模板、寫規格的專案規則；另有 `registry`、`archive`（預設在專案資料夾） |

## 開發

```
claude --plugin-dir .                 # 從這個資料夾載入；存檔就重新載入 hooks
claude plugin validate .
claude plugin test .                  # hooks 的測試
python3 -m unittest discover -s skills/card/tests   # /desk:card 的測試
```

型別檢查：`npx -y -p typescript@5 tsc -p tsconfig.json --noEmit`。

## 授權

[MIT](LICENSE)

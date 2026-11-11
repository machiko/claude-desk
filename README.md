# desk

Claude Code 的工作桌：每件要做的事（一個功能、一個修正）開成一張「卡片」，面板告訴你**現在輪到誰、該按哪個鍵**。寫程式、跑測試、做 code review、照 review 修正這些中間步驟，由背景的 Claude（背景 Agent）自動做完；你只要決定做什麼、看結果、按合併與上線。

> **English summary.** desk is a Claude Code plugin that turns each feature branch into a card with six stages (spec, build, test, acceptance, merge, ship) and a pane that tells you whose turn it is and which key to press. Background agents build, test, review and fix CRITICAL/HIGH findings for you, with your own Claude Code permissions and no sandbox. The UI and prompts are in Traditional Chinese.

```
 desk 0.65.0  5 小時 剩 78%  本週 剩 31%            教學模式 · 20:00 讀取
 ──────────────────────────────────────────────────────────────────────
 現在
 ◆ 教學：會員折扣  關卡
   ▶ 輪到你  看過規格（o 開卡片）後按 t 確認（實際：/desk:card spec
             discount ok）
   ◆ 規格 ○ 實作 ○ 測試 ○ 驗收 ○ 合併 ○ 上線
   狀態    規格草稿已寫好，等你確認
   git     feature/discount · 與遠端一致、無未提交變更

   ◆ 規格  待確認規格（AC-1～AC-3）
   測試    尚未執行
           python3 -m unittest -q

 全部任務（示範任務只能看）     規格 實作 測試 驗收 合併 上線
 1 ▸ ◆ 教學：會員折扣           ◆    ○    ○    ○    ○    ○
   ◐ 訂單匯出 CSV               ●    ◉    ○    ○    ○    ○    3 分鐘前
   ○ 會員登入改版               ●    ○    ○    ○    ○    ○      2 天前
 ──────────────────────────────────────────────────────────────────────
 t ✓ 確認規格  o ↗ 開啟
 r ↻ 重新整理  x ▾ 展開  m ⋯ 更多動作  i ? 說明
```

（示意：`/desk tutorial` 剛開始的畫面，實際畫面依版本與視窗寬度不同。）

## 它幫你做什麼

每張卡片走六段，面板上一段一個圖示：

| 段落 | 做什麼 | 誰做 |
|---|---|---|
| 1 規格 | 寫清楚要做什麼、怎樣算做完 | 對話幫你寫草稿，**你確認** |
| 2 實作 | 寫程式 | 背景 Agent |
| 3 測試 | 跑測試，要全部通過 | 自動 |
| 4 驗收 | 另開一個新對話做 code review，嚴重問題自動修 | 背景 Agent |
| 5 合併 | push、開 PR、合併 | Agent 開 PR，**你按合併** |
| 6 上線 | 打 tag、部署 | 對話照發版步驟做，**你確認上線** |

## 需要什麼

- 最低需要 Claude Code 2.1.302（以這版開發與測試），太舊時面板會提示要更新到哪一版。mod API 仍是 early access，Claude Code 改版可能讓 desk 需要跟著更新。
- macOS 或 Linux；Windows 沒有測試過。
- `git` 與 `python3`。
- 選用：GitHub 的 repo 裝 [`gh`](https://cli.github.com/) 並 `gh auth login`，面板就看得到 PR 與 CI（Bitbucket 等其他平台見[參考手冊](docs/REFERENCE.md#選用工具)）。

## 安裝

在 Claude Code 的對話輸入：

```
/plugin install desk --marketplace machiko/claude-desk
```

或在終端機：`claude plugin install desk --marketplace machiko/claude-desk`。

## 先跑一次教學

輸入 `/desk tutorial`。它會在 `~/.claude/desk-tutorial` 建一個練習用的小 repo 和一張卡「教學：會員折扣」，旁邊再放幾件只能看的示範任務。照面板上「▶ 輪到你」那句的指示按鍵，把六段走完：

1. 規格：看過寫好的規格，按 `t` 確認。
2. 實作：確認後自動開始，不用按鍵。教學裡的 Agent 由腳本扮演，不花額度，也不需要信任資料夾。
3. 測試：自動跑。
4. 驗收：會挑出一個嚴重問題（HIGH）並自動修好。
5. 合併：按 `t` 合併。
6. 上線：按 `t` 打 tag，再按兩次 `u` 確認上線。

做完輸入 `/desk tutorial end`，練習用的 repo 會刪掉，面板回到你自己的任務。

## 開始第一件任務

desk 一次看一個專案：在哪個 repo 開 `/desk`，就列那個 repo 的任務。以主 repo `~/code/shop` 為例：

1. **告訴 desk 主 repo 在哪**：建立 `~/.claude/handoffs/shop/dispatch.json`（資料夾名＝repo 資料夾名）：

   ```json
   { "card": { "main": "~/code/shop", "base": "origin/main" } }
   ```

2. **開卡**：在對話輸入 `/desk:card new feature/order-export 訂單匯出`。它會開一個獨立的工作資料夾（git worktree）和分支，並建好卡片。
3. **寫規格**：輸入 `/desk:card spec order-export 管理員可以把訂單匯出成 CSV`。對話會讀程式、寫出目標與驗收情境，有需要你決定的才問你。
4. **開面板並確認**：輸入 `/desk`，看過規格後在面板按兩次 `t`。之後實作、測試、驗收會自動跑，你等面板出現「▶ 輪到你」再處理。

第一次在某個 repo 用背景 Agent 前，先在終端機到那個 repo 根目錄開一次 `claude`，信任提示選 Yes；沒做的話派工時面板會告訴你怎麼做。

## 面板怎麼看

- **看第二列**：現在卡的第二列只會是三種之一：
  - **▶ 輪到你**：後面寫要按哪個鍵或輸入什麼，照做就好。
  - **◐ 處理中**：Agent 或測試在跑，等著就好。
  - **— 沒有待辦**。
- **六段圖示**：● 已過、◉ 進行中、◆ 等你、✕ 卡住、○ 未到、· 不適用。
- **底下那排按鍵（footer）**只列現在能按的；「▶ 輪到你」叫你按的鍵一定排第一個。會派工的鍵要**按兩次**確認，免得誤按。

最常用的鍵：

| 鍵 | 作用 |
|---|---|
| `1`–`9` | 選任務 |
| `t` | 確認規格 |
| `g` | 讓 Agent 繼續做（開始一輪自動流程） |
| `v` | 跑測試 |
| `a` `b` `c` `d` → `f` | Agent 問你問題時選答案、填進輸入框，Enter 送出 |
| `o` | 開卡片 |
| `k` | 停止 Agent |
| `m` | 更多動作 |
| `i` | 看全部快捷鍵 |

`/desk` 或 ctrl+x tab 把焦點移到面板；面板裡按 Esc 回輸入框。

## 安全須知

- 背景 Agent 沒有沙盒：用 `claude --bg` 啟動，權限照你的 Claude Code 設定（允許清單、權限模式），能讀寫的檔案、能跑的指令、能連的網路都跟你自己開的對話一樣；desk 不另外加限制。
- 推送限制只靠提示：只推這件任務自己的分支、不 force push、不推別的分支、不合併 PR、不打 tag、不碰正式環境、不啟動容器，這些都只寫在給 Agent 的提示詞裡，Agent 不照做時 desk 擋不下來。要真的擋住，用 Claude Code 權限設定的 deny 清單（例如 `git push --force`、部署指令）與 git 平台的分支保護。
- 自動流程會在你沒看著時派 Agent 改程式；完成檢查的指令要你核准過（按兩次 `v`，或確認規格時一起核准）才會執行，改過要重新核准。
- `dispatch.json` 裡的指令（`review.preflight`、`card.specPreflight`、`card.retro`、`pr.open`）由 Agent 或 `/desk:card` 照字面執行，desk 不檢查內容；只放你信任的指令，也只在信任過的 repo 派工。

## 更多文件

- [參考手冊](docs/REFERENCE.md)：全部指令、按鍵、面板細節、卡片格式、desk 會寫什麼、限制、設定與環境變數。
- [開發流程](docs/WORKFLOW.md)：角色、六段、自動流程、風險分級、發版與常見狀況。
- [開發說明](docs/DEVELOPMENT.md)：改 desk 自己時的測試、CHANGELOG 片段檔與共用檔規則。
- [格式版本](docs/FORMATS.md)：卡片、登錄表與設定檔的格式標記。

## 授權

[MIT](LICENSE)

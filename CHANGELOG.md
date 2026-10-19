# Changelog

## 0.17.0 — 第一個公開版本

- 工作桌面板與摘要列：現在卡、其他案子的六段進度表（規格、實作、檢查、審查、合併、上線）、最近動態與提醒；header／footer 常駐，只有中間捲動。
- 一次只看目前專案：依 session 所在的 git repo（worktree 算主 repo）讀 `~/.claude/handoffs/<repo>/` 的登錄表、設定、常犯錯誤與審查存底；不在 repo 裡或還沒有登錄表時說明怎麼建。
- 現在卡第二列寫出輪到誰（輪到你／AI 處理中／沒有待辦）與要按的鍵；footer 只列這一段能做的動作，`m` 展開全部。
- 派工用 `claude --bg`：繼續、同步、審查、回覆；實作 → 完成檢查 → 審查（新對話）→ 修正自動接力，修正最多兩輪；審查通過後分支又有新 commit，自動退回重新檢查、只看新 diff 重新審查。
- 依改動的檔案分風險：只動文件免審查；高風險加跑資安審查並停下來等你看。diff 基準依序找 PR 目標、`origin/release/*`、`card.base`、`origin/HEAD`，沒有 release 線的 repo 也適用。
- 完成檢查同時只跑一個、其他排隊；有設定 `composeDir` 時先確認需要的容器。
- 唯讀讀 PR 與 CI：GitHub 用 `gh pr list`、Bitbucket 用 MCP `bb_get`；都讀不到時，審查過後看 git 判斷是否已合併。`v*` tag 包含 commit 時可按 `u` 確認上線。
- `/desk tutorial` 教學模式：在 `~/.claude/desk-tutorial` 的沙盒裡把六段走一遍；執行者與審查由腳本扮演、完成檢查真的執行，`/desk tutorial end` 刪除沙盒。
- 內附 `/desk:card` skill（開卡、規格、確認規格、歸檔）與 DESK 卡、審查契約模板。
- 支援 macOS 與 Linux（開卡片與 PR 用 `open`／`xdg-open`）。
- 專案規則、人名、審查用語、高風險路徑、檢查要的容器都寫在 `dispatch.json`，程式裡不帶任何專案專屬的內容。

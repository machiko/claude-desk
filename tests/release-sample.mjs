// TS 與 Python 共用的發版確認題樣本（integration 是整版審查擋下時的那題，inProgress 是發版中寫進「狀態」的那句）：skills/card/tests/test_release_skill.py 把 skills/release/SKILL.md 的範本照 fill 填好、
// 斷言等於 question；tests/release-skill.test.ts 把 question 交給 parseDecisions。「PR #13）」故意貼著全形括號，確認不會被當成選項。
// 測試環境不能 import .json，所以放在 .mjs；`export default` 之後是純 JSON，Python 去掉前綴後用 json 讀。
export default {
  "fill": {
    "<版號>": "0.38.0",
    "<卡名與 PR，例如「Beta」PR #12>": "「Beta」PR #12、「Gamma」PR #13",
    "<版號理由>": "升次版號（新增功能來自 PR #13）",
    "<動作，用 → 串>": "整版審查 → 合併 CHANGELOG 片段 → 改版號 → 跑完整檢查 → commit → 打 tag → push 主分支與 tag → 等 CI 通過 → 歸檔並移除 worktree 與分支",
    "<另一個版號>": "0.37.1"
  },
  "confirmed": "已在面板確認：版號照慣例直接做",
  "inProgress": {
    "template": "發版 v<版號>：進行中（<步驟>）",
    "fill": { "<版號>": "0.58.0", "<步驟>": "整版審查" },
    "status": "發版 v0.58.0：進行中（整版審查）"
  },
  "integration": {
    "template": "整版審查 CRITICAL n、HIGH n：A) 開修正卡再發 B) 照發 C) 先不發",
    "counts": [0, 2],
    "question": "整版審查 CRITICAL 0、HIGH 2：A) 開修正卡再發 B) 照發 C) 先不發"
  },
  "question": "發版 v0.38.0（「Beta」PR #12、「Gamma」PR #13，升次版號（新增功能來自 PR #13）），照做會依序：整版審查 → 合併 CHANGELOG 片段 → 改版號 → 跑完整檢查 → commit → 打 tag → push 主分支與 tag → 等 CI 通過 → 歸檔並移除 worktree 與分支：A) 照做 v0.38.0（推薦） B) 改用 v0.37.1 照做 C) 先不發"
}

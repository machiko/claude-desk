# desk 開發說明

改 desk 自己時看這份；使用方式見 [README](../README.md) 與 [參考手冊](REFERENCE.md)，流程見 [WORKFLOW](WORKFLOW.md)。

## 開發

```
claude --plugin-dir .                 # 從這個資料夾載入；存檔就重新載入 hooks
claude plugin validate .
claude plugin test .                  # hooks 的測試
python3 -m unittest discover -s skills/card/tests   # /desk:card 的測試
```

新動作先登記在 `hooks/actions.ts` 的動作表（字母、圖示、標籤），保留鍵與 footer 都由它導出；守門矩陣（`tests/turn-actions-gate.test.tsx`）會檢查「輪到你」那句的鍵跟 footer 一致。

各種派工的提示詞在 `hooks/prompts/<種類>.ts`（`rules`、`catchup`、`publish`、`review`、`fix`），改某種派工的提示只改那一檔；`hooks/dispatch.ts` 只留啟動參數、組裝與拒絕判斷，派工設定在 `hooks/settings.ts`、執行時間在 `hooks/run-time.ts`，呼叫端照舊從它匯入也行。文字工具在 `hooks/text.ts`（不 import 其他 hooks 模組）、Agent 清單解析在 `hooks/agents.ts`；`scripts/tests/test_hook_imports.py` 會檢查 model 與 dispatch 互不 import。

測試時間與機器負載：`claude plugin test` 對每一支測試都重新載入整個 hooks 模組圖（約 5,500 行），單支的載入成本約 110–200 ms，測試本身的工作多半只有 20–200 ms；最重的一支（`tests/chain-flow.test.tsx` 第一支）單獨跑約 420 ms。runner 固定開「CPU 核心數」個子行程同時跑，所以每支測試的牆鐘時間會隨機器當時的負載放大：同一台機器有別的 worktree 也在跑整套時，單獨 420 ms 的那支可能被放大到 2–5 秒，超過 5000 ms 就逾時，而且每次逾時的那支都不同。跑整套前先看 `uptime`，避免幾個 worktree 同時跑；這種逾時不是測試或 hooks 壞了，不要用調逾時、重試或 skip 蓋掉，等負載降下來再跑一次就好。

### CHANGELOG 片段檔

每張卡（分支）的 CHANGELOG 條目寫在 `changelog.d/<slug>.md`（slug＝worktree 資料夾名＝分支最後一段，例如 `changelog.d/check-public.md`），不改 `CHANGELOG.md`，所以各分支之間不會再搶「## 未發布」。片段檔只放條目：一行或多行 `- ` 開頭、動詞開頭（新增／修復／調整／移除），一條一個使用者看得到的主題，沒有標題、沒有版本；沒有使用者看得到的改動就不建這個檔（空檔會讓發版報錯）。目錄裡的 `.gitkeep` 讓它在沒有片段時也存在。

發版（要發的 PR 都合併之後，在要發版的那份 main：主 repo，或照「⚑ 發版」流程從 origin/main 開的暫存 worktree）：

```
python3 skills/card/scripts/card.py changelog 0.27.0   # 或 /desk:card changelog 0.27.0
```

它把片段合併成 `## 0.27.0` 段（插在「## 未發布」之後、上一版之前；順序 新增 → 調整 → 修復 → 移除，同類依檔名）並刪掉片段檔；沒有片段、版本段已存在、片段有一行不是 `- ` 開頭都會報錯、不改檔。接著把各卡標「待補文件」的說明補進 README／docs/REFERENCE.md／WORKFLOW、改 `.claude-plugin/plugin.json` 的版號，`git add CHANGELOG.md changelog.d .claude-plugin/plugin.json README.md docs/REFERENCE.md docs/DEVELOPMENT.md docs/WORKFLOW.md`，commit、打 tag。「## 未發布」標題留著（空的）。

型別檢查：`npx -y -p typescript@5 tsc -p tsconfig.json --noEmit`。它要讀 `.claude-plugin/types/`（Claude Code 產生的 mod 型別，不進版控），所以只在本機跑；GitHub Actions 跑 `plugin validate`、`plugin test` 與 `/desk:card` 的測試（`.github/workflows/ci.yml`）。

### 文件與共用檔

README、WORKFLOW 與 `dispatch.ts` 是每張卡都會碰的熱點檔，多張卡並行時最常互相衝突。所以功能卡不改 README 與 WORKFLOW 的功能說明段（docs/REFERENCE.md 算 README 的功能說明段）：要補的說明寫在卡片「## 規格」的目標或 Decisions，開頭標「待補文件：」，發版時「補文件」那一步一次補進去；CHANGELOG 照舊寫片段檔。改名、搬檔、改六段結構這類橫切重構單獨開卡、先合併，其他卡等它合併後再 sync main；同時在審查與合併段的卡不超過 4 張。細節見 `docs/WORKFLOW.md` 的「開卡順序」。

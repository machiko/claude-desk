# claude-desk 審查常犯錯誤清單

> 每次審查先讀這份，逐條對照改動。回顧或審查發現過去出現過的問題時追加於檔尾，既有條目不改。

## 追加
- 規格：實作跟「### 實作計畫」寫的做法有出入（連正規式多錨一個 `$`、改成每次注入這類小差異都算）就在 History 寫明改了什麼、為什麼，不要寫「無偏離」；需求中途改了先改「## 規格」並在 Decisions 記一筆
- 測試：改 README、docs/WORKFLOW.md 或 skills/*/SKILL.md 的字句前，先 grep skills/card/tests 與 scripts/tests 有沒有斷言那段文字的 Python 測試一起改，並跑 `python3 -m unittest discover -s skills/card/tests`（CI 會跑，`claude plugin test` 不含）；AC 的測試放在 Python 那邊時，卡片「檢查」欄也要串上它
- 重複：規則搬到一處（例如某份 skill）後，README 指令表、WORKFLOW 等其他地方只寫用途並連過去，不要再寫摘要版的規則
- 註解：改了測試斷言或程式行為，同一支的 docstring／註解（AC 編號、步驟數、函式說明的位置）一起對照改；沿用別張卡的測試時，AC 編號要標是哪張卡的

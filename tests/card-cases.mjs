// TS 與 Python 共用的卡片範例：hooks/card.ts 的 parseCard／isPlaceholder、hooks/extras.ts 的 deploySteps
// 與 card.py 的 parse_card／is_placeholder／deploy_steps 都拿它來斷言（只有假的卡片片段）。
// fields：面板讀到的欄位（舊欄名換成正式欄名；沒有區塊是 null）；placeholder：該欄的值是不是 <…> 佔位；deploySteps：面板顯示的部署步驟。
// format：hooks/formats.ts 的 cardFormat 與 card.py 的 card_format 讀到的格式版號（沒寫的範例是 1：沒有標記一律當格式 1）。
// 測試環境不能 import .json，所以放在 .mjs；`export default` 之後是純 JSON，skills/card/tests/test_card.py 去掉前綴後用 json 讀。
export default [
  {
    "name": "標準新卡：全形冒號，下一步還是 <…> 佔位",
    "card": "# 訂單匯出 DESK\n\n<!-- DESK: 工作桌只讀這個區塊。 -->\n- 狀態：開卡\n- 檢查：`make test`\n- 等你：無\n- 下一步：<可以直接派給 Agent 的一件事>\n- 關卡：spec：待確認規格\n- 基準：main\n<!-- /DESK -->\n\n## 部署步驟（合併後）\n\n1.\n",
    "fields": {
      "狀態": "開卡",
      "驗證": "`make test`",
      "等你": "無",
      "下一步": "<可以直接派給 Agent 的一件事>",
      "關卡": "spec：待確認規格",
      "基準": "main"
    },
    "placeholder": {
      "狀態": false,
      "下一步": true
    },
    "deploySteps": []
  },
  {
    "name": "半形冒號、冒號前後有空白",
    "card": "<!-- DESK -->\n- 狀態 :做到一半\n- 關卡: spec：待確認規格\n- 下一步 ：  補測試  \n<!-- /DESK -->\n",
    "fields": {
      "狀態": "做到一半",
      "關卡": "spec：待確認規格",
      "下一步": "補測試"
    },
    "placeholder": {
      "下一步": false
    },
    "deploySteps": []
  },
  {
    "name": "行首空白、- 後面沒空白",
    "card": "<!-- DESK -->\n  - 狀態：縮排的行\n-等你：要 push 嗎？\n\t- 關卡：無\n不是欄位的說明行\n<!-- /DESK -->\n",
    "fields": {
      "狀態": "縮排的行",
      "等你": "要 push 嗎？",
      "關卡": "無"
    },
    "placeholder": {},
    "deploySteps": []
  },
  {
    "name": "舊卡 CARD：舊欄名「等使用者」「驗證」",
    "card": "# Old\n\n<!-- CARD -->\n- 更新：2026-10-01 09:00 · rev 3 · x\n- 狀態：a\n- 驗證：`npm test`\n- 等使用者：要 push 嗎？\n- 下一步：<下一步>\n- 關卡：無\n<!-- /CARD -->\n",
    "fields": {
      "更新": "2026-10-01 09:00 · rev 3 · x",
      "狀態": "a",
      "驗證": "`npm test`",
      "等你": "要 push 嗎？",
      "下一步": "<下一步>",
      "關卡": "無"
    },
    "placeholder": {
      "下一步": true,
      "等你": false
    },
    "deploySteps": []
  },
  {
    "name": "DESK 標記有空白、開頭標記後面接空白再換行、同一欄兩行取最後一行",
    "card": "<!--DESK-->   \n- 關卡：review：CRITICAL 0\n- 關卡：無\n<!--  /DESK  -->\n",
    "fields": {
      "關卡": "無"
    },
    "placeholder": {},
    "deploySteps": []
  },
  {
    "name": "CRLF 換行",
    "card": "<!-- DESK -->\r\n- 狀態：Windows 存的卡\r\n- 關卡：無\r\n<!-- /DESK -->\r\n",
    "fields": {
      "狀態": "Windows 存的卡",
      "關卡": "無"
    },
    "placeholder": {},
    "deploySteps": []
  },
  {
    "name": "疊放卡：基準之後多一欄「疊放於」（card.py new 寫的格式）",
    "card": "<!-- DESK -->\n- 狀態：開卡\n- 檢查：`npm test`\n- 等你：無\n- 下一步：依規格實作\n- 關卡：無\n- 基準：origin/main\n- 疊放於：feature/order-export\n<!-- /DESK -->\n",
    "fields": {
      "狀態": "開卡",
      "驗證": "`npm test`",
      "等你": "無",
      "下一步": "依規格實作",
      "關卡": "無",
      "基準": "origin/main",
      "疊放於": "feature/order-export"
    },
    "placeholder": {
      "下一步": false
    },
    "deploySteps": []
  },
  {
    "name": "帶格式標記的新卡：開頭標記寫「格式=1」，欄位照舊",
    "card": "# 訂單匯出 DESK\n\n<!-- DESK 格式=1：工作桌只讀這個區塊。 -->\n- 狀態：開卡\n- 檢查：`make test`\n- 等你：無\n- 下一步：<可以直接派給 Agent 的一件事>\n- 關卡：無\n<!-- /DESK -->\n",
    "fields": {
      "狀態": "開卡",
      "驗證": "`make test`",
      "等你": "無",
      "下一步": "<可以直接派給 Agent 的一件事>",
      "關卡": "無"
    },
    "placeholder": {
      "下一步": true
    },
    "deploySteps": [],
    "format": 1
  },
  {
    "name": "較新版 desk 的卡：格式 2（全形等號、前後空白），欄位照樣讀得到",
    "card": "<!-- DESK 格式 ＝ 2：工作桌只讀這個區塊。 -->\n- 狀態：新版開的卡\n- 關卡：無\n<!-- /DESK -->\n",
    "fields": {
      "狀態": "新版開的卡",
      "關卡": "無"
    },
    "placeholder": {},
    "deploySteps": [],
    "format": 2
  },
  {
    "name": "沒有格式標記的既有 DESK 卡：當格式 1",
    "card": "<!-- DESK: 工作桌只讀這個區塊。 -->\n- 狀態：升級前開的卡\n- 關卡：無\n<!-- /DESK -->\n\n## History\n\n- 2026-11-01 09:00：格式=3 寫在內文不算\n",
    "fields": {
      "狀態": "升級前開的卡",
      "關卡": "無"
    },
    "placeholder": {},
    "deploySteps": [],
    "format": 1
  },
  {
    "name": "沒有 DESK／CARD 區塊",
    "card": "# 隨手筆記\n\n- 狀態：不是卡片\n",
    "fields": null,
    "placeholder": {},
    "deploySteps": []
  },
  {
    "name": "部署步驟：空白編號與 <…> 佔位略過、控制碼去掉",
    "card": "<!-- DESK -->\n- 關卡：無\n<!-- /DESK -->\n\n## 部署步驟（合併後）\n\n1.\n2. <要做的事>\n3. \u001b[31m重啟 queue worker\u001b[0m\n- 跑 \u001b]8;;https://example.com\u001b\\遷移\u001b]8;;\u001b\\ 指令\n* 清快取\u0007\n\n## History\n\n- 2026-11-07 10:00：不是步驟\n",
    "fields": {
      "關卡": "無"
    },
    "placeholder": {},
    "deploySteps": [
      "重啟 queue worker",
      "跑 遷移 指令",
      "清快取"
    ]
  }
]

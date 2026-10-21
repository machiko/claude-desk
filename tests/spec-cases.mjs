// TS 與 Python 共用的規格範例：hooks/card.ts 的 filledAc／hasSpec 與 card.py 的 filled_ac 都拿它來斷言（只有假的卡片片段）。
// 測試環境不能 import .json，所以放在 .mjs；`export default` 之後是純 JSON，skills/card/tests/test_card.py 去掉前綴後用 json 讀。
export default [
  {
    "name": "範本：則欄是 <…> 佔位或空白",
    "card": "## 規格\n\n- 目標：<一句話>\n\n### 驗收情境\n\n| # | 給定 | 當 | 則 | 對應測試 |\n| --- | --- | --- | --- | --- |\n| AC-1 | <前提> | <操作> | <看得到的結果> | `<測試名稱>` |\n| AC-2 | | | | |\n\n## Scope\n",
    "hasSpec": true,
    "ac": []
  },
  {
    "name": "則欄填了，對應測試寫成「`test_x`（新）」",
    "card": "## 規格\n\n### 驗收情境\n\n| # | 給定 | 當 | 則 | 對應測試 |\n| --- | --- | --- | --- | --- |\n| AC-1 | 一般會員、金額 100 | 計算折扣 | 回傳 100 | `test_x`（新） |\n",
    "hasSpec": true,
    "ac": [
      "AC-1"
    ]
  },
  {
    "name": "填好的與範本混在一起：只算填好的",
    "card": "## 規格\n\n| # | 給定 | 當 | 則 | 對應測試 |\n| --- | --- | --- | --- | --- |\n| AC-1 | 會員 | 結帳 | 回傳 100 | `t1` |\n| AC-2 | <前提> | <操作> | <看得到的結果> | `<測試名稱>` |\n| AC-3 | 訪客 | 結帳 | 403 | `t3` |\n",
    "hasSpec": true,
    "ac": [
      "AC-1",
      "AC-3"
    ]
  },
  {
    "name": "則欄只有空白",
    "card": "## 規格\n\n| AC-1 | 會員 | 結帳 |    | `t1` |\n",
    "hasSpec": true,
    "ac": []
  },
  {
    "name": "列頭尾沒有直線",
    "card": "## 規格\n\nAC-1 | 會員 | 結帳 | 回傳 100 | `t1`\n",
    "hasSpec": true,
    "ac": [
      "AC-1"
    ]
  },
  {
    "name": "規格段在下一個二級標題結束，之後的 AC 不算；三級標題還在段內",
    "card": "## 規格\n\n### 驗收情境\n\n| AC-1 | <前提> | <操作> | <看得到的結果> | `<測試名稱>` |\n\n### 實作計畫\n\n| 檔案 | 改什麼 |\n\n## Scope\n\n| AC-9 | 會員 | 結帳 | 回傳 100 | `t9` |\n",
    "hasSpec": true,
    "ac": []
  },
  {
    "name": "標題後面有空白、CRLF 換行",
    "card": "## 規格  \r\n\r\n| AC-1 | 會員 | 結帳 | 回傳 100 | `t1` |\r\n| AC-2 | <前提> | <操作> | <看得到的結果> | `<測試名稱>` |\r\n",
    "hasSpec": true,
    "ac": [
      "AC-1"
    ]
  },
  {
    "name": "AC 編號不是 AC-數字（AC-1a、ac-1）不算",
    "card": "## 規格\n\n| AC-1a | 會員 | 結帳 | 回傳 100 | `t1` |\n| ac-2 | 會員 | 結帳 | 回傳 100 | `t2` |\n",
    "hasSpec": true,
    "ac": []
  },
  {
    "name": "沒有「## 規格」段的舊卡（「## 規格說明」不算規格段）",
    "card": "## 規格說明\n\n| AC-1 | 會員 | 結帳 | 回傳 100 | `t1` |\n\n## History\n",
    "hasSpec": false,
    "ac": []
  }
]

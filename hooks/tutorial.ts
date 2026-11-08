// 教學模式：在 ~/.claude/desk-tutorial 建一個小 repo，讓第一次用的人親手把六段走一遍。
// Agent 與審查由這裡的腳本扮演（不花額度、不需要信任資料夾）；完成檢查是真的執行。
// 這個檔只放內容與卡片的變化；I/O 在 register.tsx。
import type { Case } from '../types'
import { parseGate } from './card'
import { MEDIUM_ASK_FORM } from './prompts/review'
import { unreviewedNote } from './pipeline'

export const TUTORIAL_SLUG = 'discount'
export const TUTORIAL_NAME = '教學：會員折扣'
export const TUTORIAL_BRANCH = 'feature/discount'
export const TUTORIAL_RELEASE = 'release/v1.0'
export const TUTORIAL_TAG = 'v1.0.0'
export const TUTORIAL_CHECK = 'python3 -m unittest -q'
/** 模擬的 Agent 與審查要「做」多久。 */
export const SIM_MS = 2500

export type TutorialState = { dir: string; reviews: number; merged: boolean }

export function tutorialPaths(home: string) {
  const dir = `${home.replace(/\/+$/, '')}/.claude/desk-tutorial`
  const main = `${dir}/shop`
  const wt = `${dir}/shop-worktrees/${TUTORIAL_SLUG}`
  return { dir, main, wt, card: `${wt}/.desk/CARD.md`, registry: `${dir}/registry.md`, settings: `${dir}/dispatch.json`, marker: `${dir}/.desk-tutorial` }
}

/** 只刪這個資料夾：路徑一定要以 /.claude/desk-tutorial 結尾。 */
export const isTutorialDir = (path: string) => /\/\.claude\/desk-tutorial$/.test(path)

const GIT_ID = ['-c', 'user.name=desk tutorial', '-c', 'user.email=tutorial@example.invalid']
export const gitCommit = (root: string, message: string) => ['git', '-C', root, ...GIT_ID, 'commit', '--quiet', '-m', message]

/** 建主 repo（發版線 release/v1.0）與任務的 worktree；卡片與登錄表由 register 另外寫。 */
export function setupScript(main: string, wt: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  return [
    'set -e',
    `mkdir -p ${q(main)}`,
    `cd ${q(main)}`,
    `git init -q -b ${TUTORIAL_RELEASE}`,
    `printf '%s\\n' '# shop（desk 教學用）' > README.md`,
    `printf '%s\\n' '.desk/' '.task/' '__pycache__/' > .gitignore`,
    'git add README.md .gitignore',
    `git -c 'user.name=desk tutorial' -c user.email=tutorial@example.invalid commit --quiet -m 'chore: 建立專案'`,
    `git worktree add -q -b ${TUTORIAL_BRANCH} ${q(wt)}`,
  ].join('\n')
}

export const registryText = (card: string) => `# 任務登錄（desk 教學）\n\n| 任務名 | 卡片 |\n| --- | --- |\n| ${TUTORIAL_NAME} | \`${card}\` |\n`

export const settingsText = (registry: string, main: string, user: string) =>
  JSON.stringify({ user, card: { registry, main, worktrees: main.replace(/\/shop$/, '/shop-worktrees'), base: TUTORIAL_RELEASE } }, null, 2) + '\n'

export function cardText(date: string): string {
  return `# ${TUTORIAL_NAME} DESK

<!-- DESK: 工作桌只讀這個區塊。五個中文欄位名是解析契約，不可改名；每欄一行。 -->
- 狀態：規格草稿已寫好，等你確認
- 檢查：\`${TUTORIAL_CHECK}\`
- 等你：無
- 下一步：依規格實作 discount()
- 關卡：spec：待確認規格（AC-1～AC-3）
<!-- /DESK -->

## 規格

- 目標：結帳時依會員等級算出折扣後金額。
- 非目標：不處理優惠券、不改資料庫。

### 驗收情境

| # | 給定 | 當 | 則 | 對應測試 |
| --- | --- | --- | --- | --- |
| AC-1 | 一般會員、金額 100 | 計算折扣 | 回傳 100 | \`test_regular_member_pays_full_price\`（新） |
| AC-2 | 金卡會員、金額 1000 | 計算折扣 | 回傳 900 | \`test_gold_member_gets_ten_percent_off\`（新） |
| AC-3 | 任何會員、金額 -1 | 計算折扣 | 丟出 ValueError | \`test_negative_total_is_rejected\`（新） |

### 實作計畫

| 檔案 | 改什麼 |
| --- | --- |
| \`discount.py\` | 新增 discount(total, level)：金卡打九折、一般會員原價、金額為負丟出 ValueError |
| \`test_discount.py\` | AC-1～AC-3 的三個測試 |

## Decisions

- D-01 ${date} 教學：用 Python 標準函式庫 unittest，不裝任何套件

## History

- ${date}：/desk tutorial 建立這張卡與規格草稿
`
}

export const CODE_V1 = `"""會員折扣。"""


def discount(total, level):
    """依會員等級回傳折扣後金額。"""
    if level == 'gold':
        return round(total * 0.9)
    return total
`

export const CODE_V2 = `"""會員折扣。"""


def discount(total, level):
    """依會員等級回傳折扣後金額；金額不可為負數。"""
    if total < 0:
        raise ValueError('金額不可為負數')
    if level == 'gold':
        return round(total * 0.9)
    return total
`

/** 選 C（修掉）時，照驗收的 MEDIUM 把金卡金額改成四捨五入（.5 進位；Python 的 round() 是銀行家捨入，4.5 會變 4）。 */
export const CODE_V3 = `"""會員折扣。"""

from decimal import ROUND_HALF_UP, Decimal


def discount(total, level):
    """依會員等級回傳折扣後金額；金額不可為負數，金卡金額四捨五入到整數。"""
    if total < 0:
        raise ValueError('金額不可為負數')
    if level == 'gold':
        return int((Decimal(total) * Decimal('0.9')).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
    return total
`

const TEST_HEAD = `import unittest

from discount import discount


class DiscountTest(unittest.TestCase):
    def test_regular_member_pays_full_price(self):
        self.assertEqual(discount(100, 'regular'), 100)

    def test_gold_member_gets_ten_percent_off(self):
        self.assertEqual(discount(1000, 'gold'), 900)
`
const TEST_TAIL = `

if __name__ == '__main__':
    unittest.main()
`
export const TEST_V1 = TEST_HEAD + TEST_TAIL
const TEST_NEGATIVE = `
    def test_negative_total_is_rejected(self):
        with self.assertRaises(ValueError):
            discount(-1, 'gold')
`
export const TEST_V2 = TEST_HEAD + TEST_NEGATIVE + TEST_TAIL
/** 選 C（修掉）時多一支：金卡金額 5 打九折是 4.5，四捨五入成 5。 */
export const TEST_V3 = TEST_HEAD + TEST_NEGATIVE + `
    def test_gold_rounds_half_up(self):
        self.assertEqual(discount(5, 'gold'), 5)
` + TEST_TAIL

export const REVIEW_1 = `# 程式碼審查（教學）

| AC | 結果 | 依據 |
| --- | --- | --- |
| AC-1 | 做到 | test_regular_member_pays_full_price |
| AC-2 | 做到 | test_gold_member_gets_ten_percent_off |
| AC-3 | 沒做到 | discount.py 沒有檢查負數，也沒有測試 |

- [HIGH][規格] discount.py:4 — AC-3 沒做到：金額為負數時沒有丟出 ValueError
- [MEDIUM][規格] discount.py:7 — round() 是銀行家捨入，金卡金額 5 會算成 4，規格沒寫捨入方式（等你決定）
`
export const REVIEW_2 = `# 程式碼審查（教學，複審）

| AC | 結果 | 依據 |
| --- | --- | --- |
| AC-1 | 做到 | test_regular_member_pays_full_price |
| AC-2 | 做到 | test_gold_member_gets_ten_percent_off |
| AC-3 | 做到 | test_negative_total_is_rejected |

- [MEDIUM][規格] discount.py:9 — round() 是銀行家捨入，金卡金額 5 會算成 4，規格沒寫捨入方式（等你決定）
`
/** 手動按 w 再驗收時用（驗收過關後的新 commit 只重新測試，自動流程不會走到這一輪）。 */
export const REVIEW_3 = `# 程式碼審查（教學，手動重新驗收）

| AC | 結果 | 依據 |
| --- | --- | --- |
| AC-1 | 做到 | test_regular_member_pays_full_price |
| AC-2 | 做到 | test_gold_member_gets_ten_percent_off |
| AC-3 | 做到 | test_negative_total_is_rejected |

只看上次驗收之後的 diff：沒有新問題；上一輪的 MEDIUM 已在 Decisions 記下你的決定（不修，見 Decisions）。
`

/** 改 DESK 區塊的欄位（一欄一行）。 */
export function setFields(text: string, fields: Record<string, string>): string {
  return text.replace(/(<!-- DESK\b[^>]*-->\n)([\s\S]*?)(<!-- \/DESK -->)/, (_m, open: string, body: string, close: string) => {
    let next = body
    for (const [name, value] of Object.entries(fields)) next = next.replace(new RegExp(`^- ${name}：.*$`, 'm'), () => `- ${name}：${value}`)
    return open + next + close
  })
}

/** 在某個 ## 段落最後加一行；沒有那一段就加在檔尾。 */
export function appendTo(text: string, heading: string, line: string): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  const at = lines.findIndex(l => l.startsWith(heading))
  if (at < 0) return `${lines.join('\n')}\n\n${heading}\n\n${line}\n`
  let end = at + 1
  while (end < lines.length && !/^## /.test(lines[end]!)) end++
  let insert = end
  while (insert > at + 1 && lines[insert - 1]!.trim() === '') insert--
  lines.splice(insert, 0, line)
  return `${lines.join('\n')}\n`
}

/** 驗收過關時「等你」的題目：跟真實審查同一組四個選項（MEDIUM_ASK_FORM），只把條數與摘要填進去。 */
export const TUTORIAL_MEDIUM_ASK = MEDIUM_ASK_FORM.replace('n 條', '1 條').replace('（摘要）', '（金卡金額尾數 .5 怎麼捨入）')

/** 模擬的 Agent 或驗收做完後，卡片長什麼樣。 */
export type SimWork = 'build' | 'fix' | 'review-1' | 'review-2' | 'review-3' | 'sync'

export function cardAfter(text: string, work: SimWork, date: string): string {
  switch (work) {
    case 'build':
      return appendTo(setFields(text, { 狀態: '實作完成：discount() 與兩個測試，已 commit', 下一步: '等測試與驗收', 關卡: '無' }), '## History', `- ${date}：（教學 Agent）實作 AC-1、AC-2 並 commit`)
    case 'fix':
      return appendTo(setFields(text, { 狀態: '已修正驗收的 HIGH：負數金額丟出 ValueError', 下一步: '等重新驗收', 關卡: '無' }), '## History', `- ${date}：（教學 Agent）依驗收補上 AC-3 與測試`)
    case 'review-1':
      return appendTo(setFields(text, { 狀態: '驗收發現 AC-3 沒做到', 關卡: 'review：CRITICAL 0、HIGH 1、MEDIUM 1、LOW 0；AC-3 沒做到，需修正' }), '## History', `- ${date}：（教學驗收）HIGH 1、MEDIUM 1`)
    case 'review-2':
      return appendTo(setFields(text, {
        狀態: '重新驗收通過：三條驗收情境都做到',
        等你: TUTORIAL_MEDIUM_ASK,
        下一步: '決定 MEDIUM 後開 PR 合併',
        關卡: 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；過',
      }), '## History', `- ${date}：（教學驗收）重新驗收通過，MEDIUM 1 等你決定`)
    case 'review-3':
      return appendTo(setFields(text, {
        狀態: '重新驗收通過：沒有新問題',
        下一步: '開 PR 合併',
        關卡: 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過',
      }), '## History', `- ${date}：（教學驗收）驗收後有新 commit，重新驗收通過`)
    case 'sync':
      return appendTo(text, '## History', `- ${date}：（教學同步）卡片與 git 一致`)
  }
}

/** 你在面板上做的決定寫回卡片（教學裡不送到主對話，不花額度）。 */
export function cardAfterDecision(text: string, answer: string, date: string, user: string): string {
  const n = (text.match(/^- D-\d+/gm) ?? []).length + 1
  const fields = answer === 'C'
    ? { 等你: '無', 下一步: '等重新測試', 狀態: '已修掉：金卡金額改成四捨五入並 commit，等重新測試' }
    : { 等你: '無', 下一步: '開 PR 並合併', 狀態: '驗收通過，可開 PR' }
  const withDecision = appendTo(setFields(text, fields), '## Decisions', `- D-${String(n).padStart(2, '0')} ${date} ${user}：驗收 MEDIUM → ${answer}`)
  return appendTo(withDecision, '## History', answer === 'C' ? `- ${date}：決定修掉，金卡金額改成四捨五入並 commit` : `- ${date}：決定 MEDIUM 的處理方式`)
}

export const cardAfterTag = (text: string, date: string) =>
  appendTo(setFields(text, { 狀態: `已合併並打 ${TUTORIAL_TAG}，等部署`, 下一步: '部署後在工作桌按 u 確認上線', 關卡: `release：${TUTORIAL_TAG} 待上線確認` }), '## History', `- ${date}：合併到 ${TUTORIAL_RELEASE}，打 ${TUTORIAL_TAG}`)

/** 這一刻教學按鈕 t 做什麼：確認規格、本機合併、打 tag。 */
export type TutorialStep = 'spec-ok' | 'merge' | 'tag'

export function tutorialStep(c: Case): TutorialStep | null {
  if (c.state === 'running') return null
  const current = c.pipeline?.current
  if (current === 'spec' && parseGate(c.gate)?.kind === 'spec') return 'spec-ok'
  if (current === 'merge' && c.state !== 'ask') return 'merge'
  if (current === 'ship' && !c.tag) return 'tag'
  return null
}

export const TUTORIAL_STEP_LABEL: Record<TutorialStep, string> = { 'spec-ok': '✓ 確認規格', merge: '⇢ 合併', tag: '⚑ 打 tag' }

/** 教學裡的「輪到你」：說教學怎麼做，也說實際使用時怎麼做。 */
export function tutorialTurn(c: Case): { text: string; key?: string } | null {
  if (c.state === 'done') return { text: '教學完成！輸入 /desk tutorial end 清除沙盒' }
  if (c.state === 'ask') return { text: '按選項字母 → f 寫回卡片（實際使用時 f 填入輸入框，Enter 送給主對話）', key: 'f' }
  const step = tutorialStep(c)
  if (step === 'spec-ok') return { text: `看過規格（o 開卡片）後按 t 確認（實際：/desk:card spec ${TUTORIAL_SLUG} ok）`, key: 't' }
  // 驗收過關後的新 commit 只重新測試就過關：跟一般任務的摘要（model.ts 的 summary）同一個條件與說法，先說「測試通過・未重新驗收」。
  const unreviewed = !!c.chain?.passed && !!c.chain.unreviewed && !c.chain.stale ? `${unreviewedNote(c.chain)}；` : ''
  if (step === 'merge') return { text: `${unreviewed}按 t 合併到 release/v1.0（實際：push 並開 PR，在 Bitbucket 或 GitHub 合併）`, key: 't' }
  if (step === 'tag') return { text: `按 t 打 ${TUTORIAL_TAG}（實際：照你的發版流程打 tag）`, key: 't' }
  return null
}

/** 教學一開始的說明（/desk tutorial 的回應）。 */
export const TUTORIAL_INTRO = [
  `教學已開始：沙盒在 ~/.claude/desk-tutorial，現在卡是「${TUTORIAL_NAME}」。`,
  '「全部任務」列出教學這件和幾件示範任務；示範任務只能看，讓你看到多件任務同時進行時面板的樣子：有的在等你、有的正在處理、有的閒置。',
  '照現在卡第二列「▶ 輪到你」的指示按鍵，把六段走完：',
  '  1 規格：看過規格後按 t 確認',
  '  2 實作：確認規格後自動派 Agent（教學裡由腳本扮演，不花額度）',
  '  3 測試：自動執行測試（真的跑 python3 的測試）',
  '  4 驗收：自動派驗收，對規格逐條驗收並做 code review；第一輪會挑出一條 HIGH，自動修正後重新驗收一次，留一條會影響金額的 MEDIUM 讓你決定',
  '  5 合併：先回答驗收建議（a、b、c 或 d → f；選 c 修掉會改程式並 commit，接著只重新測試、不再重新驗收），再按 t 合併',
  '  6 上線：按 t 打 tag，再按兩次 u 確認上線',
  '結束後輸入 /desk tutorial end 清除沙盒、回到你的任務。',
  '教學不需要信任資料夾；回自己的專案前，先在那個 repo 根目錄開過一次 claude 並選信任，背景 Agent 才派得出去。',
].join('\n')

import { expect, test } from 'claude-code/testing'
import { confirmStep, isArmed, logLines, deploySteps, parseReminders, dueReminders, paneReminders, reminderWhen, reviewTop, mediumToFix, parseGitStatus, gitLine, mergedAtHead } from '../hooks/extras'

test('confirm fires only on a second press of the same action within 3 seconds', () => {
  const a = confirmStep(null, 'x\ncontinue', 1000)
  expect(a).toEqual({ fire: false, armed: { key: 'x\ncontinue', at: 1000 } })
  expect(confirmStep(a.armed, 'x\ncontinue', 3500)).toEqual({ fire: true, armed: null })
  expect(confirmStep(a.armed, 'x\ncontinue', 4500).fire).toBe(false)
  expect(confirmStep(a.armed, 'x\nsync', 1500).fire).toBe(false)
  expect(isArmed(a.armed, 'x\ncontinue', 2000)).toBe(true)
})

test('log lines drop escapes, spinners and repeats, keep the last n', () => {
  const raw = '● 讀取卡片\n\u001b[2K● 讀取卡片\nThinking…\n● 修改 CaseImportService.php\n(12s · ↓ 3.1k tokens)\n● 執行 php artisan test'
  expect(logLines(raw)).toEqual(['● 讀取卡片', '● 修改 CaseImportService.php', '● 執行 php artisan test'])
  expect(logLines(raw, 1)).toEqual(['● 執行 php artisan test'])
})

test('deploy steps come from the 部署 section; empty placeholders are skipped', () => {
  const card = '# x\n## 部署步驟（合併後）\n\n1. php artisan migrate\n2. 跑 users:backfill-organization --dry-run\n3.\n- <填寫>\n## History\n- 不是這裡'
  expect(deploySteps(card)).toEqual(['php artisan migrate', '跑 users:backfill-organization --dry-run'])
  expect(deploySteps('沒有段落')).toEqual([])
})

test('reminders: days until, due within 3 days, overdue counts', () => {
  const now = new Date(2026, 11, 19, 15, 0).getTime()
  const reg = '## 任務\n| a | `x` |\n## 提醒\n- 2026-12-22 決定 /api/rag-proxy 是否退役\n- 2027-03-01 Laravel 12 升版\n- 2026-12-18 昨天的事\n## 其他'
  const list = parseReminders(reg, now)
  expect(list.map(r => [r.date, r.days])).toEqual([['2026-12-18', -1], ['2026-12-22', 3], ['2027-03-01', 72]])
  expect(dueReminders(list).map(r => r.text)).toEqual(['昨天的事', '決定 /api/rag-proxy 是否退役'])
  expect(list.map(reminderWhen)).toEqual(['已過 1 天', '還有 3 天', '還有 72 天'])
})

/** AC-5：沒日期的列為無日期、排在有日期後面，永遠不算到期或過期；空行與別段的「- 」行不算。 */
test('reminders: undated lines are listed after dated ones and never fall due', () => {
  const now = new Date(2026, 11, 19, 15, 0).getTime()
  const reg = '## 提醒\n- 改名：清單標題改成全部任務\n\n- 2026-12-22 決定 rag-proxy 是否退役\n- 修正：下一步提示\n- 2026-12-18 昨天的事\n\n## 其他\n- 不是提醒\n- 2026-12-20 也不是'
  const list = parseReminders(reg, now)
  expect(list.map(r => [r.date, r.text, r.days])).toEqual([
    ['2026-12-18', '昨天的事', -1],
    ['2026-12-22', '決定 rag-proxy 是否退役', 3],
    [null, '改名：清單標題改成全部任務', null],
    [null, '修正：下一步提示', null],
  ])
  expect(dueReminders(list).map(r => r.text)).toEqual(['昨天的事', '決定 rag-proxy 是否退役'])
  expect(paneReminders(list).map(r => r.text)).toEqual(['昨天的事', '決定 rag-proxy 是否退役', '改名：清單標題改成全部任務', '修正：下一步提示'])
  expect(list.map(reminderWhen)).toEqual(['已過 1 天', '還有 3 天', '', ''])
  expect(dueReminders(parseReminders('## 提醒\n- 改名\n', now))).toEqual([])
})

/** 審查 MEDIUM：打勾、劃掉、縮排子項、日期寫錯或只寫日期、分隔線都不算沒日期的提醒；未打勾的 [ ] 拿掉框照算。 */
test('reminders: done, struck, nested, malformed-date and separator lines are not undated reminders', () => {
  const now = new Date(2026, 11, 19, 15, 0).getTime()
  const reg = ['## 提醒', '- [x] 已做完', '- [X] 也做完', '- ~~2026-10-01 已處理~~', '- ~~改名~~', '- 2026-10-31', '- 2026/10/30 斜線日期', '- 10/30 沒寫年', '  - 縮排的子項目', '* * *', '- ---', '- [ ] 還沒做的事', '- 改名：清單標題改成全部任務'].join('\n')

  const list = parseReminders(reg, now)

  expect(list.map(r => [r.date, r.text, r.days])).toEqual([
    [null, '還沒做的事', null],
    [null, '改名：清單標題改成全部任務', null],
  ])
})

test('review top lists CRITICAL and HIGH only', () => {
  const md = '# 審查\n- [MEDIUM][命名] a.php:3 — x\n- [HIGH][稽核] b.php:10 — 漏寫稽核紀錄\n- [CRITICAL][資料範圍] c.php:5 — 沒做權限檢查\n- [LOW] d'
  expect(reviewTop(md)).toEqual(['HIGH 稽核 b.php:10 — 漏寫稽核紀錄', 'CRITICAL 資料範圍 c.php:5 — 沒做權限檢查'])
})

test('git status v2 counts ahead, behind, changed, untracked', () => {
  const out = '# branch.oid abc\n# branch.head feature/x\n# branch.upstream origin/feature/x\n# branch.ab +3 -1\n1 .M N... 100644 100644 100644 a b app/X.php\n2 R. N... 100644 100644 100644 a b R100 y z\n? notes.md\n? .codex/'
  const g = parseGitStatus(out)
  expect(g).toEqual({ ahead: 3, behind: 1, changed: 2, untracked: 2, upstream: true })
  expect(gitLine(g)).toBe('領先 3 · 落後 1 · 未提交 2 檔 · 未追蹤 2 檔')
  expect(gitLine({ ahead: 0, behind: 0, changed: 0, untracked: 0 })).toBe('與遠端一致、無未提交變更')
})

/** AC-3 */
test('gitLine reports a deleted remote branch only when merged and without upstream', () => {
  const noUpstream = { ahead: 0, behind: 0, changed: 1, untracked: 0, upstream: false }
  expect(gitLine(noUpstream, true)).toBe('已合併，遠端分支已刪除 · 未提交 1 檔')
  expect(gitLine({ ahead: 0, behind: 0, changed: 0, untracked: 0, upstream: true }, true)).toBe('與遠端一致、無未提交變更')
  expect(gitLine({ ...noUpstream, changed: 0 }, false)).toBe('未 push（沒有遠端分支）')
  expect(gitLine(noUpstream)).toBe('未 push（沒有遠端分支） · 未提交 1 檔')
})

/** AC-5：只有「PR 已合併、PR 的 head 就是現在的 HEAD」才算遠端分支被合併刪掉；合併後又 commit、沒有 head、git 判斷合併都不算 */
test('mergedAtHead only trusts a merged PR whose head is the current HEAD', () => {
  const git = { branch: 'feature/b', head: 'c2c2c2c2c2c2c2c2c2c2' }
  const pr = { id: 12, state: 'MERGED' as const, ci: 'none' as const, head: 'c2c2c2c2c2c2c2c2c2c2' }
  const byGit = { git, mergedInto: 'origin/main' }

  expect(mergedAtHead({ git, pr })).toBe(true)
  expect(mergedAtHead({ git, pr: { ...pr, head: 'c2c2c2c2c2c2' } })).toBe(true)
  expect(mergedAtHead({ git, pr: { ...pr, head: 'c1c1c1c1c1c1c1c1c1c1' } })).toBe(false)
  expect(mergedAtHead({ git, pr: { id: 12, state: 'MERGED', ci: 'none' } })).toBe(false)
  expect(mergedAtHead(byGit)).toBe(false)
  expect(mergedAtHead({ git, pr: { ...pr, state: 'OPEN' } })).toBe(false)
  expect(mergedAtHead({ pr })).toBe(false)
})

/** auto-fix-medium：審查檔裡要自動修的 MEDIUM 只算沒標「不修」「等你決定」的 */
test('test_medium_to_fix_skips_lines_marked_not_fix_or_your_decision', () => {
  const text = [
    '| AC-1 | 做到 | t.ts |',
    '- [MEDIUM][邊界] a.ts:1 — 空字串沒處理',
    '* [medium][重試] b.ts:2 — 逾時沒重試',
    '- [MEDIUM][命名] c.ts:3 — 變數名不清（記錄、不修）',
    '- [MEDIUM][文件] d.md:4 — 少一句（不修）',
    '- [MEDIUM][規格] — AC-2 無法驗證（等你決定）',
    '- [MEDIUM][邊界] e.ts:5 — 上限沒擋（上一輪已列，等你決定）',
    '- [MEDIUM][邏輯] f.ts:6 — 說明裡提到不修會壞，但不是註記',
    '- [HIGH][稽核] g.ts:7 — 漏寫稽核',
    '- [LOW][風格] h.ts:8 — 縮排',
  ].join('\r\n')
  expect(mediumToFix(text)).toBe(3)
  expect(mediumToFix(null)).toBe(0)
  expect(mediumToFix('')).toBe(0)
  expect(mediumToFix('- [HIGH][x] a — b\n- [LOW][y] c — d')).toBe(0)
})

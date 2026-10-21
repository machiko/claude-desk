import { expect, test } from 'claude-code/testing'
import { confirmStep, isArmed, logLines, deploySteps, parseReminders, dueReminders, reminderWhen, reviewTop, parseGitStatus, gitLine, nextCase } from '../hooks/extras'
import { buildCase } from '../hooks/model'

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

test('next case prefers the next one that needs you, then cycles', () => {
  const card = (ask: string) => `<!-- DESK -->\n- 狀態：x\n- 檢查：\`t\`\n- 等你：${ask}\n- 下一步：y\n- 關卡：無\n<!-- /DESK -->`
  const a = buildCase({ name: 'A', statusPath: '/a' }, card('無'), 1, {}, undefined)
  const b = buildCase({ name: 'B', statusPath: '/b' }, card('要嗎？A) 要 B) 不要'), 1, {}, undefined)
  const c = buildCase({ name: 'C', statusPath: '/c' }, card('無'), 1, {}, undefined)
  expect(nextCase([a, b, c], '/a')).toBe('/b')
  expect(nextCase([a, b, c], '/b')).toBe('/c')
  expect(nextCase([a, c], '/c')).toBe('/a')
  expect(nextCase([], null)).toBeNull()
})

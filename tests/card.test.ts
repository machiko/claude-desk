import { expect, test } from 'claude-code/testing'
import { parseRegistry, parseCard, parseDecisions, pickByDigit, unpick, decisionAnswer, allPicked, parseGate, verifyCommand, looksLikeCommand, projectRoot, splitClauses, saysNone, filledAc, hasSpec } from '../hooks/card'
import SPEC_CASES from './spec-cases.mjs'

test('registry rows are any table line with a name and a backticked path; ~ expands', () => {
  const text = `# 登錄\n\n## 任務\n| Project | STATUS path | Scope |\n| --- | --- | --- |\n| 主工作區 | \`~/Workspace/app/.desk/CARD.md\` | 發版 |\n| 會員登入 | \`/abs/wt/.console/STATUS.md\` | |\n\n文字 | 不是列 |`
  expect(parseRegistry(text, '/home/u')).toEqual([
    { name: '主工作區', statusPath: '/home/u/Workspace/app/.desk/CARD.md' },
    { name: '會員登入', statusPath: '/abs/wt/.console/STATUS.md' },
  ])
})

test('the registry Executor column marks manual cases', () => {
  const text = `| Project | path | Scope | Executor |\n| --- | --- | --- | --- |\n| A | \`/a/.desk/CARD.md\` | x | manual |\n| B | \`/b/.desk/CARD.md\` | y | |\n| C | \`/c/.desk/CARD.md\` | z | \`claude\` |`
  expect(parseRegistry(text, '/h')).toEqual([
    { name: 'A', statusPath: '/a/.desk/CARD.md', manual: true },
    { name: 'B', statusPath: '/b/.desk/CARD.md' },
    { name: 'C', statusPath: '/c/.desk/CARD.md' },
  ])
})

test('DESK card fields parse; legacy CARD and 等使用者 are accepted', () => {
  const desk = `# x\n<!-- DESK -->\n- 狀態：一切正常\n- 驗證：\`npm test\` → PASS\n- 等你：無\n- 下一步：做 A\n- 關卡：review：看 diff\n<!-- /DESK -->\n## 其他`
  expect(parseCard(desk)).toEqual({ 狀態: '一切正常', 驗證: '`npm test` → PASS', 等你: '無', 下一步: '做 A', 關卡: 'review：看 diff' })
  const legacy = `<!-- CARD: 說明 -->\n- 更新：2026-10-16 10:00 · rev 3\n- 狀態：舊卡\n- 等使用者：要不要 push？A) 要 B) 不要\n- 下一步：無\n<!-- /CARD -->`
  expect(parseCard(legacy)).toEqual({ 更新: '2026-10-16 10:00 · rev 3', 狀態: '舊卡', 等你: '要不要 push？A) 要 B) 不要', 下一步: '無' })
  expect(parseCard('沒有卡')).toBeNull()
})

test('decisions split on ； outside parentheses, options A) B) or 1) 2)', () => {
  const ask = '要先 push 嗎？A) 先 push B) 等合併（含 git log；看歷史）；CHANGELOG 日期：1) 現在 2) 發版時；只是一句話'
  const d = parseDecisions(ask)
  expect(d.length).toBe(3)
  expect(d[0]).toEqual({ title: '要先 push 嗎？', options: [{ key: 'A', text: '先 push' }, { key: 'B', text: '等合併（含 git log；看歷史）' }] })
  expect(d[1]).toEqual({ title: 'CHANGELOG 日期', options: [{ key: '1', text: '現在' }, { key: '2', text: '發版時' }] })
  expect(d[2]).toEqual({ title: '只是一句話', options: [] })
  expect(parseDecisions('無')).toEqual([])
  expect(parseDecisions('無（等 PM）')).toEqual([])
  expect(splitClauses('a；b;c')).toEqual(['a', 'b', 'c'])
})

test('digits answer decisions in order; backspace steps back; answer reads 1A 2-1', () => {
  const d = parseDecisions('甲：A) a B) b；乙：1) x 2) y')
  let picks = pickByDigit(d, {}, 2)!
  expect(picks).toEqual({ '0': 'B' })
  picks = pickByDigit(d, picks, 1)!
  expect(picks).toEqual({ '0': 'B', '1': '1' })
  expect(allPicked(d, picks)).toBe(true)
  expect(decisionAnswer(d, picks)).toBe('1B 2-1')
  expect(pickByDigit(d, picks, 1)).toBeNull()
  expect(unpick(d, picks)).toEqual({ '0': 'B' })
  expect(decisionAnswer(parseDecisions('單一：A) a B) b'), { '0': 'A' })).toBe('A')
  expect(pickByDigit(d, {}, 9)).toBeNull()
})

test('gate, verify command, none words and project root', () => {
  expect(parseGate('無')).toBeNull()
  expect(parseGate('')).toBeNull()
  expect(parseGate('review: 看 diff')).toEqual({ kind: 'review', detail: '看 diff' })
  expect(parseGate('看 diff')).toEqual({ kind: 'unknown', detail: '看 diff' })
  expect(verifyCommand('`php artisan test` → PASS')).toBe('php artisan test')
  expect(verifyCommand('無')).toBe('')
  // 沒有反引號的說明文字不是指令（見下一支測試）
  expect(verifyCommand('c45c949e 狀態跑過')).toBe('')
  expect(saysNone('無；補充')).toBe(true)
  expect(saysNone('無法確定')).toBe(false)
  expect(projectRoot('/a/b/.desk/CARD.md')).toBe('/a/b')
  expect(projectRoot('/a/b/.console/STATUS.md')).toBe('/a/b')
  expect(projectRoot('/a/b/STATUS.md')).toBe('/a/b')
  expect(projectRoot('C:\\x\\y\\.desk\\CARD.md')).toBe('C:/x/y')
})

test('filled AC follows the same shared spec cases as card.py', () => {
  // 與 card.py 的 filled_ac 同一份範例（skills/card/tests/test_card.py 的 test_filled_ac_matches_shared_spec_cases）
  expect(SPEC_CASES.length).toBeGreaterThan(0)
  for (const c of SPEC_CASES as { name: string; card: string; hasSpec: boolean; ac: string[] }[]) {
    expect({ name: c.name, hasSpec: hasSpec(c.card), ac: filledAc(c.card) }).toEqual({ name: c.name, hasSpec: c.hasSpec, ac: c.ac })
  }
})

test('a placeholder or prose check field counts as no check', () => {
  // 範本佔位：整段被 <…> 包住（不管有沒有反引號）
  expect(verifyCommand('`<完成檢查：修之前會紅、修好會綠的一條指令>`')).toBe('')
  expect(verifyCommand('<完成檢查：修之前會紅、修好會綠的一條指令>')).toBe('')
  // 反引號裡是說明句：第一個字不像指令
  expect(verifyCommand('`待 spec 定，先不跑`')).toBe('')
  expect(verifyCommand('`規格確認後補`')).toBe('')
  expect(verifyCommand('`（暫無）`')).toBe('')
  // 沒有反引號：一律不是指令
  expect(verifyCommand('待規格確認後補')).toBe('')
  expect(verifyCommand('npm test')).toBe('')
  // 正常指令照舊
  expect(verifyCommand('`npm test -- --grep "訂單匯出" && npm test`')).toBe('npm test -- --grep "訂單匯出" && npm test')
  expect(verifyCommand('`test "$(grep -c "^test(\'x" t.ts)" -ge 5 && claude plugin test .`')).toBe('test "$(grep -c "^test(\'x" t.ts)" -ge 5 && claude plugin test .')
  expect(verifyCommand('`./scripts/ci.sh`')).toBe('./scripts/ci.sh')
  expect(verifyCommand('`FOO=1 npm test` → PASS')).toBe('FOO=1 npm test')
  expect(verifyCommand('`~/bin/check`')).toBe('~/bin/check')
  expect(looksLikeCommand('npm test')).toBe(true)
  expect(looksLikeCommand('<npm test>')).toBe(false)
  expect(looksLikeCommand('待 spec 定')).toBe(false)
  expect(looksLikeCommand('')).toBe(false)
})

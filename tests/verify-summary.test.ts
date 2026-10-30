import { expect, test } from 'claude-code/testing'
import { isSeparator, summarizeCheck } from '../hooks/verify-summary'

// 跟 probes.ts 的 verifyResult 一樣：去掉行尾空白、丟掉空行。
const lines = (out: string) => out.split(/[\r\n]+/).map(l => l.trimEnd()).filter(Boolean)

const UNITTEST = `grep -q "test_archive_cleanup_removes_worktree_and_branch_when_merged_and_clean" tests/test_card.py
.....F..........................................
======================================================================
FAIL: test_archive_cleanup_removes_worktree_and_branch_when_merged_and_clean (test_card.ArchiveTest.test_archive_cleanup_removes_worktree_and_branch_when_merged_and_clean)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/home/u/wt/alpha/tests/test_card.py", line 210, in test_archive_cleanup_removes_worktree_and_branch_when_merged_and_clean
    self.assertEqual(len(rows), 9)
AssertionError: 12 != 9

----------------------------------------------------------------------
Ran 48 tests in 1.204s

FAILED (failures=1)`

const UNITTEST_MIXED = `======================================================================
ERROR: test_load (test_io.LoadTest.test_load)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/x/test_io.py", line 5, in test_load
    open('nope')
FileNotFoundError: [Errno 2] No such file or directory: 'nope'

======================================================================
FAIL: test_sum (test_math.SumTest.test_sum)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/x/test_math.py", line 9, in test_sum
    self.assertTrue(False)
AssertionError: False is not true

----------------------------------------------------------------------
Ran 12 tests in 0.010s

FAILED (failures=1, errors=1)`

// claude plugin test 2.x 的真實輸出（2026-10-30 故意弄紅兩支看到的）：名稱行「(fail) 名稱 [耗時]」，原因在下面縮排；計數行「 n fail」。
const PLUGIN_TEST = `
tests/zz-fail.test.ts:
(fail) first failing name [1.76ms]
  AssertionError: expect(received).toBe()

  Expected: 9
  Received: 12
(fail) second failing name [0.20ms]
  Error: boom here
(pass) passes fine [0.23ms]

 1 pass
 2 fail
Ran 3 tests across 1 file. [0.19s]`

const PYTEST = `============================= test session starts ==============================
collected 3 items

tests/test_a.py .F.                                                      [100%]

=================================== FAILURES ===================================
___________________________________ test_sum ___________________________________

    def test_sum():
>       assert 12 == 9
E       assert 12 == 9

tests/test_a.py:4: AssertionError
=========================== short test summary info ============================
FAILED tests/test_a.py::test_sum - assert 12 == 9
FAILED tests/test_a.py::TestIo::test_load - FileNotFoundError: nope
========================= 2 failed, 1 passed in 0.05s ==========================`

const VITEST = ` ❯ tests/a.test.ts (3 tests | 1 failed) 4ms
   × math > adds numbers 3ms
     → expected 12 to be 9 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/a.test.ts > math > adds numbers
AssertionError: expected 12 to be 9 // Object.is equality
 ❯ tests/a.test.ts:5:15

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
   Duration  210ms`

const JEST = ` FAIL  tests/a.test.js
  math
    ✓ subtracts (2 ms)
    ✕ adds numbers (5 ms)

  ● math › adds numbers

    expect(received).toBe(expected) // Object.is equality

    Expected: 9
    Received: 12

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 passed, 2 total`

/** AC-1 */
test('summarizeCheck: python unittest → failing test names with reasons', () => {
  expect(summarizeCheck(lines(UNITTEST))).toEqual({ failed: 1, items: ['test_archive_cleanup_removes_worktree_and_branch_when_merged_and_clean：AssertionError: 12 != 9'] })
  // FAILED (failures=a, errors=b) 兩個加起來；ERROR 段也列出
  expect(summarizeCheck(lines(UNITTEST_MIXED))).toEqual({
    failed: 2,
    items: ["test_load：FileNotFoundError: [Errno 2] No such file or directory: 'nope'", 'test_sum：AssertionError: False is not true'],
  })
})

/** AC-2 */
test('summarizeCheck: plugin test / pytest / vitest counts and names', () => {
  expect(summarizeCheck(lines(PLUGIN_TEST))).toEqual({ failed: 2, items: ['first failing name：AssertionError: expect(received).toBe()（Expected: 9，Received: 12）', 'second failing name：Error: boom here'] })
  expect(summarizeCheck(lines(PYTEST))).toEqual({ failed: 2, items: ['test_sum：assert 12 == 9', 'test_load：FileNotFoundError: nope'] })
  expect(summarizeCheck(lines(VITEST))).toEqual({ failed: 1, items: ['math > adds numbers：AssertionError: expected 12 to be 9 // Object.is equality'] })
  expect(summarizeCheck(lines(JEST))).toEqual({ failed: 1, items: ['math › adds numbers：expect(received).toBe(expected) // Object.is equality（Expected: 9，Received: 12）'] })
  // 認得出框架、但抓不到名稱：計數照算，下面列去掉分隔線的尾巴，並標明那是尾巴不是測試名
  expect(summarizeCheck(lines('collected 0 items / 1 error\n==== 1 failed in 0.1s ====\nImportError: no module x'))).toEqual({ failed: 1, items: ['collected 0 items / 1 error', '==== 1 failed in 0.1s ====', 'ImportError: no module x'], isTail: true })
})

/** AC-4 */
test('summarizeCheck: unknown output falls back to tail without separator lines', () => {
  expect(summarizeCheck(lines('building…\n----------\nstep 2\n==========\nerror: config.yml not found\n   \n---'))).toEqual({ items: ['building…', 'step 2', 'error: config.yml not found'] })
  expect(summarizeCheck(lines('a\nb\nc\nd\ne\nf'))).toEqual({ items: ['c', 'd', 'e', 'f'] })
  expect(summarizeCheck(['sh: 1: nope: not found'])).toEqual({ items: ['sh: 1: nope: not found'] })
  expect(summarizeCheck([])).toEqual({ items: [] })
  expect(isSeparator('-----')).toBe(true)
  expect(isSeparator('= = =')).toBe(true)
  expect(isSeparator('   ')).toBe(true)
  expect(isSeparator('--- a/x')).toBe(false)
  expect(isSeparator('Ran 48 tests')).toBe(false)
})

test('summarizeCheck keeps at most fifty failures and caps long reasons', () => {
  const many = Array.from({ length: 60 }, (_, i) => `(fail) case ${i} [1ms]\n  Error: ${'x'.repeat(300)}`).join('\n') + '\n 60 fail'
  const s = summarizeCheck(lines(many))
  expect(s.failed).toBe(60)
  expect(s.items).toHaveLength(50)
  expect(s.items[0]!.length).toBeLessThanOrEqual(200)
})

test('summarizeCheck: plain ERROR:/FAIL: lines and build errors are not test failures', () => {
  // 只有 unittest 的「FAIL: 名稱 (模組.類別…)」才算；一般錯誤行照 AC-4 列尾巴、不算支數
  expect(summarizeCheck(['ERROR: config.yml not found'])).toEqual({ items: ['ERROR: config.yml not found'] })
  expect(summarizeCheck(['Collecting x', 'ERROR: Could not find a version that satisfies the requirement x', 'ERROR: No matching distribution found for x'])).toEqual({ items: ['Collecting x', 'ERROR: Could not find a version that satisfies the requirement x', 'ERROR: No matching distribution found for x'] })
  expect(summarizeCheck(['FAIL: expected 3 rows, got 2', 'done'])).toEqual({ items: ['FAIL: expected 3 rows, got 2', 'done'] })
  // esbuild 的 ✘ [ERROR] 不是測試失敗
  const esbuild = ['✘ [ERROR] Could not resolve "x"', '    src/a.ts:1:17:', '1 error']
  expect(summarizeCheck(esbuild)).toEqual({ items: esbuild })
  // 舊版 unittest 的名稱行沒有方法名（模組.類別）也認得
  expect(summarizeCheck(lines('FAIL: test_old (test_card.ArchiveTest)\n----\nAssertionError: 1 != 2\nFAILED (failures=1)'))).toEqual({ failed: 1, items: ['test_old：AssertionError: 1 != 2'] })
})

test('summarizeCheck: unittest does not count expected failures', () => {
  const out = 'FAIL: test_a (m.T.test_a)\n----\nAssertionError: x\n----\nRan 3 tests in 0.1s\nFAILED (failures=1, expected failures=1, unexpected successes=1)'
  expect(summarizeCheck(lines(out))).toEqual({ failed: 1, items: ['test_a：AssertionError: x'] })
  expect(summarizeCheck(lines('ERROR: test_b (m.T.test_b)\nOSError: y\nFAILED (errors=2, skipped=1)')).failed).toBe(2)
})

test('summarizeCheck: same test name under different describes keeps its own reason', () => {
  const vitest = ` ❯ tests/a.test.ts (2 tests | 2 failed)
   × alpha > works 1ms
   × beta > works 1ms
 FAIL  tests/a.test.ts > alpha > works
Error: alpha reason
 FAIL  tests/a.test.ts > beta > works
Error: beta reason
      Tests  2 failed (2)`
  expect(summarizeCheck(lines(vitest))).toEqual({ failed: 2, items: ['alpha > works：Error: alpha reason', 'beta > works：Error: beta reason'] })
  const jest = `  alpha
    ✕ works (1 ms)
  beta
    ✕ works (1 ms)
  ● alpha › works
    Error: alpha reason
  ● beta › works
    Error: beta reason
Tests:       2 failed, 2 total`
  expect(summarizeCheck(lines(jest))).toEqual({ failed: 2, items: ['alpha › works：Error: alpha reason', 'beta › works：Error: beta reason'] })
})

test('summarizeCheck caps long reasons without splitting a character', () => {
  // 「e：Error: 」9 個字＋190 個 x＋兩個 emoji＝201 個字：截在第 200 個字，留下完整的第一個 emoji
  const t = summarizeCheck(lines(`(fail) e [1ms]\n  Error: ${'x'.repeat(190)}😀😀\n 1 fail`))
  expect(Array.from(t.items[0]!)).toHaveLength(200)
  expect(t.items[0]!.endsWith('😀')).toBe(true)
})

// Python 3.12 真實輸出（2026-10-30 實跑）：subTest 的名稱行在 (模組.類別.方法) 後面再接 (參數)
const SUBTEST = `.Fu
======================================================================
FAIL: test_sub (test_u.T.test_sub) (i=1)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/x/test_u.py", line 6, in test_sub
    self.assertEqual(i % 2, 0)
AssertionError: 1 != 0

======================================================================
UNEXPECTED SUCCESS: test_xpass (test_u.T.test_xpass)
----------------------------------------------------------------------
Ran 3 tests in 0.001s

FAILED (failures=1, unexpected successes=1)`

test('summarizeCheck: unittest subTest names keep their parameters', () => {
  expect(summarizeCheck(lines(SUBTEST))).toEqual({ failed: 1, items: ['test_sub (i=1)：AssertionError: 1 != 0'] })
  // 收緊後照樣不把一般錯誤行當成 unittest
  expect(summarizeCheck(['ERROR: config.yml not found (see docs)'])).toEqual({ items: ['ERROR: config.yml not found (see docs)'] })
})

test('summarizeCheck: zero failures are not a failure count', () => {
  // plugin test 通過、後面串的指令失敗：照認不出框架列尾巴，不寫 0 支
  const passedThenTsc = lines(`(pass) a [1ms]\n 1 pass\n 0 fail\nRan 1 test across 1 file. [0.20s]\nsrc/a.ts(3,1): error TS2304: Cannot find name 'x'.`)
  expect(summarizeCheck(passedThenTsc)).toEqual({ items: [' 1 pass', ' 0 fail', 'Ran 1 test across 1 file. [0.20s]', "src/a.ts(3,1): error TS2304: Cannot find name 'x'."] })
  // 兩段 plugin test 串接：每段的 n fail 加起來
  const twoRuns = lines(` 2 pass\n 0 fail\nRan 2 tests across 1 file.\n(fail) a [1ms]\n  Error: 1\n(fail) b [1ms]\n  Error: 2\n(fail) c [1ms]\n  Error: 3\n 3 fail\nRan 3 tests across 1 file.`)
  expect(summarizeCheck(twoRuns)).toEqual({ failed: 3, items: ['a：Error: 1', 'b：Error: 2', 'c：Error: 3'] })
  // unittest 只有 unexpected success：沒有失敗的測試，列尾巴
  const xpass = lines(`u\n======\nUNEXPECTED SUCCESS: test_xpass (test_u.T.test_xpass)\n------\nRan 1 test in 0.001s\nFAILED (unexpected successes=1)`)
  expect(summarizeCheck(xpass)).toEqual({ items: ['u', 'UNEXPECTED SUCCESS: test_xpass (test_u.T.test_xpass)', 'Ran 1 test in 0.001s', 'FAILED (unexpected successes=1)'] })
})

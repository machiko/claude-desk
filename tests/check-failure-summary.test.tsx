import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, REGISTRY, result, text, flat } from './fixture'
import { hhmm } from '../hooks/model'
import type { Verify } from '../types'

// 完成檢查沒過時，現在卡的「檢查」列直接列出幾支失敗、哪幾支、為什麼；原始尾巴按 x 才看。
const ROOT = '/home/u/wt/alpha'
const at = 1_000_000

const UNITTEST = `.....F..........................................
======================================================================
FAIL: test_x (test_card.ArchiveTest.test_x)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/home/u/wt/alpha/tests/test_card.py", line 210, in test_x
    self.assertEqual(len(rows), 9)
AssertionError: 12 != 9

----------------------------------------------------------------------
Ran 48 tests in 1.204s

FAILED (failures=1)`

/** 只有 Alpha：檢查 `npm test` 已核准、沒有 Agent、沒有待決策。 */
function alphaOnly(data: any) {
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |`
  data.files[CARD_A] = '<!-- DESK -->\n- 狀態：Alpha 實作完成\n- 檢查：`npm test`\n- 等你：無\n- 下一步：修到檢查綠\n- 關卡：無\n<!-- /DESK -->'
  data.git[ROOT] = { branch: 'feature/alpha', head: 'a1' }
  data.agents = []
  data.store.trustedVerify = { [CARD_A]: 'npm test' }
}

const failing = (over: Partial<Verify>): Verify => ({ command: 'npm test', at, ok: false, exitCode: 1, tail: [], truncated: false, head: 'a1', ...over })

async function mount($: any, clock: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(110))
  await ui.press({ key: `row-${CARD_A}` })
  return ui
}

/** 去掉空白與現在卡的邊條，前後列接在一起看。 */
const screen = async (ui: any) => flat(text(await ui.drawn()))

/** AC-1 */
test('now card shows failure summary instead of raw tail', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data)
  data.run = async (e: any) => e.argv[0] === 'sh' ? result(1, UNITTEST) : result(0, '')
  await $.command.run({ command: 'desk', args: 'verify Alpha' } as any)
  await clock.settle(); await clock.advance(2500); await clock.settle()
  expect(data.processCalls.filter((c: any) => c.argv[0] === 'sh')).toHaveLength(1)

  const v = (data.store.verifies as Record<string, Verify>)[CARD_A]!
  // 修正提示用的尾巴照舊是最後 4 行
  expect(v.tail).toEqual(['AssertionError: 12 != 9', '----------------------------------------------------------------------', 'Ran 48 tests in 1.204s', 'FAILED (failures=1)'])

  const ui = await mount($, clock)
  const shown = await screen(ui)
  // 結果列接失敗支數，緊接著下一列是「測試名：原因」
  expect(shown).toContain(flat(`✕ 未通過（結束碼 1）· ${hhmm(v.at)} · 1 支失敗test_x：AssertionError: 12 != 9`))
  expect(shown).not.toContain('----')
  expect(shown).not.toContain(flat('Ran 48 tests'))
  expect(shown).not.toContain(flat('FAILED (failures=1)'))
  await ui.unmount()
})

/** AC-3 */
test('now card caps failure summary at three and expands with x', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data)
  const items = ['a：Error: 1', 'b：Error: 2', 'c：Error: 3', 'd：Error: 4', 'e：Error: 5']
  data.store.verifies = { [CARD_A]: failing({ summary: { failed: 5, items }, tail: ['e：Error: 5', ' 5 fail', 'Ran 9 tests across 2 files. [1.2s]'] }) }
  const ui = await mount($, clock)

  let shown = await screen(ui)
  expect(shown).toContain(flat(`· ${hhmm(at)} · 5 支失敗a：Error: 1b：Error: 2c：Error: 3還有 2 支（x 展開）npm test`))
  expect(shown).not.toContain(flat('d：Error: 4'))
  expect(shown).not.toContain(flat('Ran 9 tests'))

  // 按 x：全部失敗，再接摘要裡沒有的原始尾巴
  await ui.press({ key: 'expand' })
  shown = await screen(ui)
  expect(shown).toContain(flat('a：Error: 1b：Error: 2c：Error: 3d：Error: 4e：Error: 5npm test 5 failRan 9 tests across 2 files. [1.2s]'))
  expect(shown).not.toContain(flat('還有 2 支'))
  await ui.unmount()
})

/** AC-4 */
test('now card falls back to tail without separator lines when the framework is unknown', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data)
  // 認不出框架：摘要就是去掉分隔線的尾巴，結果列不接支數
  data.store.verifies = { [CARD_A]: failing({ exitCode: 2, summary: { items: ['error: config.yml not found'] }, tail: ['error: config.yml not found', '-----'] }) }
  const ui = await mount($, clock)
  const shown = await screen(ui)
  expect(shown).toContain(flat(`✕ 未通過（結束碼 2）· ${hhmm(at)}error: config.yml not found`))
  expect(shown).not.toContain('支失敗')
  expect(shown).not.toContain('-----')
  await ui.unmount()
})

test('now card lists tail without separator lines for old records without summary', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data)
  data.store.verifies = { [CARD_A]: failing({ tail: ['step 2', '==========', 'boom'] }) }
  const ui = await mount($, clock)
  const shown = await screen(ui)
  expect(shown).toContain(flat(`✕ 未通過（結束碼 1）· ${hhmm(at)}step 2boomnpm test`))
  expect(shown).not.toContain('====')
  await ui.unmount()
})

/** AC-5 */
test('now card keeps passing check rows unchanged', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data)
  data.store.verifies = { [CARD_A]: { command: 'npm test', at, ok: true, exitCode: 0, tail: ['Ran 48 tests in 1.2s', 'OK'], truncated: false, head: 'a1' } }
  const ui = await mount($, clock)
  let shown = await screen(ui)
  expect(shown).toContain(flat(`✓ 通過 ${hhmm(at)}npm test`))
  expect(shown).not.toContain(flat('Ran 48 tests'))
  expect(shown).not.toContain('支失敗')

  await ui.press({ key: 'expand' })
  shown = await screen(ui)
  expect(shown).toContain(flat('npm testRan 48 tests in 1.2sOK'))
  await ui.unmount()
})

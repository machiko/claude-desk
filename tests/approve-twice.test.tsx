import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, REGISTRY, flat, text } from './fixture'
import { PREFIX, ROOT, alphaOnly, helpers, sh } from './alpha-chain'

// 完成檢查的核准改成面板按兩次 v／g：第一次在檢查列列出指令全文，第二次核准並執行（或派工）；全程不跳對話框。
const VERIFY = `${PREFIX}verify`
const GO = `${PREFIX}continue`
const screen = async (ui: any) => flat(text(await ui.drawn()))
/** 按鈕這一段沒列（平常只列現在這一段能做的）就先展開全部動作再按。 */
async function press(ui: any, clock: any, key: string) {
  if (!(await ui.find({ key }))) await ui.press({ key: 'more' })
  await ui.press({ key })
  await clock.settle()
}

/** Alpha 核准過 `node test.mjs`；派出實作後 Agent 把檢查改成 `node test.mjs --all` 做完，自己的流程停在指令沒核准。 */
async function heldAtChangedCheck($: any, on: any) {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const h = helpers($, data, clock)
  await h.refresh()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  h.setCheck('node test.mjs --all')
  await h.finish()
  return { data, clock, h, chain: () => (data.store.chains as any)[ROOT] }
}

/** AC-1 */
test('test_pressing_v_twice_approves_the_changed_check_and_resumes_the_chain', async ($, on) => {
  const { data, clock, h, chain } = await heldAtChangedCheck($, on)
  expect(sh(data)).toBe(0)
  expect(chain().heldAtCheck).toBe(true)
  const ui = await $.ui.mount(PANE(160))

  // 不按鍵：檢查列直接列出改過的全文
  expect(await screen(ui)).toContain(flat('改過的指令（按兩次 v 核准並執行）：node test.mjs --all'))

  // 第一次 v：不跑、不問，列出要核准的那條，按鈕說再按一次
  await press(ui, clock, VERIFY)
  expect(data.asks).toHaveLength(0)
  expect(sh(data)).toBe(0)
  expect(await screen(ui)).toContain(flat('核准這條（再按 v 之後執行）：node test.mjs --all'))
  expect((await ui.find({ key: VERIFY }))?.text).toBe('再按 v 核准並執行測試')

  // 3 秒內第二次 v：記核准、跑檢查、流程接著派審查
  await press(ui, clock, VERIFY)
  await ui.unmount()
  await h.step(); await h.step()
  expect(sh(data)).toBe(1)
  expect(data.store.trustedVerify).toEqual({ [CARD_A]: 'node test.mjs --all' })
  expect(chain().stopped).toBeUndefined()
  expect(data.launches).toHaveLength(2)
  expect(h.prompt(1)).toContain('程式碼審查')
  expect(data.asks).toHaveLength(0)
})

/** AC-2 */
test('test_pressing_g_twice_approves_the_check_and_dispatches_without_a_dialog', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  const h = helpers($, data, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))

  // 第一次 g：不派，檢查列列出要核准的全文
  await press(ui, clock, GO)
  expect(data.launches).toHaveLength(0)
  expect(await screen(ui)).toContain(flat('核准這條（再按 g 之後派工，做完自動執行）：node test.mjs'))

  // 第二次 g：派出實作、記下核准，不跳對話框
  await press(ui, clock, GO)
  await ui.unmount()
  expect(data.launches).toHaveLength(1)
  expect(data.store.trustedVerify).toEqual({ [CARD_A]: 'node test.mjs' })
  expect(data.asks).toHaveLength(0)

  // 做完自動跑檢查
  await h.finish()
  expect(sh(data)).toBe(1)
  expect(data.asks).toHaveLength(0)
})

/** AC-3 */
test('test_single_v_press_runs_an_already_approved_check', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const h = helpers($, data, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))

  await press(ui, clock, VERIFY)
  expect(sh(data)).toBe(1)
  expect(await screen(ui)).not.toContain(flat('核准這條'))
  expect(data.asks).toHaveLength(0)
  await ui.unmount()
})

/** AC-4 */
test('test_desk_go_and_verify_commands_refuse_an_unapproved_check_without_a_dialog', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  const h = helpers($, data, clock)
  await h.refresh()

  const go = await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  const verify = await $.command.run({ command: 'desk', args: 'verify Alpha' } as any)
  await clock.settle(); await h.step()

  expect(String((go as any).text)).toContain('到面板按兩次')
  expect(String((verify as any).text)).toContain('到面板按兩次')
  expect(data.launches).toHaveLength(0)
  expect(sh(data)).toBe(0)
  expect(data.asks).toHaveLength(0)
  expect(data.store.trustedVerify).toBeUndefined()
})

/** AC-5 */
test('test_arming_expires_after_confirm_window', async ($, on) => {
  const { data, clock } = await heldAtChangedCheck($, on)
  const ui = await $.ui.mount(PANE(160))

  await press(ui, clock, VERIFY)
  await clock.advance(3500); await clock.settle()
  // 過了確認時限：第二次只是重新待確認，全文再列一次、沒跑
  await press(ui, clock, VERIFY)
  expect(sh(data)).toBe(0)
  expect(await screen(ui)).toContain(flat('核准這條（再按 v 之後執行）：node test.mjs --all'))
  expect(data.store.trustedVerify).toEqual({ [CARD_A]: 'node test.mjs' })

  // 3 秒內第三次才跑
  await press(ui, clock, VERIFY)
  expect(sh(data)).toBe(1)
  expect(data.asks).toHaveLength(0)
  await ui.unmount()
})

/** 審查 MEDIUM：可歸檔的卡沒展開時檢查只列結果；檢查沒核准，第一次按 v 照樣列出全文，不會核准一條沒看到的指令。 */
test('test_first_v_on_an_archivable_card_lists_the_full_check', async ($, on) => {
  const { data, clock } = fixture(on)
  data.agents = []
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  data.git['/home/u/wt/beta'] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git', tag: 'v0.19.0' }
  data.gh = [{ number: 12, state: 'MERGED', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [] }]
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ key: `case-${CARD_B}-archive` })).toBeDefined()

  await press(ui, clock, `case-${CARD_B}-verify`)
  expect(sh(data)).toBe(0)
  expect(await screen(ui)).toContain(flat('核准這條（再按 v 之後執行）：npm test'))
  await ui.unmount()
})

/** 審查 MEDIUM：按 w 開的流程修完、這張卡從沒核准過檢查而停下：檢查列說「還沒核准的指令」，不說「改過的指令」。 */
test('test_chain_held_on_a_never_approved_check_lists_it_as_unapproved', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  const h = helpers($, data, clock)
  await h.refresh()
  await $.command.run({ command: 'desk', args: 'review Alpha' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  // 審查有 HIGH → 自動修正；修完要跑的檢查從沒核准過 → 停下
  h.setGate('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核')
  await h.finish()
  expect(data.launches).toHaveLength(2)
  expect(h.prompt(1)).toContain('修正第 1／2 輪')
  h.setGate('無')
  data.git[ROOT]!.head = 'h2'
  await h.finish()
  expect(sh(data)).toBe(0)
  expect((data.store.chains as any)[ROOT].stopped).toContain('測試指令還沒經你核准')

  const ui = await $.ui.mount(PANE(160))
  const shown = await screen(ui)
  expect(shown).toContain(flat('還沒核准的指令（按兩次 v 核准並執行）：node test.mjs'))
  expect(shown).not.toContain(flat('改過的指令'))
  await ui.unmount()
})

import { expect, test } from 'claude-code/testing'
import { fixture, PANE } from './fixture'

const HELP_ROW = '停止 Agent（按兩次確認）'

async function mount($: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  return $.ui.mount(PANE(80))
}

const helpLabel = async (ui: any) => (await ui.find({ key: 'help' }))?.text
const hasHelpRows = async (ui: any) => !!(await ui.find({ type: 'Text', text: HELP_ROW }))

/** fixture 的 state.get 攔截只在設了 seedState 時才掛：設了就要真的送到 desk，面板直接是說明頁（跟按 i 一樣）。 */
test('test_fixture_seed_state_reaches_desk', async ($, on) => {
  const { data } = fixture(on)
  data.seedState = { isHelp: true }

  const ui = await mount($)

  expect(await hasHelpRows(ui)).toBe(true)
  expect(await helpLabel(ui)).toBe('▴ 收起說明')
  await ui.unmount()
})

/** 沒設 seedState：照常是一般面板，按 i 才出現說明。 */
test('test_fixture_without_seed_shows_the_normal_pane', async ($, on) => {
  fixture(on)

  const ui = await mount($)

  expect(await hasHelpRows(ui)).toBe(false)
  expect(await helpLabel(ui)).toBe('? 說明')
  await ui.press({ key: 'help' })
  expect(await hasHelpRows(ui)).toBe(true)
  await ui.unmount()
})

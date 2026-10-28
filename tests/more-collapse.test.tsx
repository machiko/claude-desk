import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B } from './fixture'

const BETA = '/home/u/wt/beta'
const MORE = '⋯ 更多動作'
const LESS = '▴ 精簡動作'

/** Beta 在合併段（審查過關、沒有 PR、沒有 Agent 在跑），m 展開後有「退回：」那組；Alpha 照 fixture 等你決定。 */
function betaInMerge(data: any) {
  data.agents = []
  data.gh = []
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 2；可合併')
  data.git[BETA] = { branch: 'feature/b', head: 'c2', remote: 'git@github.com:acme/shop.git', upstream: false }
  data.store.chains = { [BETA]: { owner: 'other-session', startedAt: 0, round: 0, passed: true, reviewHead: 'c2', judgedHead: 'c2' } }
  data.store.verifies = { [CARD_B]: { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'c2' } }
}

async function mount($: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  return $.ui.mount(PANE(100))
}

/** 點清單上那一件（等同按它的數字鍵）。 */
const pick = (ui: any, card: string) => ui.press({ key: `row-${card}` })
/** 現在卡是哪一件：只有現在卡會畫出自己的「↗ 開卡片」鍵。 */
async function focusCard(ui: any): Promise<string | undefined> {
  const keys = (await ui.findAll({ type: 'Button' })).map((b: any) => String(b.key ?? ''))
  return [CARD_A, CARD_B].find(card => keys.includes(`case-${card}-open`))
}
const moreLabel = async (ui: any) => (await ui.find({ key: 'more' }))?.text
const hasRefresh = async (ui: any) => !!(await ui.find({ key: 'refresh' }))
const hasRetreat = async (ui: any) => (await ui.findAll({ type: 'Text' })).some((n: any) => n.text === '退回：')

/** 展開後要看得到的樣子：footer 寫精簡動作、有重新整理。 */
async function expectOpen(ui: any) {
  expect(await moreLabel(ui)).toBe(LESS)
  expect(await hasRefresh(ui)).toBe(true)
}

/** 收合的樣子：footer 回到更多動作，沒有重新整理、沒有「退回：」。 */
async function expectCollapsed(ui: any) {
  expect(await moreLabel(ui)).toBe(MORE)
  expect(await hasRefresh(ui)).toBe(false)
  expect(await hasRetreat(ui)).toBe(false)
}

/** AC-1：m 展開後選別件，footer 收回；再選回原本那件也是收合的。 */
test('test_more_actions_collapse_when_selecting_another_case', async ($, on) => {
  const { data } = fixture(on)
  betaInMerge(data)
  const ui = await mount($)

  await pick(ui, CARD_B)
  expect(await focusCard(ui)).toBe(CARD_B)
  await ui.press({ key: 'more' })
  await expectOpen(ui)
  expect(await hasRetreat(ui)).toBe(true)

  await pick(ui, CARD_A)
  expect(await focusCard(ui)).toBe(CARD_A)
  await expectCollapsed(ui)

  await pick(ui, CARD_B)
  expect(await focusCard(ui)).toBe(CARD_B)
  await expectCollapsed(ui)
  await ui.unmount()
})

/** AC-2：沒有選取時，desk 自動挑的現在卡換人，footer 收回。 */
test('test_more_actions_collapse_when_auto_pick_moves_to_another_case', async ($, on) => {
  const { data } = fixture(on)
  const ui = await mount($)
  expect(await focusCard(ui)).toBe(CARD_A)
  await ui.press({ key: 'more' })
  await expectOpen(ui)

  // Alpha 答完、不再等你：自動挑選改成在跑的 Beta。
  data.files[CARD_A] = data.files[CARD_A]!.replace(/- 等你：.*/, '- 等你：無')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  expect(await focusCard(ui)).toBe(CARD_B)
  await expectCollapsed(ui)
  await ui.unmount()
})

/** AC-3：取消選取讓現在卡換人時收回；關掉面板再用 /desk 開啟一律是收合的。 */
test('test_more_actions_collapse_on_deselect_and_reopen', async ($, on) => {
  const { data } = fixture(on)
  const ui = await mount($)
  await pick(ui, CARD_B)
  await ui.press({ key: 'more' })
  await expectOpen(ui)
  await ui.press({ key: 'deselect' })
  expect(await focusCard(ui)).toBe(CARD_A)
  await expectCollapsed(ui)

  await ui.press({ key: 'more' })
  await expectOpen(ui)
  await ui.unmount()
  await $.command.run({ command: 'desk', args: 'close' } as any)
  expect(data.panes.length).toBe(0)
  await $.command.run({ command: 'desk', args: '' } as any)
  expect(data.panes.map((p: any) => p.id)).toEqual(['desk'])
  const again = await $.ui.mount(PANE(100))
  expect(await focusCard(again)).toBe(CARD_A)
  await expectCollapsed(again)
  await again.unmount()
})

/** AC-4：現在卡沒換人時，重新整理、這件的狀態改變、按 x／i／捲動都維持展開；m 照常切換。 */
test('test_more_actions_stay_open_for_the_same_case', async ($, on) => {
  const { data } = fixture(on)
  const ui = await mount($)
  await ui.press({ key: 'more' })
  await expectOpen(ui)

  await ui.press({ key: 'refresh' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await expectOpen(ui)

  data.files[CARD_A] = data.files[CARD_A]!.replace('Alpha 一切就緒', 'Alpha 換了一句狀態').replace('- 關卡：無', '- 關卡：review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；要修')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  expect(await focusCard(ui)).toBe(CARD_A)
  await expectOpen(ui)

  await ui.press({ key: 'expand' })
  await ui.press({ key: 'help' })
  await $.ui.scroll({ component: 'Pane', requestId: 'desk', offset: 0, by: 2, bodyRows: 16, contentRows: 16, origin: { kind: 'person' } } as any)
  await ui.press({ key: 'help' })
  expect(await focusCard(ui)).toBe(CARD_A)
  await expectOpen(ui)

  await ui.press({ key: 'more' })
  await expectCollapsed(ui)
  await ui.press({ key: 'more' })
  await expectOpen(ui)
  await ui.unmount()
})

/** AC-5：舊版存下的展開狀態是 true：面板照常畫出、是收合的，按 m 可展開。 */
test('test_legacy_boolean_more_state_reads_as_collapsed', async ($, on) => {
  const { data } = fixture(on)
  data.seedState = { showAllActions: true }
  on('state.set', (_: any, e: any, next: any) => {
    if (e?.plugin === 'desk' && e?.key === 'showAllActions') data.seedState = {}
    return next(e)
  })

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(100))
  expect(await focusCard(ui)).toBe(CARD_A)
  await expectCollapsed(ui)

  await ui.press({ key: 'more' })
  await expectOpen(ui)
  await ui.unmount()
})

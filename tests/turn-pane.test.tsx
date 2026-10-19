import { expect, test } from 'claude-code/testing'
import { fixture, PANE, BAND, CARD_A } from './fixture'

test('the now card opens with whose turn it is, and the footer lists only what this stage allows; m shows the rest', async ($, on) => {
  const { data } = fixture(on)
  data.agents = []
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_A}` })
  expect(await ui.find({ type: 'Text', text: '▶ 輪到你' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /按 g 派執行者：push/ })).toBeDefined()
  // 實作段：有 g 與開卡片；檢查與審查還沒到，不出現
  expect(await ui.find({ key: `case-${CARD_A}-continue` })).toBeDefined()
  expect(await ui.find({ key: `case-${CARD_A}-open` })).toBeDefined()
  expect(await ui.find({ key: `case-${CARD_A}-verify` })).toBeUndefined()
  expect(await ui.find({ key: `case-${CARD_A}-review` })).toBeUndefined()
  // m 展開全部
  await ui.press({ key: 'more' })
  expect(await ui.find({ key: `case-${CARD_A}-verify` })).toBeDefined()
  expect((await ui.find({ key: 'more' }))?.text).toBe('▴ 精簡動作')
  await ui.unmount()
  // 摘要列用同一句話
  // 摘要列用同一句話（沒有人在跑時領頭的是工作桌挑的那件）
  const band = await $.ui.mount(BAND(160))
  expect(JSON.stringify(await band.drawn())).toContain('輪到你：按 g 派執行者')
  await band.unmount()
})

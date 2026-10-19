import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A } from './fixture'
import { contentWindow, flowRows, scrollHint, wrapText } from '../hooks/layout'
import { displayWidth } from '../hooks/model'

const scrollBy = ($: any, by: number) => $.ui.scroll({ component: 'Pane', requestId: 'desk', offset: 0, by, bodyRows: 16, contentRows: 16, origin: { kind: 'person' } })
/** 面板畫出來的總列數：header、content、footer 每列都是一個 height 1 的 Box。 */
const rowsOf = (drawn: any) => (drawn.children ?? []).reduce((n: number, child: any) => n + (child.props?.height === 1 ? 1 : (child.children ?? []).length), 0)

test('header and footer stay while only the content scrolls, and the footer says what is above and below', async ($, on) => {
  fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72, 'inline', 16))
  await ui.press({ key: 'help' }) // 說明讓 content 變長
  expect(rowsOf(await ui.drawn())).toBeLessThanOrEqual(16)
  expect(await ui.find({ type: 'Text', text: /^現在$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↓\d+$/ })).toBeDefined()

  await scrollBy($, 100)
  expect(await ui.find({ type: 'Text', text: /^現在$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: / ↑\d+$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 9.9.9' })).toBeDefined() // header 還在
  expect(await ui.find({ key: 'refresh' })).toBeDefined() // footer 還在
  expect(await ui.find({ key: `case-${CARD_A}-open` })).toBeDefined() // 現在這件的操作在 footer，捲走內容熱鍵照樣能按
  expect(rowsOf(await ui.drawn())).toBeLessThanOrEqual(16)

  await scrollBy($, -100)
  expect(await ui.find({ type: 'Text', text: /^現在$/ })).toBeDefined()
  await ui.unmount()
})

test('a pane that fits draws whole with no scroll hint, and scrolling does nothing', async ($, on) => {
  fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72, 'inline', 60))
  expect(await ui.find({ type: 'Text', text: /[↑↓]\d+$/ })).toBeUndefined()
  await scrollBy($, 5)
  expect(await ui.find({ type: 'Text', text: /^現在$/ })).toBeDefined()
  await ui.unmount()
})

test('a docked pane takes the body rows so the footer sits at the bottom', async ($, on) => {
  fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72, 'dock', 40))
  expect((await ui.drawn() as any).props?.height).toBe(40)
  await ui.unmount()
  const inline = await $.ui.mount(PANE(72, 'inline', 40))
  expect((await inline.drawn() as any).props?.height).toBeUndefined()
  await inline.unmount()
})

test('moving to another case (n, or a row) scrolls the content back to the top', async ($, on) => {
  fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72, 'inline', 16))
  await ui.press({ key: 'help' })
  await scrollBy($, 100)
  expect(await ui.find({ type: 'Text', text: /^現在$/ })).toBeUndefined()
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /^現在$/ })).toBeDefined()
  await ui.unmount()
})

test('wrapText keeps every line within the width, counting CJK as two cells', () => {
  const text = 'release/v1.4 與 origin 同步；整套測試 312 綠，等後續功能合入再補 CHANGELOG 日期'
  const lines = wrapText(text, 20)
  expect(lines.length).toBeGreaterThan(1)
  for (const l of lines) expect(displayWidth(l)).toBeLessThanOrEqual(20)
  expect(lines.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''))
})

test('flowRows packs items into rows by width; contentWindow clamps the offset to the last page', () => {
  expect(flowRows([10, 10, 10], 24, 2)).toEqual([[0, 1], [2]])
  expect(flowRows([30], 24, 2)).toEqual([[0]])
  expect(contentWindow(10, 30, 5, 3)).toEqual({ start: 0, size: 10, maxOffset: 0, isScrolled: false })
  const w = contentWindow(30, 16, 6, 99)
  expect(w).toEqual({ start: 20, size: 10, maxOffset: 20, isScrolled: true })
  expect(scrollHint(w, 30)).toBe('↑20')
  expect(scrollHint(contentWindow(30, 16, 6, 4), 30)).toBe('↑4 ↓16')
  expect(contentWindow(30, undefined, 6, 4).isScrolled).toBe(false)
})

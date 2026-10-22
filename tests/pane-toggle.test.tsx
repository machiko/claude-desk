import { expect, test } from 'claude-code/testing'
import { fixture, BAND, PANE } from './fixture'

test('band button closes a shown pane and opens it again', async ($, on) => {
  const { data } = fixture(on)
  await $.command.run({ command: 'desk', args: '' } as any)
  const band = await $.ui.mount(BAND(80))
  await band.press({ key: 'pane' })
  expect(data.panes.length).toBe(0)
  expect((await band.find({ key: 'pane' }))?.text).toBe('⌗ desk ▸')
  await band.press({ key: 'pane' })
  expect(data.panes.map((p: any) => p.id)).toEqual(['desk'])
  expect((await band.find({ key: 'pane' }))?.text).toBe('⌗ desk ▾')
  await band.unmount()
})

test('a pane open but not drawn is opened again by the band button, not closed', async ($, on) => {
  const { data } = fixture(on)
  await $.command.run({ command: 'desk', args: '' } as any)
  // 引擎把面板記成開著、但沒畫出來（例如主動開啟時終端機不夠寬）
  data.panes = [{ id: 'desk', title: 'desk', isShown: false, isFocused: false, isPlaced: false }]
  const band = await $.ui.mount(BAND(80))
  const before = data.opens.length
  await band.press({ key: 'pane' })
  expect(data.closes.length).toBe(0)
  expect(data.opens.length).toBe(before + 1)
  await band.unmount()
})

test('a pane the engine closed without telling desk opens on the next press', async ($, on) => {
  const { data } = fixture(on)
  await $.command.run({ command: 'desk', args: '' } as any)
  data.panes = [] // 畫面出錯被引擎卸下：ui.close 的 hook 不會執行，desk 仍以為開著
  const band = await $.ui.mount(BAND(80))
  const before = data.opens.length
  await band.press({ key: 'pane' })
  expect(data.opens.length).toBe(before + 1)
  expect(data.panes.map((p: any) => p.id)).toEqual(['desk'])
  await band.unmount()
})

test('an open the engine does not draw says why in a toast', async ($, on) => {
  const { data } = fixture(on)
  await $.command.run({ command: 'desk', args: '' } as any)
  const band = await $.ui.mount(BAND(80))
  await band.press({ key: 'pane' })
  data.placeOpen = () => false
  await band.press({ key: 'pane' })
  expect(data.toasts.some(t => t.includes('needs 144 columns') && t.includes('/desk'))).toBe(true)
  await band.unmount()
})

test('pane-toggle: no next button or n hotkey', async ($, on) => {
  fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(100))
  const bindsN = async () => (await ui.findAll({ type: 'Button' })).some((b: any) => b.props?.hotkey === 'n')
  expect(await ui.find({ key: 'next' })).toBeUndefined()
  expect(await bindsN()).toBe(false)
  // 展開更多動作、打開說明也一樣：沒有「→ 下一件」，說明不提 n，沒有任何按鈕綁 n（所以按 n 不做任何事）。
  await ui.press({ key: 'more' })
  await ui.press({ key: 'help' })
  expect(await ui.find({ key: 'next' })).toBeUndefined()
  expect(await bindsN()).toBe(false)
  expect(await ui.find({ type: 'Text', text: /下一件/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^n\s*$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '停止 Agent（按兩次確認）' })).toBeDefined()
  await ui.unmount()
})

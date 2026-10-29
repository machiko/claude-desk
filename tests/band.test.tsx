import { expect, test } from 'claude-code/testing'
import { fixture, BAND, PANE, CARD_B, leaves, text } from './fixture'
import { displayWidth } from '../hooks/model'
import { layoutBand } from '../hooks/band'
import { demoSnapshot } from '../hooks/model'

test('band is one row at every width, never wider than the body, pane button last', async ($, on) => {
  fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  for (const bodyColumns of [120, 80, 60, 47, 30]) {
    const band = await $.ui.mount(BAND(bodyColumns))
    const drawn: any = await band.drawn()
    expect(drawn.props.height).toBe(1)
    expect(drawn.props.width).toBe(bodyColumns)
    const texts = leaves(drawn, 'Text')
    for (const node of texts) expect(text(node).includes('\n')).toBe(false)
    const button = await band.find({ key: 'pane' })
    expect(button?.text).toBe(bodyColumns < 48 ? '⌗' : '⌗ desk ▸')
    const visible = texts.reduce((sum, node) => sum + displayWidth(text(node)), 0) + displayWidth(button!.text)
    expect(visible <= bodyColumns).toBe(true)
    await band.unmount()
  }
})

test('the bar leads with the running case and its stages, and names who waits on you', () => {
  const s = demoSnapshot(Date.parse('2030-01-05T12:00:00Z'))
  const text = (parts: { text: string }[]) => parts.map(p => p.text).join('')
  const wide = layoutBand(s, 140, false)
  expect(text(wide.lead).startsWith('示範  ▶ 訂單匯出 CSV')).toBe(true)
  expect(text(wide.lead)).toContain('規格●')
  expect(text(wide.lead)).toContain('實作◉')
  expect(wide.wait?.text).toBe('● 主工作區（release/v1.4） 等你 +1')
  const mid = layoutBand(s, 72, false)
  expect(text(mid.lead)).toContain('●◉○○○○ 實作')
  expect(displayWidth(text(mid.lead)) + (mid.wait ? displayWidth(mid.wait.text) + 3 : 0) + mid.buttonWidth <= 72).toBe(true)
  const narrow = layoutBand(s, 40, true)
  expect(narrow.button).toBe('⌗')
  expect(narrow.wait).toBeNull()
  const quiet = layoutBand({ ...s, cases: s.cases.map(c => ({ ...c, state: 'idle' as const })) }, 100, false)
  expect(text(quiet.lead)).toBe('示範  ○ 4 件都閒置')
})

test('band yields to a survey and stays hidden after /desk band', async ($, on) => {
  fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  let band = await $.ui.mount({ ...BAND(80), props: { ...BAND(80).props, hasSurvey: true } })
  expect(await band.find({ key: 'pane' })).toBeUndefined()
  await band.unmount()
  await $.command.run({ command: 'desk', args: 'band' } as any)
  band = await $.ui.mount(BAND(80))
  expect(await band.find({ key: 'pane' })).toBeUndefined()
  await band.unmount()
})

test('plain /desk opens or focuses the panel (never closes it, never the bar); /desk close closes', async ($, on) => {
  const { data } = fixture(on)
  const opens = data.opens
  const first = await $.command.run({ command: 'desk', args: '' } as any)
  expect(String(first.text).startsWith('工作桌已開')).toBe(true)
  const second = await $.command.run({ command: 'desk', args: '' } as any)
  expect(String(second.text).startsWith('已切到面板')).toBe(true)
  expect(opens.length).toBe(2)
  expect(opens.every(o => o.focus === true && o.closeOnEscape === true)).toBe(true)
  const third = await $.command.run({ command: 'desk', args: 'close' } as any)
  expect(third.text).toBe('工作桌已收起。')
  const band = await $.ui.mount(BAND(80))
  expect(await band.find({ key: 'pane' })).toBeDefined()
  await band.unmount()
})

test('band: clicking the now card title keeps it selected', async ($, on) => {
  const { data } = fixture(on)
  data.agents = []
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const band = await $.ui.mount(BAND(160))
  const pane = await $.ui.mount(PANE(100))
  const line = async () => leaves(await band.drawn(), 'Text').map(text).join('')
  // 預設：最需要你的那件（Alpha 等你）。
  expect((await line()).startsWith('● Alpha')).toBe(true)
  // 點 Beta：摘要列馬上換成 Beta 的名稱、六段與輪到你那句；Alpha 在等你，右側照舊提示。
  await pane.press({ key: `row-${CARD_B}` })
  const picked = await line()
  expect(picked.includes('Alpha 等你')).toBe(true)
  const lead = picked.slice(0, picked.indexOf('● Alpha'))
  expect(lead).toContain('Beta')
  expect(lead).toContain('規格●')
  expect(lead).toContain('輪到你：按 g 派 Agent：依審核修正')
  // 選了的那件是對話的主角，前面標「已選」。
  expect(lead).toContain('已選')
  // 點現在卡的標題：標題只是文字，沒有按鈕可按；Beta 仍是現在卡、仍標「已選」，不會掉回全部任務。
  await expect(pane.press({ key: `case-${CARD_B}-name` })).rejects.toThrow()
  // 清單照舊留著 Beta 那列（以 ▸ 開頭），是 Beta 唯一的按鈕。
  expect((await pane.findAll({ type: 'Button' })).filter((b: any) => String(b.text ?? '').includes('Beta')).map((b: any) => b.key)).toEqual([`row-${CARD_B}`])
  const still = await line()
  expect(still.slice(0, still.indexOf('● Alpha'))).toContain('Beta')
  expect(still).toContain('已選')
  expect(await pane.find({ type: 'Text', text: /^Beta$/ })).toBeDefined()
  expect((await pane.find({ key: `row-${CARD_B}` }))?.text.startsWith('▸')).toBe(true)
  await pane.unmount()
  await band.unmount()
})

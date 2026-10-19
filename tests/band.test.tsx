import { expect, test } from 'claude-code/testing'
import { fixture, BAND, leaves, text } from './fixture'
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

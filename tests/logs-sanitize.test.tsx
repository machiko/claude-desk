import { expect, test } from 'claude-code/testing'
import { fixture, PANE } from './fixture'

const RAW = ';2;218;124;92mDiscombobulating…\u001b[50;1H\u001b[46;3H\u001b[H\r\u001b[42B·\u001b[3GDiscombobulating…\u001b[50;1H\r\u001b[2C\u001b[42BDiscomb'

test('a running agent whose log tail carries cursor escapes still draws the pane', async ($, on) => {
  const { data } = fixture(on)
  data.logs['bbbbbbbb'] = `● 正在修改 CaseImportService.php\n${RAW}`
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: 'row-/home/u/wt/beta/.desk/CARD.md' })
  const drawn: any = await ui.drawn()
  const all = JSON.stringify(drawn)
  expect(all.includes('Beta')).toBe(true)
  expect(/\\u001b|\\r/.test(all)).toBe(false)
  expect(all.includes('Discombobulating')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /正在修改 CaseImportService\.php/ })).toBeDefined()
  await ui.unmount()
})

import { lastMeaningful, plain } from '../hooks/model'

test('meaningful line skips spinners, timers, token counts and cut fragments', () => {
  const tail = '我改走 EnterWorktree。但卡片檔在主工作區，所以我不建議。\niscombobulating…\n(49s · ↓\n7.1k tokens)\nrunning Stop\nh\noks… 4/7 · 52s · ↓\nCooked for 52s · done 12:07 AM'
  expect(lastMeaningful(tail)).toBe('我改走 EnterWorktree。但卡片檔在主工作區，所以我不建議。')
  expect(lastMeaningful('Discomb')).toBe('')
  expect(lastMeaningful('All tests passed in 3 files')).toBe('All tests passed in 3 files')
  expect(plain('\u001b[31mFAIL\u001b[0m Tests\u0007')).toBe('FAIL Tests')
})

test('a failed check with colored output still draws the pane', async ($, on) => {
  const { data, clock } = fixture(on)
  data.run = async () => ({ exitCode: 1, stdout: '\u001b[31m  FAIL  \u001b[39m Tests\\Feature\\XTest\n\u001b[2K\rTests:  1 failed', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: 'more' }) // 這張卡在等你決定，檢查鍵平常不出現；測檢查本身先展開全部動作
  await ui.press({ key: 'case-/home/u/wt/alpha/.desk/CARD.md-verify' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /✕ 未通過 exit 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Tests:  1 failed/ })).toBeDefined()
  await ui.unmount()
})

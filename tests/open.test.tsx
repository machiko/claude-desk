import { expect, test } from 'claude-code/testing'
import { fixture, CARD_A, result } from './fixture'

const opener = (os: string) => async (e: any) => e.argv[0] === 'uname' ? result(0, `${os}\n`) : result(0, '')

test('macOS opens the card with open', async ($, on) => {
  const { data } = fixture(on)
  data.run = opener('Darwin')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'open Alpha' } as any)
  expect(data.processCalls.map(c => c.argv).filter(a => a[0] !== 'uname')).toEqual([['open', CARD_A]])
})

test('Linux opens the card with xdg-open', async ($, on) => {
  const { data } = fixture(on)
  data.run = opener('Linux')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'open Alpha' } as any)
  expect(data.processCalls.map(c => c.argv).filter(a => a[0] !== 'uname')).toEqual([['xdg-open', CARD_A]])
})

test('a failed open says so', async ($, on) => {
  const { data } = fixture(on)
  data.run = async (e: any) => e.argv[0] === 'uname' ? result(0, 'Linux\n') : result(3, '', 'xdg-open: no method available')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'open Alpha' } as any)
  expect(data.toasts.some(t => t.includes('無法開啟'))).toBe(true)
})

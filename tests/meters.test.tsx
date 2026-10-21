import { expect, test } from 'claude-code/testing'
import { fixture, PANE, NOW } from './fixture'
import { resetText, remainColor, limitParts, gridLayout } from '../hooks/pane'

test('reset time: today shows the time, other days add date and weekday, short form drops both', () => {
  const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString()
  const d = new Date(NOW + 2 * 3_600_000)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const same = new Date(NOW).getDate() === d.getDate()
  expect(resetText(at(2), NOW)).toBe(same ? `${hm} 重置` : resetText(at(2), NOW))
  expect(resetText(at(72), NOW)).toMatch(/^\d{1,2}\/\d{1,2}（[日一二三四五六]）\d{2}:\d{2} 重置$/)
  expect(resetText(at(72), NOW, true)).toMatch(/^\d{1,2}\/\d{1,2} 重置$/)
  expect(resetText(undefined, NOW)).toBe('')
  expect(remainColor(80)).toBe('success')
  expect(remainColor(35)).toBe('warning')
  expect(remainColor(15)).toBe('error')
})

test('the header shows desk version and remaining quota; product versions sit in the footer status', async ($, on) => {
  const { data } = fixture(on)
  data.usage = { startedAt: NOW, context: { percent: 12 }, rateLimits: [{ kind: 'five_hour', percentUsed: 22, resetsAt: new Date(NOW + 3_600_000).toISOString() }, { kind: 'seven_day', percentUsed: 69.5 }] }
  data.git['/home/u/wt/alpha'] = { branch: 'release/v1.4', head: 'h1' }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  expect(await ui.find({ type: 'Text', text: ' 9.9.9' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '5 小時 ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '剩 78%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '本週 ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '剩 31%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '開發中 v1.4' })).toBeDefined()
  await ui.unmount()
  const narrow = await $.ui.mount(PANE(44))
  expect(await narrow.find({ type: 'Text', text: /重置/ })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: '剩 78%' })).toBeDefined()
  await narrow.unmount()
})

test('quota parts drop reset times, then names, as the header narrows; low quota keeps its reset longest', () => {
  const s: any = { limits: [{ kind: 'five_hour', remaining: 30, resetsAt: new Date(NOW + 3_600_000).toISOString() }, { kind: 'seven_day', remaining: 80, resetsAt: new Date(NOW + 86_400_000).toISOString() }] }
  const join = (room: number) => limitParts(s, NOW, room).map(p => p.text).join('')
  expect(join(200)).toMatch(/^5 小時 剩 30%（.+重置）  本週 剩 80%（.+重置）$/)
  expect(join(40)).toMatch(/^5 小時 剩 30%（.+重置）  本週 剩 80%$/)
  expect(join(26)).toBe('5 小時 剩 30%  本週 剩 80%')
  expect(join(10)).toBe('剩 30%  剩 80%')
})

import { modelLabel } from '../hooks/model'

test('model names read like /model: claude-opus-5-5 → Opus 5.5; aliases stay', () => {
  expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelLabel('claude-fable-5-1[1m]')).toBe('Fable 5.1[1m]')
  expect(modelLabel('haiku')).toBe('haiku')
  expect(modelLabel(undefined)).toBe('')
})

test('the footer status shows this session, dispatch and sync models', async ($, on) => {
  const { data } = fixture(on)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  data.files['/home/u/.claude/handoffs/dispatch.json'] = JSON.stringify({ model: 'opus', effort: 'high', sync: { claude: { model: 'haiku' }, session: 'fresh' } })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const wide = await $.ui.mount(PANE(90))
  expect(await wide.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: '派工 opus high' })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: '同步 haiku・新對話' })).toBeDefined()
  await wide.unmount()
  const narrow = await $.ui.mount(PANE(50))
  const drawn: any = await narrow.drawn()
  expect(JSON.stringify(drawn).includes('派工')).toBe(true)
  await narrow.unmount()
})

import { shortCommand } from '../hooks/pane'

test('commands drop the container prefix and keep chained steps readable', () => {
  expect(shortCommand('docker compose exec -T app php artisan test --parallel')).toBe('php artisan test --parallel')
  expect(shortCommand('docker compose exec -T app php artisan test --filter=X && docker compose exec -T app ./vendor/bin/pint --test')).toBe('php artisan test --filter=X  →  ./vendor/bin/pint --test')
  expect(shortCommand('~/work/shop-worktrees/.bin/run-tests login')).toBe('run-tests login')
})

import { displayWidth } from '../hooks/model'

test('the grid gives every row the same name width so the six stages line up, and drops the age before the stages', () => {
  const g = gridLayout(['訂單匯出 CSV', '部署流程改版 cutover'], ['3 分鐘', '5 小時'], 72)
  expect(g.nameWidth).toBe(displayWidth('部署流程改版 cutover'))
  expect(g.ageWidth).toBe(6)
  expect(g.lead).toBe(3 + 2 + g.nameWidth + 2)
  const tight = gridLayout(['訂單匯出 CSV', '部署流程改版 cutover'], ['3 分鐘', '5 小時'], 50)
  expect(tight.nameWidth).toBeLessThan(displayWidth('部署流程改版 cutover'))
  expect(3 + 2 + tight.nameWidth + 2 + 30 + (tight.ageWidth ? tight.ageWidth + 1 : 0) <= 50).toBe(true)
})

test('the header shows only the update time and the list is titled 其他任務', async ($, on) => {
  fixture(on)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  expect(await ui.find({ type: 'Text', text: /件 ·/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ *\d{2}:\d{2} 更新$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^其他任務 *$/ })).toBeDefined()
  await ui.unmount()
})

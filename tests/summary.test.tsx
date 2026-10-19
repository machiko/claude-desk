import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A } from './fixture'
import { compactStatus, cleanSummary, textKey } from '../hooks/digest-status'

const REAL = 'release/v1.4 @ 0c5d0830＝PR #360（hotfix b994c1ca）10-16 15:06 合併；10-18 00:19 讀 git：HEAD 仍為 0c5d0830；工作區有 4 個未追蹤項'

test('rule-based compacting keeps the first clause without hashes, times and parentheses', () => {
  expect(compactStatus(REAL)).toBe('release/v1.4＝PR #360 合併')
  expect(compactStatus('閒置（PM 10-12 指示）。短期修補完成')).toBe('閒置。短期修補完成')
  expect(compactStatus('一切正常')).toBe('一切正常')
})

test('model replies are cleaned to one line', () => {
  expect(cleanSummary('「v1.4.0 已同步，等新功能合入。」\n多的')).toBe('v1.4.0 已同步，等新功能合入')
  expect(textKey('a')).toBe(textKey('a'))
  expect(textKey('a') === textKey('b')).toBe(false)
})

test('haiku condenses the status once; the summary shows and is cached', async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[CARD_A] = data.files[CARD_A]!.replace('- 狀態：Alpha 一切就緒', `- 狀態：${REAL}`)
  const calls: any[] = []
  on('model.complete', (_: any, e: any) => { calls.push(e); return { value: { isAnswered: true as const, text: 'v1.4.0 已同步，等新功能合入', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(72))
  expect(await ui.find({ type: 'Text', text: 'v1.4.0 已同步，等新功能合入' })).toBeDefined()
  await ui.unmount()
  const forA = calls.filter(c => String(c.prompt).includes('0c5d0830'))
  expect(forA.length).toBe(1)
  expect(forA[0].model).toBe('haiku')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(calls.filter(c => String(c.prompt).includes('0c5d0830')).length).toBe(1)
})

test('summaryModel off never calls a model and still shows the compact line', { options: { summaryModel: 'off' } } as any, async ($, on) => {
  const { data, clock } = fixture(on)
  data.files[CARD_A] = data.files[CARD_A]!.replace('- 狀態：Alpha 一切就緒', `- 狀態：${REAL}`)
  let called = 0
  on('model.complete', () => { called++; return { value: { isAnswered: true as const, text: 'x', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(72))
  expect(await ui.find({ type: 'Text', text: 'release/v1.4＝PR #360 合併' })).toBeDefined()
  await ui.unmount()
  expect(called).toBe(0)
})

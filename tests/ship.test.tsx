import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_B } from './fixture'
import { confirmShip } from '../hooks/card'

const DESK = `# A\n\n<!-- DESK -->\n- 狀態：已合併\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：上線\n- 關卡：release：v0.2.0 待上線確認\n<!-- /DESK -->\n\n## History\n\n- 2026-10-18：合併\n`
const CARD = `# B\n\n<!-- CARD: 看板只讀這個區塊 -->\n- 更新：2026-10-17 09:00 · rev 7 · job x · Agent 更新\n- 狀態：已合併\n- 驗證：\`npm test\`\n- 等使用者：無\n- 下一步：上線\n- 關卡：release：v1.4.0\n<!-- /CARD -->\n\n## History\n\n- 2026-10-17：合併\n`

test('confirming ship clears only the release gate and logs it; an old card bumps its rev', () => {
  const desk = confirmShip(DESK, '2026-10-18', '21:30', 'v0.2.0', '可歸檔：/desk:card archive a')!
  expect(desk).toContain('- 關卡：無')
  expect(desk).toContain('- 狀態：v0.2.0 已上線（工作桌確認）')
  expect(desk).toContain('- 下一步：可歸檔：/desk:card archive a')
  expect(desk.trimEnd().endsWith('- 2026-10-18：使用者在工作桌確認 v0.2.0 已上線，release 關卡清為無')).toBe(true)
  expect(confirmShip(DESK, '2026-10-18', '21:30', 'v0.2.0', 'x', 'Alex')!.trimEnd().endsWith('- 2026-10-18：Alex 在工作桌確認 v0.2.0 已上線，release 關卡清為無')).toBe(true)
  const card = confirmShip(CARD, '2026-10-18', '21:30', 'v1.4.0', '等下一版開發')!
  expect(card).toContain('- 下一步：等下一版開發')
  expect(card).toContain('- 關卡：無')
  expect(card).toContain('- 更新：2026-10-18 21:30 · rev 8 · desk 上線確認')
  // 關卡不是 release 就不動卡片
  expect(confirmShip(DESK.replace('release：v0.2.0 待上線確認', '無'), '2026-10-18', '21:30', 'v0.2.0', 'x')).toBeNull()
})

test('the ship button shows only when a tag holds the commit and the gate is release; two presses clear the gate', async ($, on) => {
  const { data, clock } = fixture(on)
  data.agents = []
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', '- 關卡：release：v0.2.0 待上線確認')
  data.git['/home/u/wt/beta'] = { branch: 'feature/b', head: 'h1', tag: 'v0.2.0' }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: `row-${CARD_B}` })
  const key = `case-${CARD_B}-ship`
  expect((await ui.find({ key }))?.text).toBe('✓ 上線確認')
  await ui.press({ key })
  expect(data.files[CARD_B]).toContain('- 關卡：release：')
  expect((await ui.find({ key }))?.text).toBe('再按 u 確認已上線（清除 release 關卡）')
  await ui.press({ key })
  await clock.settle()
  expect(data.files[CARD_B]).toContain('- 關卡：無')
  expect(data.files[CARD_B]).toContain('確認 v0.2.0 已上線')
  expect(data.files[CARD_B]).toContain('- 下一步：可歸檔：/desk:card archive beta')
  // 重新整理後：案子變成「完成」，現在卡寫已上線與 ✓ 完成，只能同步
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  expect(await ui.find({ type: 'Text', text: '  已上線' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✓ 完成 v0\.2\.0/ })).toBeDefined()
  expect(await ui.find({ key: `case-${CARD_B}-continue` })).toBeUndefined()
  expect(await ui.find({ key: `case-${CARD_B}-ship` })).toBeUndefined()
  await ui.unmount()
})

test('no ship button before the tag exists', async ($, on) => {
  const { data } = fixture(on)
  data.agents = []
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', '- 關卡：release：v0.2.0 待上線確認')
  data.git['/home/u/wt/beta'] = { branch: 'feature/b', head: 'h1' }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ key: `case-${CARD_B}-ship` })).toBeUndefined()
  await ui.unmount()
})

test('a tag made after desk first looked is seen on the next refresh', async ($, on) => {
  const { data } = fixture(on)
  data.agents = []
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', '- 關卡：release：v0.2.0 待上線確認')
  data.git['/home/u/wt/beta'] = { branch: 'feature/b', head: 'h-same' }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  data.git['/home/u/wt/beta'] = { branch: 'feature/b', head: 'h-same', tag: 'v0.2.0' } // 同一個 commit，之後才打 tag
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: `row-${CARD_B}` })
  expect((await ui.find({ key: `case-${CARD_B}-ship` }))?.text).toBe('✓ 上線確認')
  await ui.unmount()
})

import { finalState } from '../hooks/pipeline'
import { dispatchable } from '../hooks/dispatch'

test('a case whose six stages are all through is done; anything still open keeps its state', () => {
  const stages = (last: string) => ['spec', 'build', 'check', 'review', 'merge', 'ship'].map((id, i) => ({ id, label: id, status: i < 5 ? 'done' : last })) as any
  const base: any = { state: 'ready', pipeline: { stages: stages('done'), current: null, note: '' } }
  expect(finalState(base)).toBe('done')
  expect(finalState({ ...base, state: 'idle' })).toBe('done')
  expect(finalState({ ...base, state: 'ask' })).toBe('ask')
  expect(finalState({ ...base, pipeline: { stages: stages('wait'), current: 'ship', note: '' } })).toBe('ready')
  expect(finalState({ ...base, pipeline: undefined })).toBe('ready')
  expect(dispatchable({ ...base, state: 'done', next: '可歸檔', verify: '`npm test`', hasCard: true, root: '/p/a', statusPath: '/p/a/.desk/CARD.md', name: 'A', status: '', ask: '無', gate: '無', updatedAt: 0 })).toEqual(['sync'])
})

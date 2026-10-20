import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, CARD_C, REGISTRY, NOW, text } from './fixture'
import { setFields } from '../hooks/tutorial'
import { events, feedOf, keepFeed } from '../hooks/model'
import type { Case, FeedEvent } from '../types'

const flat = (x: string) => x.replace(/\s+/g, '')
const screen = async (ui: any) => flat(text(await ui.drawn()))
const ev = (text: string, card?: string, at = NOW): FeedEvent => ({ at, text, tone: 'subtle', ...(card ? { card } : {}) })
const kase = (statusPath: string) => ({ statusPath }) as Case

/** Alpha、Beta 兩件；都沒有等你、沒有 Agent，誰被選取誰就是現在這件。 */
function twoCases(data: any) {
  data.files[REGISTRY] = `## 案子\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_A] = setFields(data.files[CARD_A]!, { 等你: '無' })
  data.agents = []
  data.gh = []
}

test('feed keeps only the focused case and events that belong to no case', () => {
  const feed = [ev('Alpha 開始執行', CARD_A), ev('desk 有新版本 0.24.0'), ev('Beta 檢查通過', CARD_B)]
  const cases = [kase(CARD_A), kase(CARD_B)]
  expect(feedOf(feed, kase(CARD_B), cases).map(e => e.text)).toEqual(['desk 有新版本 0.24.0', 'Beta 檢查通過'])
  expect(feedOf(feed, kase(CARD_A), cases).map(e => e.text)).toEqual(['Alpha 開始執行', 'desk 有新版本 0.24.0'])
})

test('feed still shows events of a case that has left the desk', () => {
  // 歸檔後那件不在登錄表了：剛做的「已歸檔」照樣看得到。
  const feed = [ev('Gamma 已歸檔', CARD_C), ev('Alpha 開始執行', CARD_A)]
  expect(feedOf(feed, kase(CARD_B), [kase(CARD_A), kase(CARD_B)]).map(e => e.text)).toEqual(['Gamma 已歸檔'])
})

test('a busy case cannot push the focused case out of the feed', () => {
  // Beta 先記一筆，之後 Alpha 連記 20 筆：Beta 那筆仍留著。
  let list: FeedEvent[] = keepFeed([ev('Beta 檢查通過', CARD_B)])
  for (let i = 0; i < 20; i++) list = keepFeed([ev(`Alpha 第 ${i} 筆`, CARD_A), ...list])
  expect(list.some(e => e.text === 'Beta 檢查通過')).toBe(true)
  expect(list.filter(e => e.card === CARD_A)).toHaveLength(12)
  expect(list[0]!.text).toBe('Alpha 第 19 筆')
})

test('case events carry the card they belong to', () => {
  const card = (statusPath: string, state: Case['state'], ask = '無') => ({ statusPath, name: statusPath === CARD_A ? 'Alpha' : 'Beta', state, ask, gate: '無', next: '', status: '' }) as unknown as Case
  const prev = { at: NOW, cases: [card(CARD_A, 'idle'), card(CARD_B, 'idle')], error: null, contextPercent: null }
  const cur = { ...prev, at: NOW + 1000, cases: [card(CARD_A, 'running'), card(CARD_B, 'idle')] }
  const out = events(prev, cur)
  expect(out).toHaveLength(1)
  expect(out[0]!.card).toBe(CARD_A)
})

test('the recent feed shows only what happened to the case on the now card', async ($, on) => {
  const { data } = fixture(on)
  twoCases(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  // 兩件都有動靜：Alpha 等你、Beta 進入關卡。
  data.files[CARD_A] = setFields(data.files[CARD_A]!, { 等你: '要 push 嗎？A) 要 B) 等' })
  data.files[CARD_B] = setFields(data.files[CARD_B]!, { 關卡: 'spec：待確認規格' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  // 先選 Beta：最近只有 Beta 的。
  await ui.press({ key: `row-${CARD_B}` })
  let drawn = await screen(ui)
  expect(drawn).toContain(flat('Beta 進入關卡'))
  expect(drawn).not.toContain(flat('Alpha 等你'))
  // 改選 Alpha：換成 Alpha 的。
  await ui.press({ key: `row-${CARD_A}` })
  drawn = await screen(ui)
  expect(drawn).toContain(flat('Alpha 等你'))
  expect(drawn).not.toContain(flat('Beta 進入關卡'))
  await ui.unmount()
})

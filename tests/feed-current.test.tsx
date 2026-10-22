import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, CARD_C, REGISTRY, NOW, text } from './fixture'
import { setFields } from '../hooks/tutorial'
import { events, feedOf, feedOnDesk, keepFeed } from '../hooks/model'
import type { Case, FeedEvent } from '../types'

const flat = (x: string) => x.replace(/\s+/g, '')
const screen = async (ui: any) => flat(text(await ui.drawn()))
const ev = (text: string, card?: string, at = NOW): FeedEvent => ({ at, text, tone: 'subtle', ...(card ? { card } : {}) })
const kase = (statusPath: string) => ({ statusPath }) as Case

/** Alpha、Beta 兩件；都沒有等你、沒有 Agent，誰被選取誰就是現在這件。 */
function twoCases(data: any) {
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_A] = setFields(data.files[CARD_A]!, { 等你: '無' })
  data.agents = []
  data.gh = []
}

test('feed keeps only the focused case and events that belong to no case', () => {
  const feed = [ev('Alpha 開始執行', CARD_A), ev('desk 有新版本 0.24.0'), ev('Beta 檢查通過', CARD_B)]
  expect(feedOf(feed, kase(CARD_B)).map(e => e.text)).toEqual(['desk 有新版本 0.24.0', 'Beta 檢查通過'])
  expect(feedOf(feed, kase(CARD_A)).map(e => e.text)).toEqual(['Alpha 開始執行', 'desk 有新版本 0.24.0'])
})

test('a case that left the desk cannot crowd out the focused case', () => {
  // Gamma 歸檔前記了好幾筆，歸檔那筆不掛在卡上；現在這件 Alpha 的那筆仍在前三列。
  const gone = Array.from({ length: 5 }, (_, i) => ev(`Gamma 第 ${i} 筆`, CARD_C, NOW + 10 - i))
  const feed = [ev('Gamma 已歸檔'), ...gone, ev('Alpha 開始執行', CARD_A, NOW)]
  const shown = feedOf(feed, kase(CARD_A)).slice(0, 3).map(e => e.text)
  expect(shown).toEqual(['Gamma 已歸檔', 'Alpha 開始執行'])
})

test('events of cases no longer on the desk are dropped from the feed', () => {
  // 歸檔或換專案：不在這份登錄表的卡，動態清掉；不屬於任何一件的留著。
  const feed = [ev('Gamma 檢查通過', CARD_C), ev('Gamma 已歸檔'), ev('Alpha 開始執行', CARD_A)]
  expect(feedOnDesk(feed, [kase(CARD_A), kase(CARD_B)]).map(e => e.text)).toEqual(['Gamma 已歸檔', 'Alpha 開始執行'])
  expect(feedOnDesk(feed, [])).toEqual([ev('Gamma 已歸檔')])
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

/** 沒選任何一件時，現在這件由工作桌自己挑（等你的優先）：「最近」跟著它，挑到別件就換。 */
test('the recent feed follows the case the desk picks when nothing is selected', async ($, on) => {
  const { data } = fixture(on)
  twoCases(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  data.files[CARD_A] = setFields(data.files[CARD_A]!, { 等你: '要 push 嗎？A) 要 B) 等' })
  data.files[CARD_B] = setFields(data.files[CARD_B]!, { 關卡: 'spec：待確認規格' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  const alphaFocused = await screen(ui)
  // Alpha 的決策處理完、換 Beta 等你：現在這件換成 Beta
  data.files[CARD_A] = setFields(data.files[CARD_A]!, { 等你: '無' })
  data.files[CARD_B] = setFields(data.files[CARD_B]!, { 關卡: '無', 等你: '要合併嗎？A) 要 B) 等' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const betaFocused = await screen(ui)
  await ui.unmount()

  expect(alphaFocused).toContain(flat('Alpha 等你'))
  expect(alphaFocused).not.toContain(flat('Beta 進入關卡'))
  expect(betaFocused).toContain(flat('Beta 等你'))
  expect(betaFocused).not.toContain(flat('Alpha 等你'))
})

test('a case removed from the registry leaves nothing behind in the recent feed', async ($, on) => {
  const { data } = fixture(on)
  // 每次寫入「最近」的內容：不只看畫面，也看 refresh 有沒有真的把離桌那件的動態清掉。
  let stored: FeedEvent[] = []
  on('state.set', (_: any, e: any, next: any) => { if (e?.plugin === 'desk' && e?.key === 'feed') stored = e.value; return next(e) })
  const gamma = () => stored.filter(e => e.card === CARD_C).length
  data.agents = []
  data.gh = []
  data.files[CARD_A] = setFields(data.files[CARD_A]!, { 等你: '無' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  // Gamma 連續幾件事：等你、換題、進關卡；Alpha 只有一件。
  data.files[CARD_C] = setFields(data.files[CARD_C]!, { 等你: '要合併嗎？A) 要 B) 等' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  data.files[CARD_C] = setFields(data.files[CARD_C]!, { 等你: '要打 tag 嗎？A) 要 B) 等' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  data.files[CARD_A] = setFields(data.files[CARD_A]!, { 關卡: 'spec：待確認規格' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  data.files[CARD_C] = setFields(data.files[CARD_C]!, { 等你: '無', 關卡: 'release：待上線' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  expect(gamma()).toBeGreaterThan(0)
  // Gamma 離開登錄表（歸檔、或換了專案）。
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |\n| Beta | \`${CARD_B}\` |`
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  if (await ui.find({ key: `row-${CARD_A}` })) await ui.press({ key: `row-${CARD_A}` })
  const drawn = await screen(ui)
  expect(drawn).toContain(flat('Alpha 進入關卡'))
  expect(drawn).not.toContain(flat('Gamma'))
  expect(gamma()).toBe(0)
  expect(stored.some(e => e.card === CARD_A)).toBe(true)
  await ui.unmount()
})

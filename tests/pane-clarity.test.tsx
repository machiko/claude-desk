import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, CARD_C, NOW, leaves, result, text, flat } from './fixture'
import { limitParts, resetText } from '../hooks/pane'
import { hhmm } from '../hooks/model'

/** 面板上每段字（巢狀的 Text 併成一段），保留空白，比對完整句子。 */
const pieces = async (ui: any): Promise<string[]> => leaves(await ui.drawn(), 'Text').map(text)
const screen = async (ui: any) => flat((await pieces(ui)).join(''))

/** NOW 當地日期往後 days 天的 h:m（ISO 字串，跟 session.usage 的 resetsAt 一樣）。 */
function localAt(days: number, h: number, m: number): string {
  const n = new Date(NOW)
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() + days, h, m).toISOString()
}
/** 從 NOW 那天往後數到下一個週三（至少兩天後，才不會變成「明天」）。 */
const WED = 3
const daysToWednesday = () => {
  const d = (WED - new Date(NOW).getDay() + 7) % 7
  return d < 2 ? d + 7 : d
}
/** 5 小時剩 78%、今天 22:30 重置；本週剩 31%、下週三 09:00 重置。 */
const LIMITS = () => [
  { kind: 'five_hour', percentUsed: 22, resetsAt: localAt(0, 22, 30) },
  { kind: 'seven_day', percentUsed: 69, resetsAt: localAt(daysToWednesday(), 9, 0) },
]
const snapshotLimits = (fiveAt = localAt(0, 22, 30)): any => ({ limits: [
  { kind: 'five_hour', remaining: 78, resetsAt: fiveAt },
  { kind: 'seven_day', remaining: 31, resetsAt: localAt(daysToWednesday(), 9, 0) },
] })
const join = (s: any, room: number) => limitParts(s, NOW, room).map(p => p.text).join('')

/** AC-1：額度寫成「窗口（重置時間）剩 n%」，130 欄全寫、80 欄本週只留星期、最窄只剩百分比。 */
test('test_quota_shows_window_then_next_reset_time', async ($, on) => {
  const { data } = fixture(on)
  data.usage = { startedAt: NOW, context: { percent: 12 }, rateLimits: LIMITS() }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)

  const wide = await $.ui.mount(PANE(130))
  expect(await pieces(wide)).toContain('5 小時（22:30 重置）剩 78%  本週（週三 09:00 重置）剩 31%')
  await wide.unmount()

  const mid = await $.ui.mount(PANE(80))
  expect(await pieces(mid)).toContain('5 小時（22:30 重置）剩 78%  本週（週三）剩 31%')
  await mid.unmount()

  const narrow = await $.ui.mount(PANE(44))
  const rows = await pieces(narrow)
  expect(rows).toContain('剩 78%  剩 31%')
  expect(rows.some(r => /重置|5 小時|本週/.test(r))).toBe(false)
  await narrow.unmount()
})

/** AC-1：變窄時先拿掉本週的時刻、再拿掉本週的星期，5 小時的重置時間留到最後，最後才拿掉名稱。 */
test('test_quota_drops_weekly_time_before_five_hour_reset_when_narrow', () => {
  const s = snapshotLimits()
  expect(join(s, 200)).toBe('5 小時（22:30 重置）剩 78%  本週（週三 09:00 重置）剩 31%')
  expect(join(s, 50)).toBe('5 小時（22:30 重置）剩 78%  本週（週三）剩 31%')
  expect(join(s, 45)).toBe('5 小時（22:30 重置）剩 78%  本週 剩 31%')
  expect(join(s, 38)).toBe('5 小時 剩 78%  本週 剩 31%')
  expect(join(s, 20)).toBe('剩 78%  剩 31%')
})

/** AC-1：5 小時的重置跨過午夜寫「明天」；更遠的日子寫日期。 */
test('test_five_hour_reset_after_midnight_says_tomorrow', () => {
  expect(join(snapshotLimits(localAt(1, 1, 30)), 200)).toBe('5 小時（明天 01:30 重置）剩 78%  本週（週三 09:00 重置）剩 31%')
  expect(resetText(localAt(1, 1, 30), NOW)).toBe('明天 01:30 重置')
  expect(resetText(localAt(1, 1, 30), NOW, true)).toBe('明天')
  expect(resetText(localAt(0, 22, 30), NOW, true)).toBe('今天')
  const far = new Date(localAt(9, 9, 0))
  expect(resetText(far.toISOString(), NOW)).toBe(`${far.getMonth() + 1}/${far.getDate()} 09:00 重置`)
  expect(resetText(undefined, NOW)).toBe('')
})

/** AC-2：查過、GitHub 上的版號跟已安裝的一樣：footer 是淡字「✓ 已是最新版本」，不是按鈕，也沒有更新按鈕。 */
test('test_up_to_date_shows_plain_text_without_update_button', async ($, on) => {
  const { data, clock } = fixture(on)
  data.store.updateCheck = { at: NOW - 60 * 60_000, latest: '9.9.9', current: '9.9.9' }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(130))

  const note = await ui.find({ type: 'Text', text: '✓ 已是最新版本' })
  expect(note).toBeDefined()
  expect(note?.props?.color).toBe('inactive')
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.some((b: any) => /已是最新版本|更新/.test(String(b.text ?? '')))).toBe(false)
  expect(await ui.find({ key: 'update' })).toBeUndefined()
  expect(await screen(ui)).not.toContain(flat('⇡ 更新版本'))
  // 點它也不會跑更新：它不是按鈕，按不下去，也沒去查已安裝的 desk。
  let plugin = 0
  data.exec = (e: any) => { if (e.argv[0] === 'claude' && e.argv[1] === 'plugin') plugin++; return null }
  let pressed = true
  try { await ui.press({ key: 'update-status' }) } catch { pressed = false }
  await clock.settle()
  expect(pressed).toBe(false)
  expect(plugin).toBe(0)
  expect(data.toasts.some(t => /desk (已更新|無法更新|已是最新)/.test(t))).toBe(false)
  await ui.unmount()
})

/** AC-3：有新版、沒查過、更新中三種版本格；前兩者是按鈕，按下去跟 /desk update 一樣。 */
test('test_update_slot_names_target_version_or_check_or_progress', async ($, on) => {
  const { data, clock } = fixture(on)
  // 有新版 10.0.0：按鈕寫目標版本，header 照樣有「有新版本 10.0.0」。
  data.store.updateCheck = { at: NOW - 60 * 60_000, latest: '10.0.0', current: '9.9.9', notified: '10.0.0' }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  let ui = await $.ui.mount(PANE(130))
  const newer = await ui.find({ key: 'update' })
  expect(newer?.type).toBe('Button')
  expect(newer?.text).toBe('⇡ 更新到 10.0.0')
  expect(newer?.props?.hotkey).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '  有新版本 10.0.0' })).toBeDefined()
  await ui.press({ key: 'update' })
  await clock.settle()
  // 測試裡讀不到已安裝的 desk：結果跟 /desk update 一樣是「無法更新」。
  const out = await $.command.run({ command: 'desk', args: 'update' } as any) as any
  expect(out.text).toMatch(/^desk 無法更新/)
  expect(data.toasts.filter(t => t === out.text).length).toBe(2)
  await ui.unmount()

  // 從沒查過（或上次沒查成功）：按鈕是「檢查並更新」。
  delete data.store.updateCheck
  data.toasts = []
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  ui = await $.ui.mount(PANE(130))
  const unknown = await ui.find({ key: 'update' })
  expect(unknown?.type).toBe('Button')
  expect(unknown?.text).toBe('⇡ 檢查並更新')
  await ui.press({ key: 'update' })
  await clock.settle()
  expect(data.toasts.filter(t => t === out.text).length).toBe(1)

  // 正在更新：版本格是「◐ 更新中…」，不是按鈕；更新中重新整理也不會蓋掉。
  let release = () => {}
  const gate = new Promise<void>(r => { release = r })
  data.exec = async (e: any) => (e.argv[0] === 'claude' && e.argv[1] === 'plugin' ? (await gate, result(1, '', 'plugin list unavailable in tests')) : null)
  const running = $.command.run({ command: 'desk', args: 'update' } as any)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: '◐ 更新中…' })).toBeDefined()
  expect(await ui.find({ key: 'update' })).toBeUndefined()
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: '◐ 更新中…' })).toBeDefined()
  release()
  await running
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: '◐ 更新中…' })).toBeUndefined()
  expect((await ui.find({ key: 'update' }))?.text).toBe('⇡ 檢查並更新')
  await ui.unmount()
})

/** AC-4：時間都寫「多久前」；卡片列的「前」不重複。 */
test('test_ages_read_as_time_ago', async ($, on) => {
  const { data } = fixture(on)
  data.mtimes[CARD_A] = NOW - 20 * 60_000
  data.mtimes[CARD_B] = NOW - 30_000
  data.mtimes[CARD_C] = NOW - 2 * 86_400_000
  data.git['/home/u/wt/gamma'] = { branch: 'feature/c', head: 'h3', commitAt: NOW - 3 * 60_000 }
  data.agents = [] // Agent 在跑的那列改寫已執行多久；這裡看的是「多久前」
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(130))
  // 現在卡 Alpha 20 分鐘前；進度表 Beta 剛剛、Gamma 2 天前。
  const rows = await pieces(ui)
  expect(rows).toContain(' · 20 分鐘前')
  expect(rows.some(r => /剛剛$/.test(r))).toBe(true)
  expect(rows.some(r => /2 天前$/.test(r))).toBe(true)
  // 選 Gamma 到現在卡：標題的時間與「分支比卡片新」那列。
  await ui.press({ key: `row-${CARD_C}` })
  const now = await screen(ui)
  expect(now).toContain(flat('· 2 天前'))
  expect(now).toContain(flat('分支最近一次變更（3 分鐘前）比卡片新'))
  expect(now).not.toContain('前前')
  await ui.unmount()
})

/** AC-5：header 寫「讀取」；footer 的上下文、容器、模型講清楚方向與意思；檢查失敗寫結束碼。 */
test('test_status_words_state_direction_and_meaning', { options: { composeDir: '/home/u/app' } }, async ($, on) => {
  const { data, clock } = fixture(on)
  data.usage = { startedAt: NOW, context: { percent: 62 }, rateLimits: [] }
  const svc = (Service: string) => JSON.stringify({ Service, State: 'running', Health: '' })
  data.compose = [svc('app'), svc('mysql')].join('\n')
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  data.run = async () => result(1, '', 'boom')
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(130))

  const rows = await pieces(ui)
  expect(rows).toContain(`   ${hhmm(NOW)} 讀取`)
  expect(rows.some(r => /\d{2}:\d{2} 更新$/.test(r))).toBe(false)
  const footer = rows.find(r => r.includes('上下文已用 62%'))
  expect(footer).toBeDefined()
  expect(footer).toContain('● 容器 2/2 執行中')
  expect(footer).toContain('本對話 Opus 5.5')

  await ui.press({ key: 'more' }) // Alpha 在等你決定，檢查鍵平常不出現
  await ui.press({ key: `case-${CARD_A}-verify` })
  await clock.settle()
  expect(await pieces(ui)).toContain(`✕ 未通過（結束碼 1）· ${hhmm(NOW)}`)
  await ui.unmount()
})

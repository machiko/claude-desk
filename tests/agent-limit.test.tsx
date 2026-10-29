import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, CARD_C, result, text, flat } from './fixture'
import { isDeskLaunch } from '../hooks/dispatch'

// 派工負載：同時在跑的工作桌 Agent 有上限（預設 3），再派的排隊、有空位依序派出；手動與自動流程共用一條隊伍。
const SETTINGS = '/home/u/.claude/handoffs/dispatch.json'
const ALPHA = '/home/u/wt/alpha'
const GAMMA = '/home/u/wt/gamma'
const A = `case-${CARD_A}-`
const C = `case-${CARD_C}-`
const screen = async (ui: any) => flat(text(await ui.drawn()))
const busy = (name: string, cwd: string) => ({ id: name.slice(-8), kind: 'background', cwd, name, sessionId: `${name.slice(-8)}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: 0 })
/** 三個在跑的工作桌 Agent，都在不在登錄表的根目錄（別的專案）。 */
const FULL = () => [busy('desk-m0-0', '/home/u/other/one'), busy('desk-m0-1', '/home/u/other/two'), busy('desk-m0-2', '/home/u/other/three')]
const runningDesk = (data: any) => data.agents.filter((a: any) => a.kind === 'background' && isDeskLaunch(a.name) && a.status === 'busy').length

/** Alpha、Gamma 都可繼續（檢查已核准）；派工會在那個根目錄多一個在跑的 Agent。 */
function setup(data: any, clock: any, settings: object = {}) {
  data.files[SETTINGS] = JSON.stringify(settings)
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無').replace('- 下一步：push', '- 下一步：實作匯入')
  data.files[CARD_C] = data.files[CARD_C]!.replace('- 驗證：無', '- 驗證：`node test.mjs`').replace('- 下一步：無', '- 下一步：實作匯出')
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  data.git[GAMMA] = { branch: 'feature/gamma', head: 'g1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs', [CARD_B]: 'npm test', [CARD_C]: 'node test.mjs' }
  data.agents = FULL()
  data.launch = async (e: any) => {
    const id = `e000000${data.launches.length}`
    data.agents = [...data.agents, { ...busy(e.argv[3], e.init.cwd), id, sessionId: `${id}-0000-4000-8000-000000000000`, startedAt: clock.now() }]
    return result(0, id)
  }
}

function helpers($: any, data: any, clock: any) {
  const step = async () => { await clock.advance(2500); await clock.settle() }
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() }
  /** 面板上選那件、按兩次 g。 */
  const pressG = async (ui: any, card: string) => {
    await ui.press({ key: `row-${card}` })
    await ui.press({ key: `case-${card}-continue` }); await clock.settle()
    await ui.press({ key: `case-${card}-continue` }); await clock.settle()
  }
  /** 一個在跑的工作桌 Agent 做完（最早派的那個）。 */
  const finishOne = () => {
    const i = data.agents.findIndex((a: any) => /^desk-m0-/.test(a.name) && a.status === 'busy')
    data.agents = data.agents.map((a: any, j: number) => j === i ? { ...a, status: 'idle', state: 'done' } : a)
  }
  return { step, refresh, pressG, finishOne }
}

/** AC-1 */
test('test_dispatch_queues_with_position_when_three_desk_agents_are_busy', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data, clock)
  const h = helpers($, data, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  await h.pressG(ui, CARD_A)

  expect(data.launches).toHaveLength(0)
  expect(data.toasts).toContain('Alpha：同時執行的 Agent 已達上限 3 個，已排隊（第 1 位）')
  const shown = await screen(ui)
  expect(shown).toContain(flat('處理中  派工排隊中（第 1 位）'))
  expect(shown).toContain(flat('… 派工排隊中（第 1 位）'))
  expect(await ui.find({ key: `${A}continue` })).toBeFalsy()
  const unqueue = await ui.find({ key: `${A}unqueue` })
  expect(unqueue?.props?.label).toBe('■ 取消排隊')
  expect(unqueue?.props?.hotkey).toBe('k')
  // 重新整理、名額還是滿的：照舊排著，不派
  await h.refresh()
  expect(data.launches).toHaveLength(0)
  expect(await screen(ui)).toContain(flat('派工排隊中（第 1 位）'))
  await ui.unmount()
})

/** AC-2 */
test('test_manual_and_auto_dispatches_share_one_queue_in_order', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data, clock)
  const h = helpers($, data, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  await h.pressG(ui, CARD_C)
  expect(data.toasts).toContain('Gamma：同時執行的 Agent 已達上限 3 個，已排隊（第 1 位）')

  // 這個對話的流程：Alpha 的實作剛做完，檢查通過後要派審查
  data.store.chains = { [ALPHA]: { owner: 'fixture-session', startedAt: clock.now() - 600_000, round: 0 } }
  data.store.jobs = { [ALPHA]: { sessionId: 'a0000001-0000-4000-8000-000000000000', last: { launchName: 'desk-old-0', nativeId: 'a0000001', sessionId: 'a0000001-0000-4000-8000-000000000000', kind: 'continue', startedAt: clock.now() - 600_000, fresh: false, owner: 'fixture-session' } } }
  await h.refresh()
  await h.step(); await h.step()
  expect(data.launches).toHaveLength(0)
  await ui.press({ key: `row-${CARD_A}` })
  expect(await screen(ui)).toContain(flat('派工排隊中（第 2 位）'))
  expect(await screen(ui)).toContain(flat('Alpha 自動派審查排隊中（第 2 位）'))

  // 一個結束：只派出排第 1 的 Gamma，Alpha 往前一位
  h.finishOne()
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(GAMMA)
  expect(String(data.launches[0].argv.at(-1))).toContain('依卡片的下一步繼續：實作匯出')
  expect(runningDesk(data)).toBeLessThanOrEqual(3)
  expect(await screen(ui)).toContain(flat('派工排隊中（第 1 位）'))

  // 再一個結束：派出 Alpha 的審查
  h.finishOne()
  await h.refresh()
  expect(data.launches).toHaveLength(2)
  expect(data.launches[1].init.cwd).toBe(ALPHA)
  expect(String(data.launches[1].argv.at(-1)).startsWith('程式碼審查')).toBe(true)
  expect(runningDesk(data)).toBeLessThanOrEqual(3)
  // 動態留著排隊的紀錄；輪到誰與動作列不再寫排隊
  expect(await screen(ui)).not.toContain('派工排隊中')
  await ui.unmount()
})

/** AC-3 */
test('test_waiting_or_non_desk_agents_and_zero_limit_do_not_queue', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data, clock)
  // 一個停在提問、一個等權限批准、一個不是工作桌派的：都不算在跑
  data.agents = [
    { ...busy('desk-m0-0', '/home/u/other/one'), status: 'waiting', state: 'blocked' },
    { ...busy('desk-m0-1', '/home/u/other/two'), status: 'waiting', state: 'blocked', waitingFor: 'permission prompt' },
    busy('helper-agent', '/home/u/other/three'),
  ]
  const h = helpers($, data, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  await h.pressG(ui, CARD_A)
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(ALPHA)
  expect(await screen(ui)).not.toContain('排隊')

  // 3 個工作桌 Agent 都在跑，但 maxAgents 0＝不限
  data.agents = [...data.agents.filter((a: any) => a.cwd === ALPHA), ...FULL()]
  data.files[SETTINGS] = JSON.stringify({ maxAgents: 0 })
  await h.refresh()
  await h.pressG(ui, CARD_C)
  expect(data.launches).toHaveLength(2)
  expect(data.launches[1].init.cwd).toBe(GAMMA)
  expect(await screen(ui)).not.toContain('排隊')

  // 負數、非整數、字串：照預設 3，已滿就排隊
  for (const bad of [-1, 2.5, '4']) {
    data.files[SETTINGS] = JSON.stringify({ maxAgents: bad })
    await h.refresh()
    await $.command.run({ command: 'desk', args: 'go Beta' } as any); await clock.settle()
    expect(data.launches).toHaveLength(2)
    expect(data.toasts.at(-1)).toBe('Beta：同時執行的 Agent 已達上限 3 個，已排隊（第 1 位）')
    await ui.press({ key: `row-${CARD_B}` })
    await ui.press({ key: `case-${CARD_B}-unqueue` }); await clock.settle()
  }
  await ui.unmount()
})

/** AC-4 */
test('test_cancelled_or_no_longer_dispatchable_queue_entries_never_launch', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data, clock)
  const h = helpers($, data, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  await h.pressG(ui, CARD_A)
  await h.pressG(ui, CARD_C)
  expect(data.toasts).toContain('Gamma：同時執行的 Agent 已達上限 3 個，已排隊（第 2 位）')

  // Alpha 按 k 取消排隊（按一次就取消）；Gamma 排隊期間關卡改成規格待確認
  await ui.press({ key: `row-${CARD_A}` })
  await ui.press({ key: `${A}unqueue` }); await clock.settle()
  data.files[CARD_C] = data.files[CARD_C]!.replace('- 關卡：無', '- 關卡：spec：待確認規格')
  h.finishOne(); h.finishOne()
  await h.refresh()
  await h.step()

  expect(data.launches).toHaveLength(0)
  let shown = await screen(ui)
  expect(shown).not.toContain('派工排隊中')
  expect(shown).toContain(flat('Alpha 已取消排隊'))
  expect(await ui.find({ key: `${A}unqueue` })).toBeFalsy()
  await ui.press({ key: `row-${CARD_C}` })
  shown = await screen(ui)
  expect(shown).not.toContain('派工排隊中')
  expect(shown).toContain(flat('Gamma 排隊的繼續沒有派出：規格還沒確認'))
  expect(await ui.find({ key: `${C}unqueue` })).toBeFalsy()
  await ui.unmount()
})

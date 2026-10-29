import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, CARD_C, result, text, flat, feedLog } from './fixture'
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
  const log = feedLog(on)
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
  expect(log.has('Alpha 自動派驗收排隊中（第 2 位）')).toBe(true)
  expect(await screen(ui)).not.toContain(flat('Alpha 自動派驗收排隊中（第 2 位）'))

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
  const log = feedLog(on)
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
  expect(log.has('Alpha 已取消排隊')).toBe(true)
  expect(shown).not.toContain(flat('Alpha 已取消排隊'))
  expect(await ui.find({ key: `${A}unqueue` })).toBeFalsy()
  await ui.press({ key: `row-${CARD_C}` })
  shown = await screen(ui)
  expect(shown).not.toContain('派工排隊中')
  expect(shown).toContain(flat('Gamma 排隊的繼續沒有派出：規格還沒確認'))
  expect(await ui.find({ key: `${C}unqueue` })).toBeFalsy()
  await ui.unmount()
})

/** 這個對話的流程：Alpha、Gamma 的實作剛做完（結束時 worktree 乾淨），檢查通過後各自派審查；名額滿了，兩件都排進隊伍（Alpha 第 1、Gamma 第 2）。 */
async function queueTwoAutoReviews(data: any, clock: any, h: ReturnType<typeof helpers>) {
  const last = (root: string, id: string) => ({ sessionId: `${id}-0000-4000-8000-000000000000`, mark: '', last: { launchName: `desk-old-${id.slice(-1)}`, nativeId: id, sessionId: `${id}-0000-4000-8000-000000000000`, kind: 'continue', startedAt: clock.now() - 600_000, fresh: false, owner: 'fixture-session', ended: { how: 'finished' } } })
  data.store.chains = { [ALPHA]: { owner: 'fixture-session', startedAt: clock.now() - 600_000, round: 0 }, [GAMMA]: { owner: 'fixture-session', startedAt: clock.now() - 600_000, round: 0 } }
  data.store.jobs = { [ALPHA]: last(ALPHA, 'a0000001'), [GAMMA]: last(GAMMA, 'c0000001') }
  await h.refresh()
  for (let i = 0; i < 6; i++) await h.step()
  await h.refresh()
}

/** 審查 HIGH：流程紀錄跨對話共用；排隊的自動派工取消或沒派出時，只停這個對話自己的流程。 */
test('queued auto dispatches never pause a chain another conversation took over', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  setup(data, clock)
  const h = helpers($, data, clock)
  await queueTwoAutoReviews(data, clock, h)
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_C}` })
  expect(log.has('Gamma 自動派驗收排隊中（第 2 位）')).toBe(true)
  expect(await screen(ui)).not.toContain(flat('Gamma 自動派驗收排隊中（第 2 位）'))
  expect(data.launches).toHaveLength(0)

  // 別的對話在兩件都按了繼續：流程換成那邊的
  const theirs = { owner: 'other-session', startedAt: clock.now(), round: 0 }
  data.store.chains = { [ALPHA]: { ...theirs }, [GAMMA]: { ...theirs } }

  // 這邊取消 Alpha 的排隊：不動別人的流程
  await ui.press({ key: `row-${CARD_A}` })
  await ui.press({ key: `${A}unqueue` }); await clock.settle()
  expect(data.store.chains[ALPHA]).toEqual(theirs)

  // 空出位子：Gamma 不派，動態說原因，別人的流程照舊沒停
  h.finishOne()
  await h.refresh()
  expect(data.launches).toHaveLength(0)
  await ui.press({ key: `row-${CARD_C}` })
  expect(await screen(ui)).toContain(flat('Gamma 排隊的驗收沒有派出：流程已不是這個對話的'))
  expect(data.store.chains[GAMMA]).toEqual(theirs)
  await ui.unmount()
})

/** 審查 HIGH：排隊期間 worktree 被別的對話改了就不派；已經停下的流程不改原因。 */
test('queued auto dispatches recheck the worktree and keep an existing pause reason', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  setup(data, clock)
  const h = helpers($, data, clock)
  await queueTwoAutoReviews(data, clock, h)
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_C}` })
  expect(log.has('Gamma 自動派驗收排隊中（第 2 位）')).toBe(true)
  expect(await screen(ui)).not.toContain(flat('Gamma 自動派驗收排隊中（第 2 位）'))

  // 排隊期間：Alpha 的流程停在檢查（這個對話自己停的）；主對話在 Gamma 的 worktree 改了 3 個檔
  const held = { ...data.store.chains[ALPHA], stopped: '完成檢查改了，要重新核准', heldAtCheck: true }
  data.store.chains = { ...data.store.chains, [ALPHA]: held }
  data.git[GAMMA].changed = 3

  h.finishOne(); h.finishOne()
  await h.refresh()
  expect(data.launches).toHaveLength(0)
  // Alpha：原因照舊、停在檢查的標記還在（按 v 仍會接續）
  expect(data.store.chains[ALPHA]).toEqual(held)
  // Gamma：不派，流程停下寫同一個原因
  expect(data.store.chains[GAMMA].stopped).toContain('3 個檔')
  await ui.press({ key: `row-${CARD_C}` })
  const shown = await screen(ui)
  expect(shown).toContain(flat('Gamma 排隊的驗收沒有派出：worktree 有未提交的改動（3 個檔）'))
  expect(shown).not.toContain('派工排隊中')
  await ui.unmount()
})

/** 審查 MEDIUM：排隊的自動派工因 worktree 被改而停下流程時，跟自動流程一樣跳提示並發系統通知；沒停下的那件不出聲。 */
test('a queued auto dispatch stopped by foreign changes alerts like the chain does', async ($, on) => {
  const { data, clock } = fixture(on)
  const notified: string[] = []
  on('ui.notify', (_: any, e: any) => { notified.push(e.text); return { value: { isSent: true as const, channel: 'terminal_bell' as const } } })
  setup(data, clock)
  const h = helpers($, data, clock)
  await queueTwoAutoReviews(data, clock, h)
  data.git[GAMMA].changed = 3

  h.finishOne(); h.finishOne()
  await h.refresh()

  const paused = (t: string) => t.startsWith('Gamma：流程已暫停，worktree 有未提交的改動（3 個檔）')
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(ALPHA)
  expect(data.toasts.some(paused)).toBe(true)
  expect(notified.some(paused)).toBe(true)
  expect([...data.toasts, ...notified].some((t: string) => t.startsWith('Alpha：流程已暫停'))).toBe(false)
})

/** 審查 MEDIUM：同一個對話幾乎同時派兩件、只剩一個名額：只派出一件，另一件排第 1 位，在跑的不超過上限。 */
test('concurrent dispatches in one conversation never exceed the limit', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data, clock)
  data.agents = FULL().slice(0, 2)
  const h = helpers($, data, clock)
  await h.refresh()

  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await $.command.run({ command: 'desk', args: 'go Gamma' } as any)
  await clock.settle()

  expect(data.launches).toHaveLength(1)
  expect(runningDesk(data)).toBe(3)
  expect(data.toasts.filter((t: string) => t.endsWith('同時執行的 Agent 已達上限 3 個，已排隊（第 1 位）'))).toHaveLength(1)
})

/** 審查 MEDIUM：同一件連派兩次、第一次佔到最後一個名額還在啟動：第二次說「上一次派工仍在啟動」，不排進隊伍，之後也不會再派。 */
test('a second dispatch of a card that is still starting is refused, not queued', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data, clock)
  data.agents = FULL().slice(0, 2)
  const launchNow = data.launch
  let release = () => {}
  data.launch = (e: any) => new Promise(done => { release = () => done(launchNow(e)) })
  const h = helpers($, data, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))

  await $.command.run({ command: 'desk', args: 'go Gamma' } as any)
  await $.command.run({ command: 'desk', args: 'go Gamma' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  expect(data.toasts).toContain('Gamma：上一次派工仍在啟動')
  expect(data.toasts.some((t: string) => t.includes('已排隊'))).toBe(false)

  // 空出名額、第一次派工啟動完成：都只有那一個
  h.finishOne()
  await h.refresh()
  release(); await clock.settle()
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  await ui.press({ key: `row-${CARD_C}` })
  expect(await screen(ui)).not.toContain('派工排隊中')
  await ui.unmount()
})

/** 審查 MEDIUM：名額滿時同一件連派兩次：只排一筆，第二次說已在隊伍；空出名額後只派出一個。 */
test('two dispatches of the same card while full queue it once', async ($, on) => {
  const { data, clock } = fixture(on)
  setup(data, clock)
  const h = helpers($, data, clock)
  await h.refresh()

  await $.command.run({ command: 'desk', args: 'go Gamma' } as any)
  await $.command.run({ command: 'desk', args: 'go Gamma' } as any)
  await clock.settle()
  expect(data.toasts.filter((t: string) => t === 'Gamma：同時執行的 Agent 已達上限 3 個，已排隊（第 1 位）')).toHaveLength(1)
  expect(data.toasts).toContain('Gamma：已在派工隊伍（第 1 位），k 取消排隊')

  h.finishOne(); h.finishOne()
  await h.refresh()
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(GAMMA)
})

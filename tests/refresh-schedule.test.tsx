import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_C, result } from './fixture'
import { refreshMs } from '../hooks/desk-io'
import { AGENTS_FRESH_MS } from '../hooks/dispatch-runner'

// 刷新排程與重繪：沒人看又沒東西在跑時拉長重新整理、轉圈每秒一格且重繪不讀 store、核准馬上看得到、派工沿用剛讀過的 agents 清單。
const INTERVAL = refreshMs({} as any)
const C = `case-${CARD_C}-`

/** 數 claude agents 被叫了幾次（不攔下，照 fixture 回答）。 */
function countAgents(data: any) {
  const box = { lists: 0 }
  data.exec = (e: any) => { if (e.argv[0] === 'claude' && e.argv[1] === 'agents') box.lists++; return null }
  return box
}

/** Gamma 有檢查與下一步、可以派實作；沒有 Agent 在跑。派工會在 Gamma 多一個在跑的 Agent。 */
function gammaReady(data: any, clock: any, trusted: boolean) {
  data.files[CARD_C] = data.files[CARD_C]!.replace('- 驗證：無', '- 驗證：`node test.mjs`').replace('- 下一步：無', '- 下一步：實作匯出')
  if (trusted) data.store.trustedVerify = { [CARD_C]: 'node test.mjs' }
  data.agents = []
  data.launch = async (e: any) => {
    const id = `f000000${data.launches.length}`
    data.agents = [...data.agents, { id, kind: 'background', cwd: e.init.cwd, name: e.argv[3], sessionId: `${id}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, id)
  }
}

/** 過一個重新整理間隔。 */
const interval = async (clock: any) => { await clock.advance(INTERVAL); await clock.settle() }

/** AC-1 */
test('test_idle_refresh_runs_every_fourth_interval_when_pane_closed', async ($, on) => {
  const { data, clock } = fixture(on)
  data.agents = []
  const count = countAgents(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  count.lists = 0

  // 面板收著、沒有 Agent、沒有檢查或派工：前三個間隔都不整輪重新整理
  for (let i = 0; i < 3; i++) {
    await interval(clock)
    expect(count.lists).toBe(0)
  }
  // 第 4 個間隔才跑一次
  await interval(clock)
  expect(count.lists).toBe(1)
  // 下一輪也一樣：再過 4 個間隔才多一次
  for (let i = 0; i < 3; i++) await interval(clock)
  expect(count.lists).toBe(1)
  await interval(clock)
  expect(count.lists).toBe(2)
})

/** AC-2 */
test('test_refresh_resumes_every_interval_when_pane_opens_or_agent_runs', async ($, on) => {
  const { data, clock } = fixture(on)
  gammaReady(data, clock, true)
  const count = countAgents(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  count.lists = 0
  await interval(clock)
  expect(count.lists).toBe(0)

  // 打開面板：下一個間隔就重新整理，之後每個間隔都跑
  await $.command.run({ command: 'desk', args: '' } as any)
  await clock.settle()
  await interval(clock)
  expect(count.lists).toBe(1)
  await interval(clock)
  expect(count.lists).toBe(2)

  // 收起面板：又閒置，這個間隔不跑
  await $.command.run({ command: 'desk', args: 'close' } as any)
  await interval(clock)
  expect(count.lists).toBe(2)

  // Gamma 的 Agent 開始跑：下一個間隔就恢復每次都重新整理
  await $.command.run({ command: 'desk', args: 'go Gamma' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  count.lists = 0
  await interval(clock)
  expect(count.lists).toBe(1)
  await interval(clock)
  expect(count.lists).toBe(2)
})

/** AC-3 */
test('test_spinner_ticks_once_per_second_without_store_reads', async ($, on) => {
  const { data, clock } = fixture(on)
  const ticks: unknown[] = []
  on('state.set', async (_: any, e: any, next: any) => { if (e?.plugin === 'desk' && e?.key === 'tick') ticks.push(e.value); return next(e) })
  // fixture 的 store.get 讀 data.store[key]：包一層數核准紀錄被讀了幾次。
  const box = { trustReads: 0 }
  data.store = new Proxy(data.store, { get: (t, k) => { if (k === 'trustedVerify') box.trustReads++; return Reflect.get(t, k) } })
  // Beta 的 Agent 在跑
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(100))
  await clock.settle()
  ticks.length = 0
  box.trustReads = 0

  await clock.advance(3000); await clock.settle()
  expect(ticks.length).toBeGreaterThan(0)
  expect(ticks.length).toBeLessThanOrEqual(3)
  expect(box.trustReads).toBe(0)
  await ui.unmount()
})

/** AC-4 */
test('test_approval_shows_on_next_render', async ($, on) => {
  const { data, clock } = fixture(on)
  gammaReady(data, clock, false)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_C}` })
  /** 這段沒列就先展開全部動作再按。 */
  const press = async (key: string) => { if (!(await ui.find({ key }))) await ui.press({ key: 'more' }); await ui.press({ key }); await clock.settle() }

  // 還沒核准：按一次 g，確認句說會一起核准測試
  await press(`${C}continue`)
  expect((await ui.find({ key: `${C}continue` }))?.text).toContain('核准測試並繼續')
  await clock.advance(4000); await clock.settle()

  // 按兩次 v 核准（並跑一次檢查）；不等下一輪重新整理（測試完 2 秒後才會整理）
  await press(`${C}verify`)
  await press(`${C}verify`)
  expect(data.store.trustedVerify).toEqual({ [CARD_C]: 'node test.mjs' })

  // 下一次重繪就是核准過的樣子：按一次 g，確認句不再說要核准
  await press(`${C}continue`)
  const label = (await ui.find({ key: `${C}continue` }))?.text
  expect(label).toContain('確認繼續')
  expect(label).not.toContain('核准測試')
  await ui.unmount()
})

/** AC-5 */
test('test_dispatch_reuses_recent_agents_list_before_launch', async ($, on) => {
  const { data, clock } = fixture(on)
  gammaReady(data, clock, true)
  const count = countAgents(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_C}` })
  count.lists = 0

  // 剛重新整理過（不到 5 秒）：面板按兩次 g 派工
  await ui.press({ key: `${C}continue` }); await clock.settle()
  await ui.press({ key: `${C}continue` }); await clock.settle()

  // 只在啟動後跑一次 agents 清單；派工結果照舊
  expect(count.lists).toBe(1)
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe('/home/u/wt/gamma')
  expect(data.toasts).toContain('Gamma：繼續已派出')
  const jobs = data.store.jobs as Record<string, any>
  expect(jobs['/home/u/wt/gamma']?.last?.launchName).toBe(data.launches[0].argv[3])
  expect(jobs['/home/u/wt/gamma']?.sessionId).toBe(data.agents.find((a: any) => a.cwd === '/home/u/wt/gamma')?.sessionId)
  await ui.unmount()
})

// ---- 重新整理途中的變化：一輪要跑好幾秒，途中核准或派工都不能被那一輪的舊資料蓋掉；沿用清單的期限與守門 ----

const SETTINGS = '/home/u/.claude/handoffs/dispatch.json'
const busyDesk = (name: string, cwd: string) => ({ id: name.slice(-8), kind: 'background', cwd, name, sessionId: `${name.slice(-8)}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: 0 })
/** 三個在跑的工作桌 Agent，都在別的專案。 */
const FULL = () => [busyDesk('desk-m0-0', '/home/u/other/one'), busyDesk('desk-m0-1', '/home/u/other/two'), busyDesk('desk-m0-2', '/home/u/other/three')]

/** Alpha 也可以派實作（檢查已核准）。 */
function alphaReady(data: any) {
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無').replace('- 下一步：push', '- 下一步：實作匯入')
  data.store.trustedVerify = { ...(data.store.trustedVerify as object), [CARD_A]: 'node test.mjs' }
}

/**
 * 攔下下一次符合 `match` 的程序呼叫（`after` 有給就要先看到一次符合 after 的呼叫才開始等）：
 * claude agents 回答送出當下的清單，其他回答空的成功；呼叫 release 才回來。沒攔到的照 fixture 回答，claude agents 照樣計數。
 */
function holdNext(data: any, count: { lists: number }, match: (argv: string[]) => boolean, after?: (argv: string[]) => boolean) {
  const gate = { armed: !after, release: () => {}, held: false }
  data.exec = (e: any) => {
    const argv = e.argv.map(String)
    if (argv[0] === 'claude' && argv[1] === 'agents') count.lists++
    if (!gate.armed && after?.(argv)) { gate.armed = true; return null }
    if (!gate.armed || gate.held || !match(argv)) return null
    gate.held = true
    const answer = argv[0] === 'claude' ? result(0, JSON.stringify(data.agents)) : result(0, '')
    return new Promise(done => { gate.release = () => done(answer) })
  }
  return gate
}
const isAgents = (argv: string[]) => argv[0] === 'claude' && argv[1] === 'agents'
const isGit = (argv: string[]) => argv[0] === 'git'

test('test_approval_during_a_refresh_is_not_overwritten', async ($, on) => {
  const { data, clock } = fixture(on)
  gammaReady(data, clock, false)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_C}` })
  const press = async (key: string) => { if (!(await ui.find({ key }))) await ui.press({ key: 'more' }); await ui.press({ key }); await clock.settle() }

  // 一輪重新整理讀完 agents 清單、卡在 git 探測時，按兩次 v 核准
  const gate = holdNext(data, { lists: 0 }, isGit, isAgents)
  const running = $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.advance(100); await clock.settle()
  expect(gate.held).toBe(true)
  await press(`${C}verify`)
  await press(`${C}verify`)
  expect(data.store.trustedVerify).toEqual({ [CARD_C]: 'node test.mjs' })

  // 那一輪跑完：面板照樣是核准過的樣子，g 的確認句不再說要核准
  gate.release()
  await running
  await clock.settle()
  await press(`${C}continue`)
  const label = (await ui.find({ key: `${C}continue` }))?.text
  expect(label).toContain('確認繼續')
  expect(label).not.toContain('核准測試')
  await ui.unmount()
})

test('test_dispatch_counts_an_agent_launched_while_the_agents_list_was_in_flight', async ($, on) => {
  const { data, clock } = fixture(on)
  gammaReady(data, clock, true)
  alphaReady(data)
  data.files[SETTINGS] = JSON.stringify({ maxAgents: 1 })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()

  // 一輪重新整理送出 claude agents（還沒有 Alpha）後才派出 Alpha，清單之後才回來
  const gate = holdNext(data, { lists: 0 }, isAgents)
  await clock.advance(200)
  const running = $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(gate.held).toBe(true)
  await clock.advance(300)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  await clock.advance(1000)
  gate.release()
  await running
  await clock.settle()

  // 5 秒內再派 Gamma：那份清單看不到 Alpha，不能沿用；即時問才知道名額滿了，排隊
  await $.command.run({ command: 'desk', args: 'go Gamma' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  expect(data.toasts.some(t => t.startsWith('Gamma：同時執行的 Agent 已達上限 1 個'))).toBe(true)
})

test('test_second_dispatch_within_five_seconds_asks_agents_again', async ($, on) => {
  const { data, clock } = fixture(on)
  gammaReady(data, clock, true)
  alphaReady(data)
  data.files[SETTINGS] = JSON.stringify({ maxAgents: 1 })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()

  // 剛整理過就連派兩件：第一件沿用清單派出，第二件的清單看不到第一件，要即時問，名額滿了排隊
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  await $.command.run({ command: 'desk', args: 'go Gamma' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  expect(data.toasts.some(t => t.startsWith('Gamma：同時執行的 Agent 已達上限 1 個'))).toBe(true)
})

test('test_dispatch_asks_agents_again_when_list_is_older_than_five_seconds', async ($, on) => {
  const { data, clock } = fixture(on)
  gammaReady(data, clock, true)
  const count = countAgents(data)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()

  // 整理之後別的專案開了三個工作桌 Agent；清單已經 5 秒前讀的，派工照舊即時問
  data.agents = FULL()
  await clock.advance(AGENTS_FRESH_MS); await clock.settle()
  count.lists = 0
  await $.command.run({ command: 'desk', args: 'go Gamma' } as any)
  await clock.settle()
  expect(count.lists).toBe(1)
  expect(data.launches).toHaveLength(0)
  expect(data.toasts).toContain('Gamma：同時執行的 Agent 已達上限 3 個，已排隊（第 1 位）')
})

test('test_dispatch_asks_agents_live_when_no_list_was_ever_read', async ($, on) => {
  const { data, clock } = fixture(on)
  gammaReady(data, clock, true)
  const box = { lists: 0, failing: true }
  data.exec = (e: any) => {
    if (e.argv[0] !== 'claude' || e.argv[1] !== 'agents') return null
    box.lists++
    return box.failing ? result(1, '', 'agents unavailable') : null
  }
  // 重新整理的 claude agents 失敗：從沒讀到清單
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  box.failing = false
  box.lists = 0

  await $.command.run({ command: 'desk', args: 'go Gamma' } as any)
  await clock.settle()
  // 算名額、啟動前、啟動後各問一次
  expect(box.lists).toBe(3)
  expect(data.launches).toHaveLength(1)
})

test('test_dispatch_during_a_refresh_keeps_the_next_interval_refreshing', async ($, on) => {
  const { data, clock } = fixture(on)
  gammaReady(data, clock, true)
  const count = { lists: 0 }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()

  // 面板收著；一輪重新整理送出 claude agents 後才派出 Gamma（同步：不開自動流程，那一輪結束不會另外排重新整理），清單（沒有 Gamma）之後才回來
  const gate = holdNext(data, count, isAgents)
  await clock.advance(200)
  const running = $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  await clock.advance(300)
  await $.command.run({ command: 'desk', args: 'sync Gamma' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  await clock.advance(1000)
  gate.release()
  await running
  await clock.settle()

  // 那份清單看不到 Gamma 在跑：不算閒置，下一個間隔照樣整理（看到 Gamma 在跑）；閒置的話要再等 3 個間隔
  count.lists = 0
  await interval(clock)
  expect(count.lists).toBe(1)
})

/** 卡住下一次 claude --bg：release 時才呼叫原本的 data.launch（Agent 那時才出現在清單）並回來。 */
function holdLaunch(data: any) {
  const gate = { release: () => {}, held: false }
  const original = data.launch
  data.launch = (e: any) => {
    if (gate.held) return original(e)
    gate.held = true
    return new Promise(done => { gate.release = () => done(original(e)) })
  }
  return gate
}

test('test_dispatch_after_a_list_read_while_launching_asks_agents_again', async ($, on) => {
  const { data, clock } = fixture(on)
  gammaReady(data, clock, true)
  alphaReady(data)
  data.files[SETTINGS] = JSON.stringify({ maxAgents: 1 })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()

  // Alpha 的 claude --bg 還沒回來時跑一輪重新整理：那份清單沒有 Alpha
  const launching = holdLaunch(data)
  await clock.advance(200)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(launching.held).toBe(true)
  await clock.advance(300)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  launching.release()
  await clock.settle()
  expect(data.toasts).toContain('Alpha：繼續已派出')

  // 5 秒內再派 Gamma：不沿用那份清單，即時問才知道名額滿了，排隊
  await clock.advance(1000)
  await $.command.run({ command: 'desk', args: 'go Gamma' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  expect(data.toasts.some(t => t.startsWith('Gamma：同時執行的 Agent 已達上限 1 個'))).toBe(true)
})

test('test_dispatch_after_a_launch_that_threw_asks_agents_again', async ($, on) => {
  const { data, clock } = fixture(on)
  gammaReady(data, clock, true)
  alphaReady(data)
  data.files[SETTINGS] = JSON.stringify({ maxAgents: 1 })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()

  // Alpha 的 claude --bg 還沒回來時跑一輪重新整理；回來後確認用的 claude agents 出錯：派工算失敗，但 Agent 其實已經在跑
  const launching = holdLaunch(data)
  await clock.advance(200)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  await clock.advance(300)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const box = { failNext: true }
  data.exec = (e: any) => {
    if (box.failNext && e.argv[0] === 'claude' && e.argv[1] === 'agents') { box.failNext = false; throw new Error('agents crashed') }
    return null
  }
  launching.release()
  await clock.settle()
  expect(box.failNext).toBe(false)
  expect(data.toasts.some(t => t.startsWith('Alpha：無法派繼續'))).toBe(true)

  // 5 秒內再派 Gamma：不沿用那份清單，即時問看到 Alpha 在跑，名額滿了排隊
  await clock.advance(1000)
  await $.command.run({ command: 'desk', args: 'go Gamma' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(1)
  expect(data.toasts.some(t => t.startsWith('Gamma：同時執行的 Agent 已達上限 1 個'))).toBe(true)
})

test('test_dispatch_while_launching_keeps_the_next_interval_refreshing', async ($, on) => {
  const { data, clock } = fixture(on)
  gammaReady(data, clock, true)
  const count = { lists: 0 }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()

  // 面板收著；同步 Gamma 的 claude --bg 還沒回來時送出一輪重新整理（清單沒有 Gamma）；派工先結束，清單之後才回來
  const launching = holdLaunch(data)
  await clock.advance(200)
  await $.command.run({ command: 'desk', args: 'sync Gamma' } as any)
  await clock.settle()
  const gate = holdNext(data, count, isAgents)
  await clock.advance(300)
  const running = $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(gate.held).toBe(true)
  launching.release()
  await clock.settle()
  expect(data.toasts).toContain('Gamma：同步已派出')
  await clock.advance(1000)
  gate.release()
  await running
  await clock.settle()

  // 那份清單看不到 Gamma 在跑：不算閒置，下一個間隔照樣整理；閒置的話要再等 3 個間隔
  count.lists = 0
  await interval(clock)
  expect(count.lists).toBe(1)
})

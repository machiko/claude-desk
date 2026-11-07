import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_C, result } from './fixture'
import { refreshMs } from '../hooks/desk-io'

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

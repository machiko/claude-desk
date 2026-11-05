import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, REGISTRY, NOW, result, text, flat, feedLog } from './fixture'
import { alphaOnly, helpers, sh } from './alpha-chain'
import { launchName } from '../hooks/dispatch'

// blocked-reply-loop：Agent 清單裡 blocked 是做完一輪的正常結束狀態（要問人寫進卡片「等你」），不是在等你回覆；
// 只有 status waiting（等的不是權限）才是停下來提問。

const BETA = '/home/u/wt/beta'
const SID = 'bbbbbbbb-0000-4000-8000-000000000000'
const LAUNCH = launchName(NOW - 60_000, 1)
const PREFIX = `case-${CARD_B}-`
const screen = async (ui: any) => flat(text(await ui.drawn()))
/** 卡片標題列右邊的狀態字（「等回覆」「等批准」…）。 */
const labelShown = async (ui: any, word: string) => (await ui.findAll({ type: 'Text' })).some((n: any) => String(n.text ?? '').trim() === word)

/** 只留 Beta 一件：最後一次派工的 Agent 是 `agent` 這個樣子，卡片「等你」是無、下一步是「依審核修正」。 */
function betaWith(data: any, agent: Record<string, unknown>) {
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git' }
  data.gh = []
  data.agents = [{ id: 'bbbbbbbb', kind: 'background', cwd: BETA, name: LAUNCH, sessionId: SID, state: 'blocked', startedAt: NOW - 60_000, ...agent }]
  data.logs = { bbbbbbbb: '做完了。\n' }
  data.store.jobs = { [BETA]: { sessionId: SID, last: { launchName: LAUNCH, nativeId: 'bbbbbbbb', sessionId: SID, kind: 'continue', startedAt: NOW - 60_000, fresh: false } } }
}

/** AC-1 */
test('test_blocked_agent_that_finished_is_not_waiting_for_reply', async ($, on) => {
  const { data, clock } = fixture(on)
  for (const agent of [{ status: 'idle' }, {}]) {
    betaWith(data, agent)
    data.toasts.length = 0
    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    const ui = await $.ui.mount(PANE(120))
    const shown = await screen(ui)

    // 不是「等回覆」：沒有回覆鍵，也不說 Agent 在等你
    expect(await labelShown(ui, '等回覆')).toBe(false)
    expect(await ui.find({ key: `${PREFIX}reply` })).toBeUndefined()
    expect(shown).not.toContain(flat('按 y 回覆'))
    expect(shown).not.toContain(flat('Agent 等待你回覆'))
    // 「輪到你」照卡片的階段與下一步說
    expect(shown).toContain(flat('▶ 輪到你 按 g 派 Agent：依審核修正'))
    await ui.unmount()

    // /desk reply 被拒：Agent 沒有在等你
    const out: any = await $.command.run({ command: 'desk', args: 'reply Beta 好' } as any)
    await clock.settle()
    const said = [String(out?.text ?? ''), ...data.toasts].join('\n')
    expect(said).toContain('Agent 沒有在等你回覆')
    expect(data.launches).toHaveLength(0)
    expect(data.asks).toHaveLength(0)
  }
})

/** AC-2 */
test('test_auto_chain_continues_after_agent_ends_blocked', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  alphaOnly(data, clock)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const h = helpers($, data, clock)

  await h.refresh()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  await h.refresh()
  expect(data.launches).toHaveLength(1)

  // 實作做完，Agent 清單裡是 blocked／idle（不是 done）：不按任何鍵
  data.agents = data.agents.map((a: any) => ({ ...a, state: 'blocked', status: 'idle' }))
  await h.refresh()
  await h.step(); await h.step(); await h.step()

  // 動態記一筆這次派工做完，接著自動跑測試，通過後自動派驗收
  expect(log.has('Alpha Agent 已完成')).toBe(true)
  expect(data.asks).toHaveLength(0)
  expect(sh(data)).toBe(1)
  expect(data.launches).toHaveLength(2)
  expect(h.prompt(1)).toContain('程式碼審查')
  expect(log.list.some(e => e.text.includes('Agent 等待你回覆'))).toBe(false)
})

/** AC-3 */
test('test_agent_waiting_for_input_still_asks_for_reply', async ($, on) => {
  const { data } = fixture(on)

  // status waiting、等的不是權限：照舊等回覆、有回覆鍵
  betaWith(data, { status: 'waiting', waitingFor: 'input needed' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  let ui = await $.ui.mount(PANE(120))
  expect(await labelShown(ui, '等回覆')).toBe(true)
  expect(await screen(ui)).toContain(flat('▶ 輪到你 按 y 回覆 Agent 的提問'))
  expect((await ui.find({ key: `${PREFIX}reply` }))?.text).toBe('↩ 回覆')
  await ui.unmount()

  // status waiting、等的是權限提示：照舊等權限批准、沒有回覆鍵
  betaWith(data, { status: 'waiting', waitingFor: 'permission prompt' })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  ui = await $.ui.mount(PANE(120))
  expect(await labelShown(ui, '等批准')).toBe(true)
  expect(await labelShown(ui, '等回覆')).toBe(false)
  expect(await screen(ui)).toContain(flat(`Agent 在等權限批准：到終端機跑 claude agents 選 ${LAUNCH} 批准`))
  expect(await ui.find({ key: `${PREFIX}reply` })).toBeUndefined()
  await ui.unmount()
})

/** AC-5 */
test('test_stop_done_includes_blocked_desk_agents', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  const GAMMA = '/home/u/wt/gamma'
  const ALPHA = '/home/u/wt/alpha'
  betaWith(data, { state: 'working', status: 'busy', pid: 4242 })
  const others = [
    // 不是工作桌派的 blocked
    { id: 'cccccccc', kind: 'background', cwd: GAMMA, name: 'my-own-agent', sessionId: 'cccccccc-0000-4000-8000-000000000000', state: 'blocked', status: 'idle', pid: 5151, startedAt: NOW - 120_000 },
    // 工作桌派的、status waiting（停下來提問）
    { id: 'aaaaaaaa', kind: 'background', cwd: ALPHA, name: launchName(NOW - 120_000, 2), sessionId: 'aaaaaaaa-0000-4000-8000-000000000000', state: 'blocked', status: 'waiting', waitingFor: 'input needed', pid: 5252, startedAt: NOW - 120_000 },
  ]
  data.agents = [...data.agents, ...others]
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(data.stops).toEqual([])

  // Beta 那個做完一輪：blocked、status idle、程序還活著
  data.agents = [{ ...data.agents[0], state: 'blocked', status: 'idle' }, ...others]
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()

  expect(data.stops).toEqual(['bbbbbbbb'])
  expect(log.has('Beta Agent 已完成')).toBe(true)
  expect((data.store.jobs as any)[BETA].last.ended).toEqual({ how: 'finished' })
})

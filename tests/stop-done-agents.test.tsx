import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, REGISTRY, NOW, result, text, flat, feedLog } from './fixture'
import { setFields } from '../hooks/tutorial'
import { launchName } from '../hooks/dispatch'
import { AGENT_STOPPED } from '../hooks/chain'

// 做完（done／failed）、程序還活著（JSON 有 pid）的工作桌 Agent：desk 在下一次重新整理時 `claude stop` 收掉，每個只試一次。
const ALPHA = '/home/u/wt/alpha'
const BETA = '/home/u/wt/beta'
const GAMMA = '/home/u/wt/gamma'
const ARCHIVED = '/home/u/wt/old'
const SETTINGS = '/home/u/.claude/handoffs/dispatch.json'
const LAST_AT = NOW - 2 * 60_000
const OLD_AT = NOW - 300 * 60_000
const LATEST = launchName(LAST_AT, 1)
const LEFTOVER = launchName(OLD_AT, 2)
const SID = 'bbbbbbbb-0000-4000-8000-000000000000'
const screen = async (ui: any) => flat(text(await ui.drawn()))

const job = (name: string, at: number, extra: Record<string, unknown> = {}) => ({ sessionId: SID, last: { launchName: name, nativeId: 'x', sessionId: SID, kind: 'sync', startedAt: at, fresh: false, ...extra } })

/** Beta 最後一次派工已做完、程序還在；另一個是卡片歸檔後留下的（根目錄不在登錄表上）。 */
function finished(data: any) {
  data.gh = []
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.store.jobs = { [BETA]: job(LATEST, LAST_AT) }
  data.agents = [
    { id: 'bbbbbbbb', kind: 'background', cwd: BETA, name: LATEST, sessionId: SID, state: 'done', status: 'idle', pid: 4242, startedAt: LAST_AT },
    { id: 'dddddddd', kind: 'background', cwd: ARCHIVED, name: LEFTOVER, sessionId: 'dddddddd-0000-4000-8000-000000000000', state: 'done', status: 'idle', pid: 4343, startedAt: OLD_AT },
  ]
}

async function refreshTwice($: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
}

/** AC-1：登錄表上的那件（這一輪已記成做完）與歸檔後留下的各停一次；成功不寫動態。 */
test('stop done: finished desk agents with a live pid are stopped once', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  finished(data)

  await refreshTwice($)
  await clock.settle()

  expect([...data.stops].sort()).toEqual(['bbbbbbbb', 'dddddddd'])
  expect((data.store.jobs as any)[BETA].last.ended).toEqual({ how: 'finished' })
  expect(log.list.some(e => e.text.includes('停') || e.text.includes(LATEST) || e.text.includes(LEFTOVER))).toBe(false)
})

/** AC-2：程序已退出、不是工作桌派的、還在跑的、停在提問（「等你」已清）的，一個都不停；面板照舊。 */
test('stop done: exited, foreign, busy and blocked agents are left alone', async ($, on) => {
  const { data, clock } = fixture(on)
  data.gh = []
  data.files[CARD_A] = setFields(data.files[CARD_A]!, { 等你: '無' })
  data.store.jobs = { [ALPHA]: job(LATEST, LAST_AT, { cardAsked: true, answered: true }) }
  data.agents = [
    // 做完、程序早已退出（沒有 pid）
    { id: 'eeeeeeee', kind: 'background', cwd: ARCHIVED, name: LEFTOVER, sessionId: 'eeeeeeee-0000-4000-8000-000000000000', state: 'done', status: 'idle', startedAt: OLD_AT },
    // 不是工作桌派的
    { id: 'cccccccc', kind: 'background', cwd: GAMMA, name: 'my-own-agent', sessionId: 'cccccccc-0000-4000-8000-000000000000', state: 'done', status: 'idle', pid: 5151, startedAt: OLD_AT },
    // 還在跑
    { id: 'bbbbbbbb', kind: 'background', cwd: BETA, name: launchName(LAST_AT, 3), sessionId: SID, state: 'working', status: 'busy', pid: 5252, startedAt: LAST_AT },
    // 停在提問，題目已在對話處理（卡片「等你」清成無）
    { id: 'aaaaaaaa', kind: 'background', cwd: ALPHA, name: LATEST, sessionId: 'aaaaaaaa-0000-4000-8000-000000000000', state: 'blocked', status: 'idle', pid: 5353, startedAt: LAST_AT },
  ]

  await refreshTwice($)
  await clock.settle()
  const ui = await $.ui.mount(PANE(100))
  const actions = async (card: string) => {
    if (await ui.find({ key: `row-${card}` })) await ui.press({ key: `row-${card}` })
    return { reply: await ui.find({ key: `case-${card}-reply` }), stop: await ui.find({ key: `case-${card}-stop` }), shown: await screen(ui) }
  }
  const beta = await actions(CARD_B)
  const alpha = await actions(CARD_A)

  expect(data.stops).toEqual([])
  expect(beta.stop).toBeDefined()
  expect(alpha.reply).toBeUndefined()
  expect(alpha.stop).toBeUndefined()
  expect(alpha.shown).not.toContain(flat('按 y 回覆'))
  await ui.unmount()
})

/** AC-3：`claude stop` 失敗，動態寫一筆 warning、只寫一次；下一輪不重試。 */
test('stop done: a failed stop is reported once and not retried', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  finished(data)
  data.agents = [data.agents[0]]
  data.stopError = 'agent bbbbbbbb: permission denied'

  await refreshTwice($)
  await clock.settle()

  const line = `停不掉做完的 Agent ${LATEST}：agent bbbbbbbb: permission denied`
  expect(data.stops).toEqual(['bbbbbbbb'])
  expect(log.list.filter(e => e.text === line).map(e => e.tone)).toEqual(['warning'])
  expect(log.list.find(e => e.text === line)?.card).toBe(CARD_B)
})

/** AC-4：全域 dispatch.json 寫 stopDone: false 就不停。 */
test('stop done: stopDone false disables it', async ($, on) => {
  const { data, clock } = fixture(on)
  finished(data)
  data.files[SETTINGS] = JSON.stringify({ stopDone: false })

  await refreshTwice($)
  await clock.settle()

  expect(data.stops).toEqual([])
})

/** AC-5：流程裡的實作做完、desk 停掉它，下一輪清單變成 stopped：照「做完」往下跑檢查，流程不暫停。 */
test('stop done: a desk-stopped finished agent does not pause the chain', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |`
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  data.files[CARD_A] = setFields(data.files[CARD_A]!, { 等你: '無' })
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.agents = []
  data.launch = async (e: any) => {
    data.agents = [{ id: 'a0000001', kind: 'background', cwd: ALPHA, name: e.argv[3], sessionId: 'a0000001-0000-4000-8000-000000000000', state: 'working', status: 'busy', pid: 6161, startedAt: clock.now() }]
    return result(0, 'a0000001')
  }
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() }
  const step = async () => { await clock.advance(2500); await clock.settle() }
  const checks = () => data.processCalls.filter((c: any) => c.argv[0] === 'sh').length

  await refresh()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches.length).toBe(1)

  // 做完、程序還在：這一輪記成做完、停掉它，流程接著跑完成檢查
  data.agents = data.agents.map((a: any) => ({ ...a, state: 'done', status: 'idle' }))
  await refresh(); await step(); await step()
  expect(data.stops).toEqual(['a0000001'])
  expect((data.store.jobs as any)[ALPHA].last.ended).toEqual({ how: 'finished' })

  // 停掉之後清單裡 state 變 stopped、沒有 pid
  data.agents = data.agents.map(({ status: _s, pid: _p, ...a }: any) => ({ ...a, state: 'stopped' }))
  await refresh(); await step(); await step()

  expect(checks()).toBeGreaterThan(0)
  expect((data.store.chains as any)[ALPHA].stopped).toBeUndefined()
  expect((data.store.jobs as any)[ALPHA].last.ended).toEqual({ how: 'finished' })
  expect(log.list.some(e => e.text.includes(AGENT_STOPPED))).toBe(false)
  expect(data.toasts.some((t: string) => t.includes(AGENT_STOPPED))).toBe(false)
  expect(data.stops).toEqual(['a0000001'])
})

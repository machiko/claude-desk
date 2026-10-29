import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, CARD_C, REGISTRY, NOW, result, text, flat } from './fixture'
import { setFields } from '../hooks/tutorial'
import { hhmm } from '../hooks/model'
import { launchName } from '../hooks/dispatch'

const ALPHA = '/home/u/wt/alpha'
const BETA = '/home/u/wt/beta'
const GAMMA = '/home/u/wt/gamma'
const PREFIX = `case-${CARD_B}-`
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 2；可合併'
const screen = async (ui: any) => flat(text(await ui.drawn()))

/** 11:38 派出、停在提問的那個；13:58 又派了一次，已做完。 */
const STALE_AT = NOW - 140 * 60_000
const LAST_AT = NOW - 2 * 60_000
const STALE = launchName(STALE_AT, 1)
const LATEST = launchName(LAST_AT, 2)
const SID = 'bbbbbbbb-0000-4000-8000-000000000000'
const STOPPED = `已停掉 ${hhmm(STALE_AT)} 派出、被後來派工取代的 Agent`

const job = (name: string, at: number, kind = 'sync') => ({ sessionId: SID, last: { launchName: name, nativeId: 'x', sessionId: SID, kind, startedAt: at, fresh: false } })

/** 只留 Beta 一件：自審過關、下一步要派獨立審查；舊的那次停在提問，最後一次派工已做完。 */
function superseded(data: any) {
  data.gh = []
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = setFields(data.files[CARD_B]!, { 下一步: '派獨立審查（w）' }).replace('- 關卡：無', PASSED)
  data.git[BETA] = { branch: 'feature/b', head: 'c2', remote: 'git@github.com:acme/shop.git' }
  data.store.verifies = { [CARD_B]: { command: 'npm test', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'c2' } }
  data.store.jobs = { [BETA]: job(LATEST, LAST_AT) }
  data.agents = [
    { id: 'aaaaaaaa', kind: 'background', cwd: BETA, name: STALE, sessionId: 'aaaaaaaa-0000-4000-8000-000000000000', state: 'blocked', status: 'waiting', waitingFor: 'input needed', startedAt: STALE_AT },
    { id: 'bbbbbbbb', kind: 'background', cwd: BETA, name: LATEST, sessionId: SID, state: 'done', status: 'idle', startedAt: LAST_AT },
  ]
  data.logs = { aaaaaaaa: '要用哪個方案？\n' }
}

async function refreshTwice($: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
}

test('stale ask: a superseded waiting agent does not hold the task', async ($, on) => {
  const { data } = fixture(on)
  superseded(data)

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(100))
  const shown = await screen(ui)

  expect((await ui.find({ key: `${PREFIX}review` }))?.props?.hotkey).toBe('w')
  expect(await ui.find({ key: `${PREFIX}reply` })).toBeUndefined()
  expect(shown).toContain(flat('▶ 輪到你'))
  expect(shown).toContain(flat('可按 w 派獨立審查'))
  expect(shown).not.toContain(flat('按 y 回覆'))
  expect(shown).not.toContain(flat('Agent 等待'))
  await ui.unmount()
})

test('stale ask: the superseded agent is stopped once and noted in the feed', async ($, on) => {
  const { data } = fixture(on)
  superseded(data)

  await refreshTwice($)
  const ui = await $.ui.mount(PANE(100))

  expect(data.stops).toEqual(['aaaaaaaa'])
  expect(await screen(ui)).toContain(flat(`Beta ${STOPPED}`))
  await ui.unmount()
})

test('stale ask: a failed stop still lets the card lead and is not retried', async ($, on) => {
  const { data } = fixture(on)
  superseded(data)
  data.stopError = 'agent aaaaaaaa is not running'

  await refreshTwice($)
  const ui = await $.ui.mount(PANE(100))
  const shown = await screen(ui)

  expect(data.stops).toEqual(['aaaaaaaa'])
  expect(shown).toContain(flat(`Beta 停不掉 ${hhmm(STALE_AT)} 派出、被後來派工取代的 Agent：agent aaaaaaaa is not running`))
  expect(shown).not.toContain(flat(STOPPED))
  expect(await ui.find({ key: `${PREFIX}reply` })).toBeUndefined()
  expect((await ui.find({ key: `${PREFIX}review` }))?.props?.hotkey).toBe('w')
  expect(shown).not.toContain(flat('按 y 回覆'))
  await ui.unmount()
})

/** `claude stop` 卡住時（最多等 30 秒）：重新整理照樣跑完、不等它；同一輪其他被取代的照樣停，卡住的那個結束後才記進「最近」。 */
test('stale ask: a hung claude stop holds up neither the refresh nor the other stops', async ($, on) => {
  const { data, clock } = fixture(on)
  superseded(data)
  const otherAt = STALE_AT + 30 * 60_000
  data.agents = [...data.agents, { id: 'eeeeeeee', kind: 'background', cwd: BETA, name: launchName(otherAt, 3), sessionId: 'eeeeeeee-0000-4000-8000-000000000000', state: 'blocked', status: 'waiting', waitingFor: 'input needed', startedAt: otherAt }]
  let release = () => {}
  const hung = new Promise<void>(r => { release = r })
  const run = data.run
  data.run = async (e: any) => e.argv[0] === 'claude' && e.argv[1] === 'stop' && e.argv[2] === 'aaaaaaaa' ? (await hung, result(0)) : run(e)
  const other = `Beta 已停掉 ${hhmm(otherAt)} 派出、被後來派工取代的 Agent`

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  const ui = await $.ui.mount(PANE(100))
  const whileHung = await screen(ui)
  release()
  await clock.settle()
  const afterwards = await screen(ui)

  expect(data.stops).toEqual(['aaaaaaaa', 'eeeeeeee'])
  expect(whileHung).toContain(flat(other))
  expect(whileHung).not.toContain(flat(`Beta ${STOPPED}`))
  expect(afterwards).toContain(flat(`Beta ${STOPPED}`))
  await ui.unmount()
})

/** 被取代的 Agent 沒有 id（claude agents 沒回）：停不掉，但要在「最近」說一次，不能悄悄消失；不跑 claude stop、下一輪不再記。 */
test('stale ask: a superseded agent without an id is reported once, not silently dropped', async ($, on) => {
  const { data } = fixture(on)
  superseded(data)
  const { id: _, ...noId } = data.agents[0]
  data.agents = [noId, data.agents[1]]
  const line = flat(`Beta 停不掉 ${hhmm(STALE_AT)} 派出、被後來派工取代的 Agent：沒有 Agent id`)

  await refreshTwice($)
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(100))
  const shown = await screen(ui)

  expect(data.stops).toEqual([])
  expect(shown.split(line).length - 1).toBe(1)
  expect(await ui.find({ key: `${PREFIX}reply` })).toBeUndefined()
  await ui.unmount()
})

/** 停掉之後「最近」寫不進去：不能變成沒人接的 rejection；重新整理照常完成、toast 說原因。 */
test('stale ask: a stop whose feed entry cannot be written still finishes the refresh', async ($, on) => {
  const { data, clock } = fixture(on)
  superseded(data)
  on('state.set', (_: any, e: any, next: any) => e?.plugin === 'desk' && e?.key === 'feed' && Array.isArray(e.value) && e.value.some((x: any) => String(x?.text).includes('被後來派工取代'))
    ? { deny: '狀態寫不進去' }
    : next(e))

  await refreshTwice($)
  await clock.settle()
  const ui = await $.ui.mount(PANE(100))
  const shown = await screen(ui)

  expect(data.stops).toEqual(['aaaaaaaa'])
  expect(shown).not.toContain(flat('工作桌讀取失敗'))
  expect(shown).not.toContain(flat('被後來派工取代'))
  expect(data.toasts.some(t => t.includes('Beta：停掉被取代的 Agent 後記不下結果') && t.includes('狀態寫不進去'))).toBe(true)
  await ui.unmount()
})

test('stale ask: the latest, busy, or non-desk agents are left alone', async ($, on) => {
  const { data } = fixture(on)
  data.gh = []
  data.files[CARD_A] = setFields(data.files[CARD_A]!, { 等你: '無' })
  data.store.jobs = { [ALPHA]: job(LATEST, LAST_AT), [BETA]: job(LATEST, LAST_AT, 'continue'), [GAMMA]: job(LATEST, LAST_AT) }
  data.agents = [
    // (a) 最後一次派的那個停在提問
    { id: 'bbbbbbbb', kind: 'background', cwd: BETA, name: LATEST, sessionId: SID, state: 'blocked', status: 'waiting', waitingFor: 'input needed', startedAt: LAST_AT },
    // (b) 比最後派工早、還在跑的工作桌 Agent
    { id: 'aaaaaaaa', kind: 'background', cwd: ALPHA, name: STALE, sessionId: 'aaaaaaaa-0000-4000-8000-000000000000', state: 'working', status: 'busy', startedAt: STALE_AT },
    // (c) 不是工作桌派的，停在權限提示
    { id: 'cccccccc', kind: 'background', cwd: GAMMA, name: 'my-own-agent', sessionId: 'cccccccc-0000-4000-8000-000000000000', state: 'blocked', status: 'waiting', waitingFor: '權限：Bash', startedAt: STALE_AT },
  ]

  await refreshTwice($)
  const ui = await $.ui.mount(PANE(100))
  const actions = async (card: string) => {
    // 現在卡那件不在全部任務表格裡，點不到也不用點。
    if (await ui.find({ key: `row-${card}` })) await ui.press({ key: `row-${card}` })
    return { reply: await ui.find({ key: `case-${card}-reply` }), stop: await ui.find({ key: `case-${card}-stop` }) }
  }
  const a = await actions(CARD_B)
  const b = await actions(CARD_A)
  const c = await actions(CARD_C)

  expect(data.stops).toEqual([])
  expect(a.reply).toBeDefined()
  expect(b.stop).toBeDefined()
  expect(b.reply).toBeUndefined()
  expect(c.reply).toBeDefined()
  expect(await screen(ui)).not.toContain(flat('被後來派工取代'))
  await ui.unmount()
})

test('stale ask: the reply dialog shows the waiting agent\'s last line or says to press l', async ($, on) => {
  const { data, clock } = fixture(on)
  const ask = async (logs: string, answer: string) => {
    data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
    data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git' }
    data.gh = []
    data.store.jobs = { [BETA]: job(LATEST, LAST_AT, 'continue') }
    data.agents = [{ id: 'bbbbbbbb', kind: 'background', cwd: BETA, name: LATEST, sessionId: SID, state: 'blocked', status: 'waiting', waitingFor: 'input needed', startedAt: LAST_AT }]
    data.logs = { bbbbbbbb: logs }
    data.answer = answer
    data.launch = async (e: any) => {
      data.agents = [{ id: 'dddddddd', kind: 'background', cwd: BETA, name: e.argv[3], sessionId: SID, state: 'working', status: 'busy', startedAt: NOW }]
      return result(0, 'dddddddd\n')
    }
    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    const ui = await $.ui.mount(PANE(100))
    await ui.press({ key: `${PREFIX}reply` })
    await clock.settle()
    await ui.unmount()
  }

  await ask('思考中\n要用哪個方案？\n', '照卡片的下一步繼續')
  await ask('', '用方案 B')

  expect(data.asks).toHaveLength(2)
  expect(data.asks[0]).toContain('Agent 提問：要用哪個方案？')
  expect(data.asks[1]).toContain('讀不到 Agent 的提問，按 l 看輸出')
  expect(data.asks[1]).not.toContain('Agent 提問：')
  for (const q of data.asks) expect(q).toContain('「其他」')
  for (const options of data.askOptions) expect(options).toContain('照卡片的下一步繼續')
  const prompts = data.launches.map((l: any) => String(l.argv[l.argv.length - 1]))
  expect(prompts[0]).toContain('照卡片的下一步繼續：依審核修正')
  expect(prompts[1]).toContain('的回覆：用方案 B')
})

import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_B, REGISTRY, NOW, result, text } from './fixture'
import { setFields, tutorialPaths } from '../hooks/tutorial'

const BETA = '/home/u/wt/beta'
const SID = 'bbbbbbbb-0000-4000-8000-000000000000'
const LAUNCH = 'desk-launch-1'
const KEY = `case-${CARD_B}-reply`
const MISMATCH = '卡片狀態不符'
const flat = (x: string) => x.replace(/\s+/g, '')
const prompt = (data: any, i = 0) => String(data.launches[i].argv[data.launches[i].argv.length - 1])

/** 只留 Beta 一件：工作桌派出去的那次做完後停在提問（blocked、不再 busy）。 */
function waiting(data: any, gate = '無') {
  data.files[REGISTRY] = `## 案子\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.files[CARD_B] = setFields(data.files[CARD_B]!, { 關卡: gate })
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git' }
  data.gh = []
  data.agents = [{ id: 'bbbbbbbb', kind: 'background', cwd: BETA, name: LAUNCH, sessionId: SID, state: 'blocked', status: 'idle', startedAt: NOW - 60_000 }]
  data.logs = { bbbbbbbb: '要先跑整套測試嗎？\n' }
  data.store.jobs = { [BETA]: { sessionId: SID, last: { launchName: LAUNCH, nativeId: 'bbbbbbbb', sessionId: SID, kind: 'continue', startedAt: NOW - 60_000, fresh: false } } }
  data.launch = async (e: any) => {
    data.agents = [{ id: 'cccccccc', kind: 'background', cwd: BETA, name: e.argv[3], sessionId: SID, state: 'working', status: 'busy', startedAt: NOW }]
    return result(0, 'cccccccc\n')
  }
}

async function pressReply($: any, data: any, clock: any) {
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(80))
  expect(flat(text(await ui.drawn()))).toContain(flat('Agent 提問'))
  expect((await ui.find({ key: KEY }))?.text).toBe('↩ 回覆')
  await ui.press({ key: KEY })
  await clock.settle()
  return ui
}

test('replying from the footer resumes the waiting agent instead of saying the card state does not match', async ($, on) => {
  const { data, clock } = fixture(on)
  waiting(data)
  data.answer = '照卡片的下一步繼續'
  const ui = await pressReply($, data, clock)
  expect(data.asks).toHaveLength(1)
  expect(data.launches).toHaveLength(1)
  const argv = data.launches[0].argv
  expect(argv.slice(0, 2)).toEqual(['claude', '--bg'])
  expect(argv[argv.indexOf('--resume') + 1]).toBe(SID)
  expect(data.launches[0].init.cwd).toBe(BETA)
  expect(prompt(data)).toContain('照卡片的下一步繼續：依審核修正')
  expect(data.toasts.some(t => t.includes('目前無法回覆') || t.includes(MISMATCH))).toBe(false)
  expect(data.toasts.some(t => t.includes('Beta：回覆已派出'))).toBe(true)
  // 「最近」記一筆派工
  const feed = (await ui.findAll({ type: 'Text' })).find((n: any) => /Beta 派回覆/.test(n.text))
  expect(feed).toBeDefined()
  await ui.unmount()
})

test('a waiting agent can be answered whatever the card gate says', async ($, on) => {
  const { data, clock } = fixture(on)
  for (const gate of ['spec：待確認規格（AC-1～AC-2）', 'review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；修']) {
    waiting(data, gate)
    data.launches.length = 0
    data.toasts.length = 0
    data.answer = '先跑整套再說'
    const ui = await pressReply($, data, clock)
    expect(data.launches).toHaveLength(1)
    const argv = data.launches[0].argv
    expect(argv[argv.indexOf('--resume') + 1]).toBe(SID)
    expect(prompt(data)).toContain('的回覆：先跑整套再說')
    expect(data.toasts.some(t => t.includes('目前無法回覆') || t.includes(MISMATCH))).toBe(false)
    await ui.unmount()
  }
})

test('reply is refused with a reason when no agent is waiting', async ($, on) => {
  const { data, clock } = fixture(on)
  const refused = async (args: string, reason: string) => {
    const before = { ...data.files }
    const jobs = JSON.stringify(data.store.jobs ?? null)
    const out: any = await $.command.run({ command: 'desk', args } as any)
    await clock.settle()
    const said = [String(out?.text ?? ''), ...data.toasts].join('\n')
    expect(said).toContain(reason)
    expect(said).not.toContain(MISMATCH)
    expect(data.launches).toHaveLength(0)
    expect(data.asks).toHaveLength(0)
    expect(data.files).toEqual(before)
    expect(JSON.stringify(data.store.jobs ?? null)).toBe(jobs)
    data.toasts.length = 0
  }

  // Agent 仍在執行
  waiting(data)
  data.agents = [{ ...data.agents[0], state: 'working', status: 'busy' }]
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await refused('reply Beta 好', 'Agent 仍在執行')

  // Agent 已經結束、沒有在問
  data.agents = [{ ...data.agents[0], state: 'done', status: 'idle' }]
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await refused('reply Beta 好', '沒有在等你回覆')

  // 示範案子：教學裡的示範案子只能看
  const P = tutorialPaths('/home/u')
  data.git[P.wt] = { branch: 'feature/discount', head: 'h0' }
  data.git[P.main] = { branch: 'release/v1.0', head: 'm0' }
  await $.command.run({ command: 'desk', args: 'tutorial' } as any)
  await clock.settle()
  data.toasts.length = 0
  await refused('reply 訂單匯出 好', '示範案子')
})

test('cancelling the reply dialog dispatches nothing', async ($, on) => {
  const { data, clock } = fixture(on)
  waiting(data)
  data.answer = '取消'
  const before = { ...data.files }
  const jobs = JSON.stringify(data.store.jobs)
  const ui = await pressReply($, data, clock)
  expect(data.asks).toHaveLength(1)
  expect(data.launches).toHaveLength(0)
  expect(data.files).toEqual(before)
  expect(JSON.stringify(data.store.jobs)).toBe(jobs)
  expect(data.toasts.some(t => t.includes('回覆'))).toBe(false)
  // 還是停在等你回覆，按鈕還在
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect((await ui.find({ key: KEY }))?.text).toBe('↩ 回覆')
  await ui.unmount()
})

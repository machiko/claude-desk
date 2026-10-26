import { expect, test } from 'claude-code/testing'
import { fixture, BAND, PANE, CARD_B, REGISTRY, NOW, text } from './fixture'
import { setFields } from '../hooks/tutorial'
import { lastMeaningful } from '../hooks/model'

const BETA = '/home/u/wt/beta'
const SID = 'bbbbbbbb-0000-4000-8000-000000000000'
const LAUNCH = 'desk-launch-1'
const PREFIX = `case-${CARD_B}-`
const APPROVE = `Agent 在等權限批准：到終端機跑 claude agents 選 ${LAUNCH} 批准`
const flat = (x: string) => x.replace(/\s+/g, '')
const screen = async (ui: any) => flat(text(await ui.drawn()))

/** 只留 Beta 一件：工作桌派出去的那次停下來（blocked）。 */
function blocked(data: any, agent: Record<string, unknown>, logs = '要先跑整套測試嗎？\n') {
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Beta | \`${CARD_B}\` |`
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git' }
  data.gh = []
  data.agents = [{ id: 'bbbbbbbb', kind: 'background', cwd: BETA, name: LAUNCH, sessionId: SID, state: 'blocked', startedAt: NOW - 60_000, ...agent }]
  data.logs = { bbbbbbbb: logs }
  data.store.jobs = { [BETA]: { sessionId: SID, last: { launchName: LAUNCH, nativeId: 'bbbbbbbb', sessionId: SID, kind: 'continue', startedAt: NOW - 60_000, fresh: false } } }
}

test('permission wait: a permission prompt asks you to approve in claude agents, not to reply', async ($, on) => {
  // 停在權限提示的 Agent：清單上可能是 status waiting，也可能已經不是 busy（idle）；兩種都要認得。
  const { data } = fixture(on)
  for (const status of ['waiting', 'idle']) {
    blocked(data, { status, waitingFor: 'permission prompt' })
    data.toasts.length = 0

    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    const ui = await $.ui.mount(PANE(120))
    const shown = await screen(ui)

    // 任務狀態：等你批准權限，不是等你回覆
    expect(shown).toContain(flat('等批准'))
    expect(shown).not.toContain(flat('等回覆'))
    expect(shown).not.toContain(flat('Agent 等待你回覆'))
    // ▶ 輪到你：去 claude agents 批准
    expect(shown).toContain(flat(`▶ 輪到你`))
    expect(shown).toContain(flat(APPROVE))
    expect(shown).not.toContain(flat('按 y 回覆'))
    // 動作列：沒有 y（回覆），有 k（停止）與 l（輸出）
    expect(await ui.find({ key: `${PREFIX}reply` })).toBeUndefined()
    expect((await ui.find({ key: `${PREFIX}stop` }))?.props?.hotkey).toBe('k')
    expect((await ui.find({ key: `${PREFIX}logs` }))?.props?.hotkey).toBe('l')
    await ui.unmount()

    // 摘要列同樣措辭
    const band = await $.ui.mount(BAND(200))
    const bar = flat(text(await band.drawn()))
    expect(bar).toContain(flat(`輪到你：${APPROVE}`))
    expect(bar).not.toContain(flat('按 y 回覆'))
    await band.unmount()

    // /desk reply 也不送：說清楚它在等權限批准
    const out: any = await $.command.run({ command: 'desk', args: 'reply Beta 好' } as any)
    const said = [String(out?.text ?? ''), ...data.toasts].join('\n')
    expect(said).toContain('Agent 在等權限批准，不是提問')
    expect(data.launches).toHaveLength(0)
    expect(data.asks).toHaveLength(0)
  }
})

test('permission wait: a blocked agent waiting on anything else still asks you to reply', async ($, on) => {
  const { data } = fixture(on)
  for (const agent of [{ status: 'waiting', waitingFor: 'input needed' }, { status: 'idle' }]) {
    blocked(data, agent)

    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    const ui = await $.ui.mount(PANE(120))
    const shown = await screen(ui)

    expect(shown).toContain(flat('等回覆'))
    expect(shown).toContain(flat('按 y 回覆 Agent 的提問'))
    expect(shown).not.toContain(flat('等權限批准'))
    expect((await ui.find({ key: `${PREFIX}reply` }))?.text).toBe('↩ 回覆')
    await ui.unmount()
  }
})

/** 背景 Agent 的 `claude logs`：整個畫面的重繪紀錄，顏色、游標移動、轉圈圈與狀態列夾在句子裡。 */
const QUESTION = '要先跑整套測試，還是只跑 permission-wait 的測試？'
const REPAINT = [
  '\u001b[2C\u001b[1B-\u001b[5G測試已寫好\u001b[K\n',
  '\u001b[1B⏺\u001b[3G要先跑整套測試，還是\u001b[38;2;153;153;153m只跑\u001b[39m\u001b[24Gpermission-wait\u001b[40G的測試？\u001b[K\n',
  '\u001b[42B✻\u001b[3GCogitated fo\u001b[16G 2m 43s · done 3:20 PM\u001b[K\n\u001b[3B❯ \u001b[50;1H\u001b[46;3H\u001b[H\n',
  '\u001b[43C\u001b[49B51\u001b[50;1H\u001b[46;3H\u001b[H\n\u001b[38C\u001b[47B51\u001b[46G3\u001b[50;1H\n',
  '\u001b[43C\u001b[47B62m31s │ 5h:40% 7d:43%\n\u001b[2C\u001b[1B+20/-22 │ stale-ask\u001b[K\u001b[50;1H\n',
  '\u001b[160C\u001b[43Bnew task? /clear to save 129.3k tokens\u001b[50;1H\u001b[46;3H\u001b[H',
].join('')

test('last line: terminal control codes are stripped before picking the question', async ($, on) => {
  // 游標右移、跳到某一欄是字與字之間的空白，不是換行；顏色碼直接拿掉。狀態列、計時、token 計數不算一句話。
  expect(lastMeaningful(REPAINT)).toBe(QUESTION)

  const { data, clock } = fixture(on)
  blocked(data, { status: 'waiting', waitingFor: 'input needed' }, REPAINT)
  data.answer = '取消'
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(120))
  await ui.press({ key: `${PREFIX}reply` })
  await clock.settle()
  expect(data.asks).toHaveLength(1)
  expect(data.asks[0]).toContain(`Agent 提問：${QUESTION}`)
  expect(data.asks[0]).not.toMatch(/\u001b|to save|7d:43%/)

  // 全是控制碼、沒有一句話：才說讀不到
  data.logs = { bbbbbbbb: '\u001b[43C\u001b[49B51\u001b[50;1H\u001b[46;3H\u001b[H\u001b[2K\u001b[?25l\u001b[38;2;153;153;153m\u001b[39m' }
  await ui.press({ key: `${PREFIX}reply` })
  await clock.settle()
  expect(data.asks).toHaveLength(2)
  expect(data.asks[1]).toContain('讀不到 Agent 的提問，按 l 看輸出')
  await ui.unmount()
})

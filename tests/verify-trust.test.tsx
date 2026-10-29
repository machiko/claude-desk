import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, REGISTRY, result, leaves, text, flat } from './fixture'
import { AGENT_STOPPED } from '../hooks/chain'

// 完成檢查的核准：按 g 開始一輪流程時就問；流程停在檢查段時說得出為什麼，排除後按 v 就接著走。
const ROOT = '/home/u/wt/alpha'
const PREFIX = `case-${CARD_A}-`
const CHANGED = '完成檢查的指令改過、還沒經你核准：按 v 看指令並核准，核准後流程接著走'
const COMPOSE = { options: { composeDir: '/home/u/app' } }
const IN_APP = 'docker compose exec -T app php artisan test'
const svc = (Service: string, State = 'running') => JSON.stringify({ Service, State, Health: '' })
const sh = (data: any) => data.processCalls.filter((c: any) => c.argv[0] === 'sh').length

/** 只看 Alpha：卡片沒有待決策、沒有別的 Agent；每次派工都換一個背景 agent，跑到 finish() 才結束。 */
function alphaOnly(data: any, clock: any) {
  data.files[REGISTRY] = `## 任務\n| Project | path |\n| --- | --- |\n| Alpha | \`${CARD_A}\` |`
  data.git[ROOT] = { branch: 'feature/alpha', head: 'h1' }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.agents = []
  let n = 0
  data.launch = async (e: any) => {
    n++
    const id = `a000000${n}`
    data.agents = [{ id, kind: 'background', cwd: ROOT, name: e.argv[3], sessionId: `${id}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, id)
  }
}

function helpers($: any, data: any, clock: any) {
  const step = async () => { await clock.advance(2500); await clock.settle() }
  return {
    step,
    refresh: async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() },
    finish: async () => {
      data.agents = data.agents.map((a: any) => ({ ...a, status: 'idle', state: 'done' }))
      await $.command.run({ command: 'desk', args: 'refresh' } as any)
      await clock.settle(); await step(); await step(); await step()
    },
    verify: async () => { await $.command.run({ command: 'desk', args: 'verify Alpha' } as any); await clock.settle(); await step(); await step() },
    prompt: (i: number) => String(data.launches[i].argv[data.launches[i].argv.length - 1]),
    setGate: (g: string) => { data.files[CARD_A] = data.files[CARD_A]!.replace(/- 關卡：.*$/m, `- 關卡：${g}`) },
    setCheck: (cmd: string) => { data.files[CARD_A] = data.files[CARD_A]!.replace(/- 驗證：.*$/m, `- 驗證：\`${cmd}\``) },
    /** 面板上按兩次 g（派工要按兩次確認）。 */
    pressGo: async (ui: any) => {
      await ui.press({ key: `${PREFIX}continue` }); await clock.settle()
      await ui.press({ key: `${PREFIX}continue` }); await clock.settle()
    },
  }
}

/** AC-1 */
test('pressing g asks to approve the check command before dispatching and the chain runs it without pausing', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  const h = helpers($, data, clock)
  await h.refresh()

  let ui = await $.ui.mount(PANE(120))
  await h.pressGo(ui)
  await ui.unmount()

  // 先問：根目錄、指令全文、做完會自動執行；選項只有兩個
  expect(data.asks.length).toBe(1)
  expect(data.asks[0]).toContain(ROOT)
  expect(data.asks[0]).toContain('node test.mjs')
  expect(data.asks[0]).toContain('自動執行')
  expect(data.askOptions[0]).toEqual(['核准並派工', '取消'])
  // 核准後派出實作
  expect(data.launches.length).toBe(1)
  expect(data.store.trustedVerify).toEqual({ [CARD_A]: 'node test.mjs' })

  // 實作結束：自動執行完成檢查，不停在「尚未核准」，綠了接著派審查
  await h.finish()
  expect(data.asks.length).toBe(1)
  expect(sh(data)).toBe(1)
  expect(data.launches.length).toBe(2)
  expect(h.prompt(1)).toContain('程式碼審查')
  expect((data.store.chains as any)[ROOT].stopped).toBeUndefined()
  expect(data.toasts.some(t => t.includes('核准') || t.includes('授權'))).toBe(false)

  // 審查通過；同一張卡、同一條指令再按 g：不再問，直接派
  h.setGate('review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；可合併')
  await h.finish()
  expect((data.store.chains as any)[ROOT].passed).toBe(true)
  ui = await $.ui.mount(PANE(120))
  await ui.press({ key: 'more' }) // 合併段平常不列 g；展開全部動作再按
  await h.pressGo(ui)
  await ui.unmount()
  expect(data.asks.length).toBe(1)
  expect(data.launches.length).toBe(3)
})

/** AC-2 */
test('declining the check approval on g dispatches nothing', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  const h = helpers($, data, clock)
  await h.refresh()
  const ui = await $.ui.mount(PANE(120))
  const before = flat(text(await ui.drawn()))

  // 選「取消」
  data.approve = '取消'
  await h.pressGo(ui)
  // 直接關掉對話框（沒有回答）
  data.approve = ''
  await h.pressGo(ui)
  await h.step()

  expect(data.asks.length).toBe(2)
  expect(data.launches.length).toBe(0)
  expect(data.store.trustedVerify).toBeUndefined()
  expect(data.store.chains).toBeUndefined()
  expect(data.store.jobs).toBeUndefined()
  expect(data.toasts.some(t => t.includes('已派出'))).toBe(false)
  const after = flat(text(await ui.drawn()))
  expect(after).toBe(before)
  expect(after).not.toContain(flat('派繼續'))
  await ui.unmount()
})

/** AC-3 */
test('a check command changed by the agent pauses the chain with a reason you can act on', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  const notified: string[] = []
  on('ui.notify', (_: any, e: any) => { notified.push(e.text); return { value: { isSent: true as const, channel: 'terminal_bell' as const } } })
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const h = helpers($, data, clock)
  await h.refresh()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches.length).toBe(1)

  // Agent 把檢查指令改了
  h.setCheck('node test.mjs --all')
  await h.finish()

  // 不執行改過的指令，流程暫停
  expect(sh(data)).toBe(0)
  expect(data.launches.length).toBe(1)
  expect(data.asks.length).toBe(0)
  expect((data.store.chains as any)[ROOT].stopped).toBe(CHANGED)

  // 「▶ 輪到你」說原因，按鍵是 v
  const ui = await $.ui.mount(PANE(160))
  const shown = flat(text(await ui.drawn()))
  expect(shown).toContain(flat(`▶ 輪到你  ${CHANGED}`))
  const v = await ui.find({ key: `${PREFIX}verify` })
  expect(leaves(v, 'Text').some((t: any) => t.props?.bold)).toBe(true)
  // 動態、提示、系統通知說同一件事，沒有「尚未授權」
  expect(shown).toContain(flat(`Alpha 流程已暫停：${CHANGED}`))
  expect(data.toasts.some(t => t.includes(CHANGED))).toBe(true)
  expect(notified.some(t => t.includes(CHANGED))).toBe(true)
  for (const said of [shown, ...data.toasts, ...notified]) expect(said).not.toContain('尚未授權')
  await ui.unmount()
})

/** AC-4 */
test('pressing v on a chain paused at the check resumes it', COMPOSE, async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  data.compose = svc('app')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  let breakNext = false
  // 動態紀錄（一般事件面板不顯示）：state.set 只能掛一次，跟寫壞 verifies 共用。
  let feed: { text: string }[] = []
  on('state.set', (_: any, e: any, next: any) => {
    if (e?.plugin === 'desk' && e?.key === 'feed' && Array.isArray(e.value)) feed = e.value
    if (!breakNext || e?.key !== 'verifies') return next(e)
    breakNext = false
    return { deny: '狀態寫不進去' }
  })
  const h = helpers($, data, clock)
  const shown = async () => { const ui = await $.ui.mount(PANE(160)); const s = flat(text(await ui.drawn())); await ui.unmount(); return s }
  const chain = () => (data.store.chains as any)[ROOT]
  await h.refresh()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()

  // 一、指令未核准：Agent 改了指令 → 暫停；按 v、對話框選「執行」→ 通過 → 自動派審查
  h.setCheck(IN_APP)
  await h.finish()
  expect(chain().stopped).toBe(CHANGED)
  await h.verify()
  expect(data.asks.length).toBe(1)
  expect(sh(data)).toBe(1)
  expect(chain().stopped).toBeUndefined()
  expect(data.launches.length).toBe(2)
  expect(h.prompt(1)).toContain('程式碼審查')
  expect(feed.some(e => e.text.startsWith('Alpha 流程繼續'))).toBe(true)
  expect(await shown()).not.toContain(flat('Alpha 流程繼續'))

  // 審查有 HIGH → 自動修正第 1 輪
  h.setGate('review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核')
  await h.finish()
  expect(data.launches.length).toBe(3)
  expect(h.prompt(2)).toContain('修正第 1／2 輪')

  // 二、容器沒啟動：修完自動檢查跑不了 → 暫停；啟動容器後按 v → 沒過 → 自動派修正第 2 輪（輪數照算）
  h.setGate('無')
  data.git[ROOT]!.head = 'h2'
  data.compose = svc('app', 'exited')
  await h.finish()
  expect(sh(data)).toBe(1)
  expect(chain().stopped).toContain('容器 app 未啟動')
  data.compose = svc('app')
  data.run = async () => result(1, '', 'FAILED 1 test')
  await h.verify()
  expect(sh(data)).toBe(2)
  expect(chain().stopped).toBeUndefined()
  expect(data.launches.length).toBe(4)
  expect(h.prompt(3)).toContain('修正第 2／2 輪')

  // 三、檢查中斷：修完自動檢查跑到一半記不下結果 → 暫停；按 v → 通過 → 自動派審查
  data.git[ROOT]!.head = 'h3'
  data.run = async () => result(0, 'all green\n')
  breakNext = true
  await h.finish()
  expect(breakNext).toBe(false)
  expect(chain().stopped).toContain('檢查中斷')
  expect(data.launches.length).toBe(4)
  await h.verify()
  expect(chain().stopped).toBeUndefined()
  expect(data.launches.length).toBe(5)
  expect(h.prompt(4)).toContain('程式碼審查')
  expect(chain().round).toBe(2)
  expect(data.asks.length).toBe(1)
})

/** AC-5 */
test('pressing v without a paused chain only runs the check', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const h = helpers($, data, clock)
  const chainsBefore = (chains: unknown) => JSON.parse(JSON.stringify(chains ?? null))

  // 沒開過流程
  await h.refresh()
  await h.verify()
  expect(sh(data)).toBe(1)
  expect((data.store.verifies as any)[CARD_A].ok).toBe(true)
  expect(data.launches.length).toBe(0)
  expect(data.store.chains).toBeUndefined()

  // 已過關
  data.store.chains = { [ROOT]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, reviewHead: 'h1', judgedHead: 'h1' } }
  const passed = chainsBefore(data.store.chains)
  await h.refresh()
  await h.verify()
  expect(sh(data)).toBe(2)
  expect(data.launches.length).toBe(0)
  expect(data.store.chains).toEqual(passed)

  // 你手動停止了 Agent（沒過也不派修正）
  data.run = async () => result(1, '', 'FAILED')
  data.store.chains = { [ROOT]: { owner: 'fixture-session', startedAt: 0, round: 0, stopped: '你手動停止了 Agent' } }
  data.store.jobs = { [ROOT]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'continue', startedAt: 0, fresh: false, owner: 'fixture-session' } } }
  const stopped = chainsBefore(data.store.chains)
  await h.refresh()
  await h.verify()
  expect(sh(data)).toBe(3)
  expect((data.store.verifies as any)[CARD_A].ok).toBe(false)
  expect(data.launches.length).toBe(0)
  expect(data.store.chains).toEqual(stopped)
  expect(data.asks.length).toBe(0)
})

const HELD = '容器 app 未啟動，請先在主工作區執行 docker compose up -d app'
const handledJob = { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'continue', startedAt: 0, fresh: false, owner: 'fixture-session', handled: true } }

/** 審查 MEDIUM：停在檢查段時派了同步、又按 k 停掉：暫停原因換成手動停止，按 v 只跑檢查，不說「流程繼續」。 */
test('stopping an agent on a chain paused at the check drops the pause so v only runs the check', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.store.chains = { [ROOT]: { owner: 'fixture-session', startedAt: 0, round: 0, stopped: HELD, heldAtCheck: true } }
  data.store.jobs = { [ROOT]: handledJob }
  const realRun = data.run
  data.run = async (e: any) => e.argv[0] === 'claude' && e.argv[1] === 'stop' ? result(0, '') : realRun(e)
  const h = helpers($, data, clock)
  const chain = () => (data.store.chains as any)[ROOT]
  await h.refresh()
  await $.command.run({ command: 'desk', args: 'sync Alpha' } as any)
  await clock.settle()
  expect(data.launches.length).toBe(1)

  let ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `${PREFIX}stop` })
  await ui.press({ key: `${PREFIX}stop` })
  await clock.settle()
  await ui.unmount()
  expect(chain().stopped).toBe(AGENT_STOPPED)
  expect(chain().heldAtCheck).toBeUndefined()

  data.agents = []
  await h.refresh()
  ui = await $.ui.mount(PANE(160))
  const before = flat(text(await ui.drawn()))
  await ui.unmount()
  expect(before).not.toContain(flat('排除後按 v 重跑檢查，流程接著走'))

  await h.verify()
  expect(sh(data)).toBe(1)
  expect(data.launches.length).toBe(1)
  expect(chain().stopped).toBe(AGENT_STOPPED)
  ui = await $.ui.mount(PANE(160))
  const after = flat(text(await ui.drawn()))
  await ui.unmount()
  expect(after).not.toContain(flat('流程繼續'))
})

/** 審查 MEDIUM：別的對話開的流程停在檢查段：這個對話按 v 接不下去，「▶ 輪到你」說要去哪裡接，鍵是 g。 */
test('a chain paused at the check by another conversation says where it resumes instead of promising v', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs', '/elsewhere': 'x' }
  const h = helpers($, data, clock)
  const screen = async () => { const ui = await $.ui.mount(PANE(160)); const s = flat(text(await ui.drawn())); const go = await ui.find({ key: `${PREFIX}continue` }); await ui.unmount(); return { s, go } }
  const ELSEWHERE = '：這個流程是別的對話開的，到那個對話按 v 才會接著走；或在這裡按 g 重開一輪'

  data.store.chains = { [ROOT]: { owner: 'other-session', startedAt: 0, round: 0, stopped: HELD, heldAtCheck: true } }
  await h.refresh()
  let shown = await screen()
  expect(shown.s).toContain(flat(`▶ 輪到你  流程已暫停（${HELD}）${ELSEWHERE}`))
  expect(shown.s).not.toContain(flat('排除後按 v 重跑檢查，流程接著走'))
  expect(leaves(shown.go, 'Text').some((t: any) => t.props?.bold)).toBe(true)

  data.store.chains = { [ROOT]: { owner: 'other-session', startedAt: 0, round: 0, stopped: CHANGED, heldAtCheck: true } }
  await h.refresh()
  shown = await screen()
  expect(shown.s).toContain(flat(`▶ 輪到你  流程已暫停（完成檢查的指令改過、還沒經你核准）${ELSEWHERE}`))
  expect(shown.s).not.toContain(flat(`▶ 輪到你  ${CHANGED}`))
})

/** 流程停在檢查段後，Agent 把卡片的檢查整條清掉：不能再說「按 v 看指令並核准」（按 v 只會說卡片尚缺完成檢查），改叫你填檢查。 */
test('a chain paused at the check whose check was then cleared asks for a check, not v', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const h = helpers($, data, clock)
  data.store.chains = { [ROOT]: { owner: 'fixture-session', startedAt: 0, round: 0, stopped: CHANGED, heldAtCheck: true } }
  data.store.jobs = { [ROOT]: handledJob }
  data.files[CARD_A] = data.files[CARD_A]!.replace(/- 驗證：.*$/m, '- 驗證：無')

  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  const shown = flat(text(await ui.drawn()))
  const o = await ui.find({ key: `${PREFIX}open` })
  await ui.unmount()

  expect(shown).toContain(flat('▶ 輪到你  卡片尚缺完成檢查：開卡片（o）'))
  expect(shown).not.toContain(flat('按 v 看指令並核准'))
  expect(leaves(o, 'Text').some((t: any) => t.props?.bold)).toBe(true)
})

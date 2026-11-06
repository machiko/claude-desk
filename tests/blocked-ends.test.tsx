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
    expect(shown).not.toContain(flat('y 回覆 Agent 的提問'))
    expect(shown).not.toContain(flat('Agent 等待你回覆'))
    // 「輪到你」照卡片的階段與下一步說
    expect(shown).toContain(flat('▶ 輪到你 g 派 Agent 做下一步（依審核修正）'))
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
  expect(await screen(ui)).toContain(flat('▶ 輪到你 y 回覆 Agent 的提問'))
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

const HANDED = 'Alpha 「等你」已在對話處理，流程不替那次派工接著跑；照「輪到你」繼續'
const setAsk = (data: any, ask: string) => { data.files[CARD_A] = data.files[CARD_A]!.replace(/- 等你：.*$/m, `- 等你：${ask}`) }

/**
 * AC-6 共用：自動流程派的實作（viaReply 時再回覆一次）做完一輪（blocked／idle）時把題目寫進「等你」：
 * 流程停著等你，不跑測試、不派驗收；在對話處理完（清成無）後也不自動接著派，動態說一聲。
 */
async function waitsForCardQuestion($: any, on: any, viaReply: boolean) {
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
  if (viaReply) {
    // 實作 Agent 停下來提問（status waiting），你回覆它：派出回覆
    data.agents = data.agents.map((a: any) => ({ ...a, state: 'blocked', status: 'waiting', waitingFor: 'input needed' }))
    await h.refresh()
    await $.command.run({ command: 'desk', args: 'reply Alpha 先做記憶體版' } as any)
    await clock.settle()
    await h.refresh()
    expect(data.launches).toHaveLength(2)
    expect((data.store.jobs as any)['/home/u/wt/alpha'].last.kind).toBe('reply')
  }
  const launched = data.launches.length

  // 那次派工把題目寫進「等你」後結束（blocked／idle）
  setAsk(data, '快取要用哪種：A) 記憶體 B) Redis')
  data.agents = data.agents.map((a: any) => ({ ...a, state: 'blocked', status: 'idle', waitingFor: undefined }))
  await h.refresh()
  await h.step(); await h.step(); await h.step()

  // 停著等你：不跑測試、不派驗收；面板照卡片說「等你」
  expect(sh(data)).toBe(0)
  expect(data.launches).toHaveLength(launched)
  const ui = await $.ui.mount(PANE(120))
  expect(await screen(ui)).toContain(flat('▶ 輪到你 f 填入決策（先按選項字母'))
  await ui.unmount()

  // 在對話處理完：「等你」清成無。流程不替那次派工接著跑測試或派工，動態說一聲
  setAsk(data, '無')
  await h.refresh()
  await h.step(); await h.step(); await h.step()
  expect(sh(data)).toBe(0)
  expect(data.launches).toHaveLength(launched)
  expect(log.has(HANDED)).toBe(true)
}

/** AC-6：實作（修正同是 continue）做完時把題目寫進「等你」。 */
test('test_auto_chain_waits_when_agent_ends_with_question_on_card', async ($, on) => {
  await waitsForCardQuestion($, on, false)
})

/** AC-6：回覆（y）做完時把題目寫進「等你」，一樣停著等你。 */
test('test_auto_chain_waits_when_reply_ends_with_question_on_card', async ($, on) => {
  await waitsForCardQuestion($, on, true)
})

/** D-04：驗收通過後有新 commit，「等你」留著審查寫的 MEDIUM 題目：照舊自動重新測試與驗收，不被「等你」擋住。 */
test('test_recheck_after_pass_is_not_held_by_review_question_on_card', async ($, on) => {
  const { data, clock } = fixture(on)
  alphaOnly(data, clock)
  const root = '/home/u/wt/alpha'
  data.git[root] = { branch: 'feature/alpha', head: 'h2' }
  data.files[CARD_A] = data.files[CARD_A]!.replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；過')
  setAsk(data, '審查 MEDIUM 1 條（測試名沿用舊說法）怎麼處理：A) 不修，記錄原因 B) 修掉 C) 改規格')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.store.chains = { [root]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, reviewHead: 'h1', judgedHead: 'h1' } }
  data.store.jobs = { [root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }
  const h = helpers($, data, clock)

  await h.refresh()
  await h.step(); await h.step(); await h.step(); await h.step()

  expect(sh(data)).toBe(1)
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0)).toContain('審查通過後又有新 commit 的重新審查')
})

/** AC-6 的範圍：流程早已處理完那次實作（停在檢查段），之後「等你」有過一題又清掉：按 v 重開照舊派驗收，不說「不替那次派工接著跑」。 */
test('test_check_paused_chain_still_dispatches_review_after_card_question_cleared', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  alphaOnly(data, clock)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const h = helpers($, data, clock)
  await h.refresh()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()

  // 實作把測試指令改了：做完後流程停在檢查段
  h.setCheck('node test.mjs --all')
  await h.finish()
  expect((data.store.chains as any)['/home/u/wt/alpha'].stopped).toContain('測試指令改過')

  // 「等你」有過一題（例如別的對話寫的），又在對話清成無
  setAsk(data, '要先發版嗎？A) 要 B) 不要')
  await h.refresh()
  setAsk(data, '無')
  await h.refresh()
  expect(log.has(HANDED)).toBe(false)

  // 按兩次 v 核准並執行：通過後照舊自動派驗收
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `case-${CARD_A}-verify` }); await clock.settle()
  await ui.press({ key: `case-${CARD_A}-verify` }); await clock.settle()
  await ui.unmount()
  await h.step(); await h.step()
  expect(sh(data)).toBe(1)
  expect(data.launches).toHaveLength(2)
  expect(h.prompt(1)).toContain('程式碼審查')
})

/** AC-6 的範圍：流程停在檢查段時「等你」有題目（不是那次實作寫的），核准後用 /desk verify 重開：通過後照舊派驗收，清掉題目也不說「不替那次派工接著跑」。 */
test('test_check_paused_chain_resumed_with_question_on_card_still_dispatches_review', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  alphaOnly(data, clock)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const h = helpers($, data, clock)
  await h.refresh()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()

  // 實作把測試指令改了：做完後流程停在檢查段
  h.setCheck('node test.mjs --all')
  await h.finish()
  expect((data.store.chains as any)['/home/u/wt/alpha'].stopped).toContain('測試指令改過')

  // 暫停後「等你」寫了一題，題目還在時核准新指令、用指令重開
  setAsk(data, '要先發版嗎？A) 要 B) 不要')
  await h.refresh()
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs --all' }
  await h.verify()
  await h.step(); await h.step()
  expect(sh(data)).toBe(1)
  expect(data.launches).toHaveLength(2)
  expect(h.prompt(1)).toContain('程式碼審查')

  // 題目在對話處理掉：不說「不替那次派工接著跑」，也不多派
  setAsk(data, '無')
  await h.refresh()
  await h.step(); await h.step()
  expect(log.has(HANDED)).toBe(false)
  expect(data.launches).toHaveLength(2)
})

const COMPOSE = { options: { composeDir: '/home/u/app' } }
const IN_APP = 'docker compose exec -T app php artisan test'
const svc = (Service: string, State = 'running') => JSON.stringify({ Service, State, Health: '' })

/**
 * AC-6 的範圍：自動檢查開跑後流程因容器未啟動停在檢查段（那次實作沒標成處理過），暫停中「等你」出現題目：
 * 題目留著按 v、或先清掉再按 v，通過後都照舊派驗收，不說「不替那次派工接著跑」。
 */
for (const clearFirst of [false, true]) {
  test(`test_check_paused_for_containers_still_dispatches_review_with_question_on_card${clearFirst ? '_cleared_first' : ''}`, COMPOSE, async ($, on) => {
    const { data, clock } = fixture(on)
    const log = feedLog(on)
    alphaOnly(data, clock)
    data.files[CARD_A] = data.files[CARD_A]!.replace(/- 驗證：.*$/m, `- 驗證：\`${IN_APP}\``)
    data.store.trustedVerify = { [CARD_A]: IN_APP }
    const h = helpers($, data, clock)
    await h.refresh()
    await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
    await clock.settle()

    // 容器沒起來：實作做完、自動檢查跑不了 → 停在檢查段
    data.compose = svc('app', 'exited')
    await h.finish()
    expect((data.store.chains as any)['/home/u/wt/alpha'].stopped).toContain('容器 app 未啟動')

    // 暫停中「等你」寫了一題（不是那次實作寫的）
    setAsk(data, '要先發版嗎？A) 要 B) 不要')
    await h.refresh()
    if (clearFirst) { setAsk(data, '無'); await h.refresh() }

    // 容器起來後重開：通過後照舊派驗收
    data.compose = svc('app')
    await h.verify()
    await h.step(); await h.step()
    expect(data.launches).toHaveLength(2)
    expect(h.prompt(1)).toContain('程式碼審查')

    setAsk(data, '無')
    await h.refresh()
    await h.step(); await h.step()
    expect(log.has(HANDED)).toBe(false)
    expect(data.launches).toHaveLength(2)
  })
}

/**
 * AC-6 之後：實作改了測試指令、又把題目寫進「等你」後做完；在對話清掉後流程停在檢查段（指令改過）。
 * 核准新指令後重開：照暫停時說的「流程接著走」，通過後派驗收。
 */
test('test_question_handled_then_check_paused_resumes_to_review', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  alphaOnly(data, clock)
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const h = helpers($, data, clock)
  await h.refresh()
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()

  h.setCheck('node test.mjs --all')
  setAsk(data, '快取要用哪種：A) 記憶體 B) Redis')
  await h.finish()
  expect(data.launches).toHaveLength(1)

  // 在對話處理完：說一聲不替那次派工接著跑，流程停在檢查段等你核准指令
  setAsk(data, '無')
  await h.refresh(); await h.step(); await h.step()
  expect(log.has(HANDED)).toBe(true)
  expect((data.store.chains as any)['/home/u/wt/alpha'].stopped).toContain('測試指令改過')
  expect(data.launches).toHaveLength(1)

  // 核准後重開：通過後派驗收
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs --all' }
  await h.verify()
  await h.step(); await h.step()
  expect(sh(data)).toBe(1)
  expect(data.launches).toHaveLength(2)
  expect(h.prompt(1)).toContain('程式碼審查')
})

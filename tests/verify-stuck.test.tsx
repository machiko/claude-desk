import { expect, test } from 'claude-code/testing'
import { fixture, feedLog, PANE, CARD_A, result, flat } from './fixture'
import { screen, busyAgent as busy } from './world'
import { REVIEW_FIX_NOT_SENT } from '../hooks/chain'

// 驗收卡住：審查有 CRITICAL／HIGH、自動流程要派修正卻派不出去（啟動失敗、從隊伍派出才失敗）時，流程停下、「輪到你」說按 g，
// 不再一直顯示「處理中・Agent 在驗收」；已啟動只是清單還沒列出的照舊等它出現。
const ALPHA = '/home/u/wt/alpha'
const ME = 'fixture-session'
const SETTINGS = '/home/u/.claude/handoffs/dispatch.json'
const PAUSED = `Alpha 流程已暫停：${REVIEW_FIX_NOT_SENT}`
/** 三個在跑的工作桌 Agent，都在不在登錄表的根目錄（別的專案）：名額滿。 */
const FULL = () => [busy('desk-m0-0', '/home/u/other/one'), busy('desk-m0-1', '/home/u/other/two'), busy('desk-m0-2', '/home/u/other/three')]

/** 只看 Alpha：等你清空、關卡是審查 HIGH 1；這個對話的流程在第 0 輪、剛結束一次審查（審查的是現在的 HEAD）、還沒處理。 */
function reviewHighJustFinished(data: any) {
  data.files[CARD_A] = data.files[CARD_A]!.replace(/- 等你：.*$/m, '- 等你：無').replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核')
  data.files[`${ALPHA}/.task/REVIEW.md`] = '- [HIGH][稽核] a.ts:1 — 漏寫稽核紀錄'
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.store.verifies = { [CARD_A]: { command: 'node test.mjs', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head: 'h1' } }
  data.store.chains = { [ALPHA]: { owner: ME, startedAt: 0, round: 0, reviewHead: 'h1', reviewBranch: 'feature/alpha' } }
  data.store.jobs = { [ALPHA]: { sessionId: 'a0000001-0000-4000-8000-000000000000', last: { launchName: 'desk-rv-0', nativeId: 'r0000001', sessionId: 'r0000001-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: ME, ended: { how: 'finished' } } } }
}

function helpers($: any, data: any, clock: any) {
  const step = async () => { await clock.advance(2500); await clock.settle() }
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() }
  const prompt = (i: number) => String(data.launches[i].argv.at(-1))
  /** 選 Alpha 看現在卡。 */
  const shown = async (): Promise<string> => {
    const ui = await $.ui.mount(PANE(160))
    await ui.press({ key: `row-${CARD_A}` })
    const out = await screen(ui)
    await ui.unmount()
    return out
  }
  return { step, refresh, prompt, shown }
}

/** 派出去的 Agent 都只留最新那個在跑。 */
function launchOk(data: any, clock: any) {
  data.launch = async (e: any) => {
    const id = `f000000${data.launches.length}`
    data.agents = [{ ...busy(e.argv[3], e.init.cwd, clock.now()), id, sessionId: `${id}-0000-4000-8000-000000000000` }]
    return result(0, id)
  }
}

/** 流程停下後「輪到你」：說流程已暫停與按 g，不再是處理中、Agent 在驗收。 */
function expectPausedTurn(shown: string) {
  expect(shown).toContain(flat(`▶ 輪到你 g 再修一輪（流程已暫停：${REVIEW_FIX_NOT_SENT}`))
  expect(shown).not.toContain(flat('Agent 在驗收'))
  expect(shown).not.toContain(flat('處理中'))
}

/** AC-1：審查 HIGH 後自動派修正啟動失敗（網路錯誤）：流程停下、動態只寫一筆暫停、輪到你說按 g，之後重新整理不再重派。 */
test('test_auto_fix_after_review_high_launch_failure_pauses_chain', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  const h = helpers($, data, clock)
  data.agents = []
  data.launch = async () => result(1, '', 'Error: network unreachable')
  reviewHighJustFinished(data)

  await h.refresh()
  for (let i = 0; i < 4; i++) { await h.refresh(); await h.step() }

  // 只試了一次；流程停下並記原因
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0).startsWith('修正第 1／2 輪')).toBe(true)
  const run = (data.store.chains as any)[ALPHA]
  expect(run.stopped).toBe('reviewFixNotSent')
  // 動態的「流程已暫停」只寫一筆
  expect(log.list.filter(e => flat(e.text) === flat(PAUSED))).toHaveLength(1)
  expect(log.list.find(e => flat(e.text) === flat(PAUSED))?.tone).toBe('error')
  expectPausedTurn(await h.shown())
})

/** AC-3：名額已滿、審查 HIGH 後的修正排進隊伍；空出名額、從隊伍派出時啟動失敗：跟直接派一樣停下、輪到你說按 g。 */
test('test_queued_auto_fix_after_review_high_launch_failure_pauses_chain', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  const h = helpers($, data, clock)
  data.files[SETTINGS] = JSON.stringify({ maxAgents: 3 })
  data.agents = FULL()
  data.launch = async () => result(1, '', 'Error: network unreachable')
  reviewHighJustFinished(data)
  await h.refresh(); await h.step()
  expect(data.launches).toHaveLength(0)
  expect(log.has('Alpha 自動派修正第 1 輪排隊中（第 1 位）')).toBe(true)
  expect((data.store.chains as any)[ALPHA].stopped).toBeUndefined()

  // 空出名額：從隊伍派出，啟動失敗
  data.agents = data.agents.map((a: any, i: number) => i === 0 ? { ...a, status: 'idle', state: 'done' } : a)
  await h.refresh()
  for (let i = 0; i < 4; i++) { await h.refresh(); await h.step() }

  expect(data.launches).toHaveLength(1)
  expect((data.store.chains as any)[ALPHA].stopped).toBe('reviewFixNotSent')
  expect(log.list.filter(e => flat(e.text) === flat(PAUSED))).toHaveLength(1)
  expectPausedTurn(await h.shown())
})

/** AC-4：AC-1 停下後啟動恢復正常，按 g：派出依審查檔修正的 Agent；派出去才算一輪（停下那次不算）。 */
test('test_press_g_after_unsent_review_fix_dispatches_fix', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  data.launch = async () => result(1, '', 'Error: network unreachable')
  reviewHighJustFinished(data)
  await h.refresh()
  for (let i = 0; i < 2; i++) { await h.refresh(); await h.step() }
  expect((data.store.chains as any)[ALPHA].stopped).toBe('reviewFixNotSent')
  // 停下那次不算一輪
  expect((data.store.chains as any)[ALPHA].fixTotal ?? 0).toBe(0)

  launchOk(data, clock)
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_A}` })
  await ui.press({ key: `case-${CARD_A}-continue` }); await clock.settle()
  await ui.press({ key: `case-${CARD_A}-continue` }); await clock.settle()
  await ui.unmount()

  expect(data.launches).toHaveLength(2)
  // 卡片下一步不是等待句也一樣：開頭是依審查檔的修正，不是照下一步繼續、也不把停下原因交給 Agent
  expect(h.prompt(1).startsWith('修正：依 .task/REVIEW.md 修正所有 CRITICAL、HIGH')).toBe(true)
  expect(h.prompt(1)).not.toContain(REVIEW_FIX_NOT_SENT)
  const run = (data.store.chains as any)[ALPHA]
  expect(run.fixTotal).toBe(1)
  expect(run.stopped).toBeUndefined()
})

/** M-1：審查 HIGH 後自動派修正，Agent 已啟動、只是 agents 清單還沒列出：流程不停下、不重派，等 Agent 出現。 */
test('test_auto_fix_launch_unconfirmed_keeps_chain_running', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  const h = helpers($, data, clock)
  data.agents = []
  let started: any = null
  // 啟動成功，但清單要等一下才列出這個 Agent
  data.launch = async (e: any) => { started = { ...busy(e.argv[3], e.init.cwd, clock.now()), id: 'f0000001', sessionId: 'f0000001-0000-4000-8000-000000000000' }; return result(0, 'f0000001') }
  reviewHighJustFinished(data)
  await h.refresh()
  for (let i = 0; i < 3; i++) { await h.refresh(); await h.step() }

  expect(data.launches).toHaveLength(1)
  expect((data.store.chains as any)[ALPHA].stopped).toBeUndefined()
  expect(log.has(PAUSED)).toBe(false)

  // 清單列出來了：照樣只有那一個
  data.agents = [started]
  for (let i = 0; i < 2; i++) { await h.refresh(); await h.step() }
  expect(data.launches).toHaveLength(1)
  expect((data.store.chains as any)[ALPHA].stopped).toBeUndefined()
})

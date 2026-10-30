import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, CARD_C, result, text, flat, feedLog } from './fixture'
import { buildPrompt } from '../hooks/dispatch'
import { buildCase } from '../hooks/model'
import { pipeline, stageLabel } from '../hooks/pipeline'

// 審查找到可能影響行為的 MEDIUM（審查檔裡沒標「不修」「等你決定」的）：跟 CRITICAL／HIGH 同一輪自動派修正，共用兩輪上限。
const ALPHA = '/home/u/wt/alpha'
const BETA = '/home/u/wt/beta'
const GAMMA = '/home/u/wt/gamma'
const ME = 'fixture-session'
const IMPL = 'a0000001-0000-4000-8000-000000000000'
const ASK = '審查 MEDIUM 1 條（空字串沒處理）怎麼處理：A) 不修，記錄原因 B) 修掉 C) 改規格'
const AUTO = '工作桌會跟 CRITICAL／HIGH 一起自動派修正'
const screen = async (ui: any) => flat(text(await ui.drawn()))
const busy = (name: string, cwd: string, at = 0) => ({ id: name.slice(-8), kind: 'background', cwd, name, sessionId: `${name.slice(-8)}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: at })

/** 卡片：等你清空（或換成指定的題目）、關卡寫成指定的審查結論。 */
function setCard(data: any, card: string, gate: string, ask = '無') {
  data.files[card] = data.files[card]!.replace(/- 等你：.*$/m, `- 等你：${ask}`).replace(/- 關卡：.*$/m, `- 關卡：${gate}`)
}

/** 這個對話的流程（或 owner 指定的別的對話）在第 round 輪，剛結束一次審查（審查的是現在的 HEAD）、還沒處理。 */
function reviewJustFinished(data: any, root: string, round: number, opts: { owner?: string; security?: boolean } = {}) {
  const owner = opts.owner ?? ME
  const { branch, head } = data.git[root]
  // 派審查前的完成檢查在這個 HEAD 通過過
  const card = `${root}/.desk/CARD.md`
  data.store.verifies = { ...(data.store.verifies ?? {}), [card]: { command: 'node test.mjs', at: 0, ok: true, exitCode: 0, tail: [], truncated: false, head } }
  data.store.chains = { ...(data.store.chains ?? {}), [root]: { owner, startedAt: 0, round, reviewHead: head, reviewBranch: branch, ...(opts.security ? { securityHead: head, securityBranch: branch } : {}) } }
  data.store.jobs = { ...(data.store.jobs ?? {}), [root]: { sessionId: IMPL, last: { launchName: 'desk-rv-0', nativeId: 'r0000001', sessionId: 'r0000001-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner, ...(round ? { round: 0 } : {}), ...(opts.security ? { security: true } : {}) } } }
}

function helpers($: any, data: any, clock: any) {
  const step = async () => { await clock.advance(2500); await clock.settle() }
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() }
  /** 在跑的 Agent 都做完，流程接著走 steps 步（實作／修正做完要等檢查跑完再派審查；審查做完在同一次重新整理就派出下一步）。 */
  const finish = async (steps = 0) => {
    data.agents = data.agents.map((a: any) => ({ ...a, status: 'idle', state: 'done' }))
    await refresh()
    for (let i = 0; i < steps; i++) await step()
  }
  const prompt = (i: number) => String(data.launches[i].argv.at(-1))
  const fixes = () => data.launches.filter((l: any) => String(l.argv.at(-1)).startsWith('修正第'))
  return { step, refresh, finish, prompt, fixes }
}

/** 派出去的 Agent 都只留最新那個在跑（照 chain-flow 的寫法）。 */
function launchOneAtATime(data: any, clock: any) {
  data.launch = async (e: any) => {
    const id = `f000000${data.launches.length}`
    data.agents = [{ ...busy(e.argv[3], e.init.cwd, clock.now()), id, sessionId: `${id}-0000-4000-8000-000000000000` }]
    return result(0, id)
  }
}

/** AC-1 */
test('test_high_and_unmarked_medium_are_fixed_in_one_round_when_rounds_remain', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs', [CARD_B]: 'npm test' }
  launchOneAtATime(data, clock)
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 1、MEDIUM 3、LOW 1；漏稽核')
  data.files[`${ALPHA}/.task/REVIEW.md`] = [
    '| AC-1 | 做到 | t.ts |',
    '- [HIGH][稽核] a.ts:1 — 漏寫稽核紀錄',
    '- [MEDIUM][邊界] b.ts:2 — 空字串沒處理',
    '- [MEDIUM][命名] c.ts:3 — 變數名不清（記錄、不修）',
    '- [MEDIUM][規格] — AC-2 無法驗證（等你決定）',
    '- [LOW][風格] d.ts:4 — 縮排',
  ].join('\n')
  reviewJustFinished(data, ALPHA, 0)
  await h.refresh()

  // 只派一個修正第 1／2 輪，接續實作那個 session；CRITICAL、HIGH 與沒加註記的 MEDIUM 一起修，LOW 不用修
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0).startsWith('修正第 1／2 輪：')).toBe(true)
  expect(h.prompt(0)).toContain('修正所有 CRITICAL、HIGH，與沒標「不修」「等你決定」的 MEDIUM（LOW 不用修）')
  expect(data.launches[0].argv[data.launches[0].argv.indexOf('--resume') + 1]).toBe(IMPL)
  expect((data.store.chains as any)[ALPHA].round).toBe(1)

  // 修完：關卡改回無、有新 commit → 自動檢查 → 派複審，要確認上一輪沒加註記的 MEDIUM 修好沒
  setCard(data, CARD_A, '無')
  data.git[ALPHA]!.head = 'h2'
  await h.finish(1)
  expect(data.processCalls.filter((c: any) => c.argv[0] === 'sh').length).toBe(1)
  expect(data.launches).toHaveLength(2)
  expect(h.prompt(1).startsWith('程式碼審查')).toBe(true)
  expect(h.prompt(1)).toContain('CRITICAL／HIGH 與沒加註記的 MEDIUM 有沒有修好')

  // 複審只剩記錄、不修的 MEDIUM：過關，流程只用了 1 輪
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可合併')
  data.files[`${ALPHA}/.task/REVIEW.md`] = '- [MEDIUM][命名] c.ts:3 — 變數名不清（記錄、不修）'
  await h.finish()
  expect(data.launches).toHaveLength(2)
  expect(h.fixes()).toHaveLength(1)
  expect(data.toasts).toContain('Alpha：審查通過，可以開 PR')
  expect((data.store.chains as any)[ALPHA].passed).toBe(true)
  expect((data.store.chains as any)[ALPHA].round).toBe(1)

  // 高風險卡：程式碼審查已過，資安審查有一條沒註記的 MEDIUM → 一樣自動派修正第 1／2 輪，依 .task/SECURITY.md
  data.git[BETA] = { branch: 'feature/beta', head: 'b1', files: ['app/Http/Middleware/Admin.php'] }
  setCard(data, CARD_B, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；輸入沒驗')
  data.files[`${BETA}/.task/REVIEW.md`] = '- [LOW][風格] x.php:1 — 縮排'
  data.files[`${BETA}/.task/SECURITY.md`] = '- [MEDIUM][輸入驗證] app/Http/Middleware/Admin.php:3 — 沒檢查長度'
  reviewJustFinished(data, BETA, 0, { security: true })
  await h.refresh()
  expect(data.launches).toHaveLength(3)
  expect(data.launches[2].init.cwd).toBe(BETA)
  expect(h.prompt(2).startsWith('修正第 1／2 輪：')).toBe(true)
  expect(h.prompt(2)).toContain('.task/SECURITY.md')
  expect(data.toasts.some((t: string) => t.includes('Beta') && t.includes('流程已暫停'))).toBe(false)

  // 修完照舊重新跑程式碼審查與資安審查；資安審查交給流程修，不在等你問
  setCard(data, CARD_B, '無')
  data.git[BETA]!.head = 'b2'
  await h.finish(1)
  expect(data.launches).toHaveLength(4)
  expect(h.prompt(3).startsWith('程式碼審查')).toBe(true)
  setCard(data, CARD_B, 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 1；可')
  await h.finish()
  expect(data.launches).toHaveLength(5)
  expect(h.prompt(4).startsWith('資安審查')).toBe(true)
  expect(h.prompt(4)).toContain(AUTO)
  expect(h.prompt(4)).not.toContain('這次不會自動修')
  expect(h.fixes()).toHaveLength(2)
})

/** 審查 MEDIUM 第 3 條：自動派的修正提示只寫剛結束那份審查的審查檔（程式碼審查 → REVIEW.md、資安審查 → SECURITY.md），兩份檔都在也不混 */
test('test_auto_fix_prompt_names_only_the_review_file_that_just_finished_when_both_files_exist', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs', [CARD_B]: 'npm test' }
  launchOneAtATime(data, clock)
  // Alpha：程式碼審查剛結束，REVIEW.md 有沒註記的 MEDIUM；上一次資安審查的 SECURITY.md 也還在
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；空字串沒處理')
  data.files[`${ALPHA}/.task/REVIEW.md`] = '- [MEDIUM][邊界] b.ts:2 — 空字串沒處理'
  data.files[`${ALPHA}/.task/SECURITY.md`] = '- [LOW][風格] a.ts:1 — 舊的資安審查'
  reviewJustFinished(data, ALPHA, 0)
  // Beta：資安審查剛結束，SECURITY.md 有沒註記的 MEDIUM；程式碼審查的 REVIEW.md 已過關
  data.git[BETA] = { branch: 'feature/beta', head: 'b1', files: ['app/Http/Middleware/Admin.php'] }
  setCard(data, CARD_B, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；輸入沒驗')
  data.files[`${BETA}/.task/REVIEW.md`] = '- [LOW][風格] x.php:1 — 縮排'
  data.files[`${BETA}/.task/SECURITY.md`] = '- [MEDIUM][輸入驗證] app/Http/Middleware/Admin.php:3 — 沒檢查長度'
  reviewJustFinished(data, BETA, 0, { security: true })

  await h.refresh()

  const sent = (root: string) => String(data.launches.find((l: any) => l.init.cwd === root)?.argv.at(-1) ?? '')
  expect(data.launches).toHaveLength(2)
  expect(sent(ALPHA)).toContain('修正第 1／2 輪：依 .task/REVIEW.md 修正所有')
  expect(sent(ALPHA)).not.toContain('.task/SECURITY.md')
  expect(sent(BETA)).toContain('修正第 1／2 輪：依 .task/SECURITY.md 修正所有')
  expect(sent(BETA)).not.toContain('.task/REVIEW.md')
})

/** AC-2 */
test('test_medium_only_review_stays_at_review_until_fix_is_sent_when_queue_is_full', async ($, on) => {
  const { data, clock } = fixture(on)
  const log = feedLog(on)
  const h = helpers($, data, clock)
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  // 同時在跑的工作桌 Agent 已達上限 3 個（都在別的專案）
  data.agents = [busy('desk-m0-0', '/home/u/other/one'), busy('desk-m0-1', '/home/u/other/two'), busy('desk-m0-2', '/home/u/other/three')]
  data.launch = async (e: any) => {
    const id = `e000000${data.launches.length}`
    data.agents = [...data.agents, { ...busy(e.argv[3], e.init.cwd, clock.now()), id, sessionId: `${id}-0000-4000-8000-000000000000` }]
    return result(0, id)
  }
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；空字串沒處理')
  data.files[`${ALPHA}/.task/REVIEW.md`] = '- [MEDIUM][邊界] b.ts:2 — 空字串沒處理'
  reviewJustFinished(data, ALPHA, 0)
  await h.refresh(); await h.step(); await h.step()

  // 修正排進隊伍：六段停在驗收「修正中」，沒有開 PR，也沒有審查通過
  expect(data.launches).toHaveLength(0)
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_A}` })
  const queued = await screen(ui)
  // 排隊是一般事件：寫進動態紀錄，不上畫面
  expect(log.has('Alpha 自動派修正第 1 輪排隊中（第 1 位）')).toBe(true)
  expect(queued).not.toContain(flat('Alpha 自動派修正第 1 輪排隊中（第 1 位）'))
  expect(queued).toContain(flat('規格● 實作● 測試● 驗收◉ 合併○ 上線○'))
  expect(queued).not.toContain('開PR')
  expect(await ui.find({ key: `case-${CARD_A}-open-pr` })).toBeFalsy()
  expect(data.toasts.some((t: string) => t.includes('審查通過'))).toBe(false)
  expect((data.store.chains as any)[ALPHA].passed).toBeUndefined()
  // 重新整理、名額還是滿的：照舊排著
  await h.refresh()
  expect(data.launches).toHaveLength(0)
  expect(await screen(ui)).toContain(flat('驗收◉ 合併○'))
  // 驗收段的說明（狀態列）：流程這輪要修 MEDIUM 時寫「…MEDIUM 1，修正中」，不算審查過了
  const base = buildCase({ name: 'Alpha', statusPath: CARD_A }, data.files[CARD_A]!, 1, {}, undefined)
  const verify = (data.store.verifies as any)[CARD_A]
  const atReview = { ...base, git: data.git[ALPHA], chain: { round: 1, mediumFix: 1 } }
  expect(stageLabel(pipeline(atReview as any, verify))).toBe('驗收・CRITICAL 0、HIGH 0、MEDIUM 1，修正中')
  expect(stageLabel(pipeline({ ...atReview, chain: { round: 1 } } as any, verify))).toBe('合併・可開 PR')

  // 一個做完：派出修正第 1／2 輪，不會被當成「Agent 仍在執行」丟掉
  data.agents = data.agents.map((a: any, i: number) => i === 0 ? { ...a, status: 'idle', state: 'done' } : a)
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(ALPHA)
  expect(h.prompt(0).startsWith('修正第 1／2 輪：')).toBe(true)
  expect(data.toasts.some((t: string) => t.includes('Agent 仍在執行'))).toBe(false)
  expect(data.toasts.some((t: string) => t.includes('審查通過'))).toBe(false)
  await ui.unmount()
})

/** AC-3 */
test('test_leftover_medium_goes_to_you_when_fix_rounds_are_used_up', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h3' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  launchOneAtATime(data, clock)
  // 已用掉 2 輪修正：第 2 輪的審查結束，CRITICAL／HIGH 為 0，還有一條影響行為的 MEDIUM，等你在問
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可', ASK)
  data.files[`${ALPHA}/.task/REVIEW.md`] = '- [MEDIUM][邊界] b.ts:2 — 空字串沒處理'
  reviewJustFinished(data, ALPHA, 2)
  await h.refresh(); await h.step(); await h.step()

  // 不派第 3 輪、流程不暫停：過關，MEDIUM 交給你
  expect(data.launches).toHaveLength(0)
  const run = (data.store.chains as any)[ALPHA]
  expect(run.round).toBe(2)
  expect(run.passed).toBe(true)
  expect(run.stopped).toBeUndefined()
  expect(data.toasts).toContain('Alpha：審查通過，可以開 PR')
  expect(data.toasts.some((t: string) => t.includes('流程已暫停'))).toBe(false)
  // 輪到你：按選項字母 → f 填入 → Enter 送出
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_A}` })
  expect(await screen(ui)).toContain(flat('按選項字母 → f 填入 → Enter 送出'))
  await ui.unmount()
})

/** AC-4 */
test('test_medium_waiting_for_your_decision_is_never_auto_fixed', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  launchOneAtATime(data, clock)
  const ask = '審查 MEDIUM 2 條（AC-2 無法驗證）怎麼處理：A) 不修，記錄原因 B) 修掉 C) 改規格'
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 2、LOW 0；要你決定', ask)
  data.files[`${ALPHA}/.task/REVIEW.md`] = [
    '- [MEDIUM][規格] — AC-2 無法驗證：「則」看不到（等你決定）',
    '- [MEDIUM][邊界] b.ts:2 — 上限沒擋（上一輪已列，等你決定）',
  ].join('\n')
  reviewJustFinished(data, ALPHA, 0)
  await h.refresh(); await h.step(); await h.step()

  // 不派修正、流程過關，等你那題留給你選
  expect(data.launches).toHaveLength(0)
  expect((data.store.chains as any)[ALPHA].passed).toBe(true)
  expect((data.store.chains as any)[ALPHA].round).toBe(0)
  expect(data.files[CARD_A]).toContain(`- 等你：${ask}`)

  // 流程派任何一輪審查修正時：要改規格才能修的 MEDIUM 不要改，標「（等你決定）」並在等你寫 A/B/C 那題，其他照修
  const c = buildCase({ name: 'A', statusPath: CARD_A }, data.files[CARD_A]!, 1, {}, undefined)
  for (const round of [1, 2]) {
    const p = buildPrompt(c, 'continue', '', { from: 'review', round })
    expect(p.startsWith(`修正第 ${round}／2 輪：`)).toBe(true)
    expect(p).toContain('要改規格才能修的 MEDIUM 不要改')
    expect(p).toContain('在審查檔那條結尾標「（等你決定）」')
    expect(p).toContain('審查 MEDIUM n 條（摘要）怎麼處理：A) 不修，記錄原因 B) 修掉 C) 改規格')
    expect(p).toContain('其他照修')
  }
})

/**
 * AC-5 (a)：卡片上的審查結論是對話自己寫的（工作桌沒派審查），審查檔有沒註記的 MEDIUM：不派修正，六段照舊到合併「可開 PR（自審）」。
 * (b) 依 D-07 改成接手，移到 test_medium_fix_is_taken_over_when_flow_belongs_to_another_conversation。
 */
test('test_no_medium_fix_is_sent_when_this_conversation_does_not_own_the_review', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  data.store.trustedVerify = { [CARD_C]: 'node test.mjs' }
  launchOneAtATime(data, clock)
  // (a) Gamma：審查結論是對話自己寫的（沒有流程紀錄），審查檔有沒註記的 MEDIUM
  data.git[GAMMA] = { branch: 'feature/gamma', head: 'g1' }
  data.files[CARD_C] = data.files[CARD_C]!.replace('- 驗證：無', '- 驗證：`node test.mjs`').replace('- 下一步：無', '- 下一步：開 PR')
  setCard(data, CARD_C, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  data.files[`${GAMMA}/.task/REVIEW.md`] = '- [MEDIUM][邊界] g.ts:2 — 空字串沒處理'

  await h.refresh(); await h.step(); await h.step()
  const ui = await $.ui.mount(PANE(160))
  await h.refresh()

  // (a) 這個對話不派任何修正，也不替它開流程
  expect(data.launches).toHaveLength(0)
  expect((data.store.chains as any)?.[GAMMA]).toBeUndefined()
  // (a) 六段照舊到合併「可開 PR（自審）」
  await ui.press({ key: `row-${CARD_C}` })
  const gamma = await screen(ui)
  expect(gamma).toContain(flat('規格● 實作● 測試● 驗收● 合併◆'))
  expect(gamma).toContain(flat('◆ 驗收  CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0（自審）'))
  expect(gamma).toContain(flat('按 ⇡ 開 PR 派 Agent push 並開 PR（驗收是自審，可按 w 派獨立驗收）'))
  expect(await ui.find({ key: `case-${CARD_C}-open-pr` })).toBeTruthy()
  await ui.unmount()
})

/**
 * AC-5 (b)（依 D-07）：流程是別的對話開的、沒停下、沒過關，剛做完的審查 CRITICAL／HIGH 0、審查檔有沒註記的 MEDIUM、修正輪數還有：
 * 這個對話接手流程（擁有者改成這個對話，輪數照算）並自動派修正一次，動態寫明是接手的；再重新整理不重派。
 * 別的對話的流程還有 HIGH 時照舊不接手，紀錄一字不變。
 */
test('test_medium_fix_is_taken_over_when_flow_belongs_to_another_conversation', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  let feed: any[] = []
  on('state.set', (_: any, e: any, next: any) => { if (e?.plugin === 'desk' && e?.key === 'feed') feed = e.value; return next(e) })
  data.agents = []
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs', [CARD_B]: 'npm test' }
  launchOneAtATime(data, clock)
  // Alpha：別的對話開的流程已用掉 1 輪，這輪審查剛結束，只剩一條沒註記的 MEDIUM
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；空字串沒處理')
  data.files[`${ALPHA}/.task/REVIEW.md`] = '- [MEDIUM][邊界] b.ts:2 — 空字串沒處理'
  reviewJustFinished(data, ALPHA, 1, { owner: 'other-session' })
  // Beta：別的對話開的流程，審查還有 HIGH：不在接手範圍
  data.git[BETA] = { branch: 'feature/beta', head: 'b1' }
  setCard(data, CARD_B, 'review：CRITICAL 0、HIGH 1、MEDIUM 1、LOW 0；漏稽核')
  data.files[`${BETA}/.task/REVIEW.md`] = '- [HIGH][稽核] a.ts:1 — 漏寫稽核紀錄\n- [MEDIUM][邊界] b.ts:2 — 空字串沒處理'
  reviewJustFinished(data, BETA, 0, { owner: 'other-session' })
  const betaChain = JSON.parse(JSON.stringify((data.store.chains as any)[BETA]))
  const betaJobs = JSON.parse(JSON.stringify((data.store.jobs as any)[BETA]))

  await h.refresh()

  // 接手：派一次修正（輪數照算：第 2／2 輪），接續實作那個 session，提示要修沒註記的 MEDIUM
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(ALPHA)
  expect(h.prompt(0).startsWith('修正第 2／2 輪：依 .task/REVIEW.md 修正所有')).toBe(true)
  expect(h.prompt(0)).toContain('沒標「不修」「等你決定」的 MEDIUM')
  expect(data.launches[0].argv[data.launches[0].argv.indexOf('--resume') + 1]).toBe(IMPL)
  // 流程紀錄寫進 store：擁有者改成這個對話，輪數 1 → 2，記著這輪要修的 MEDIUM
  const run = (data.store.chains as any)[ALPHA]
  expect(run.owner).toBe(ME)
  expect(run.round).toBe(2)
  expect(run.mediumFix).toBe(1)
  expect(run.stopped).toBeUndefined()
  expect(run.passed).toBeUndefined()
  expect((data.store.jobs as any)[ALPHA].last.owner).toBe(ME)
  expect((data.store.jobs as any)[ALPHA].last.round).toBe(2)
  // 動態寫明是接手別的對話開的流程
  expect(feed.some(e => e.card === CARD_A && String(e.text).includes('接手別的對話開的流程'))).toBe(true)
  // Beta 還有 HIGH：不接手、不派，紀錄一字不變
  expect((data.store.chains as any)[BETA]).toEqual(betaChain)
  expect((data.store.jobs as any)[BETA]).toEqual(betaJobs)

  // 再重新整理：同一個修正不重派
  await h.refresh(); await h.step()
  expect(data.launches).toHaveLength(1)
  expect(h.fixes()).toHaveLength(1)
  expect(feed.filter(e => e.card === CARD_A && String(e.text).includes('接手別的對話開的流程'))).toHaveLength(1)
})

import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, CARD_C, result, text, flat } from './fixture'
import { buildPrompt } from '../hooks/dispatch'
import { buildCase } from '../hooks/model'
import { decisionAnswerOf, picksMediumFix } from '../hooks/card'
import { MEDIUM_FIX_NOT_SENT } from '../hooks/chain'

// 修正輪收斂：自動流程只修 CRITICAL／HIGH；可能影響行為的 MEDIUM 由審查標「（等你決定）」寫進「等你」，不自動派修正。
const ALPHA = '/home/u/wt/alpha'
const BETA = '/home/u/wt/beta'
const GAMMA = '/home/u/wt/gamma'
const ME = 'fixture-session'
const IMPL = 'a0000001-0000-4000-8000-000000000000'
const ASK = '審查 MEDIUM 1 條（空字串沒處理）怎麼處理：A) 不修，記錄原因 B) 修掉 C) 改規格'
const AUTO = '工作桌會跟 CRITICAL／HIGH 一起自動派修正'
const ASK_RULE = '工作桌不會自動修：審查檔那條結尾標「（等你決定）」並在 等你 寫成「審查 MEDIUM n 條（摘要）怎麼處理：A) 不修，記錄原因 B) 修掉 C) 改規格」'
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

/** AC-1：CRITICAL／HIGH 為 0、只剩可能影響行為的 MEDIUM（審查檔有沒有註記都一樣）：不派修正、流程過關，等你那題留給你選 */
test('test_behavior_medium_alone_passes_and_asks_instead_of_auto_fix', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs', [CARD_B]: 'npm test' }
  launchOneAtATime(data, clock)
  // Alpha：第一次審查就只剩 MEDIUM；審查照提示在等你問了一題（漏標註記的那條也不會被自動修）
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 2、LOW 0；可', ASK)
  data.files[`${ALPHA}/.task/REVIEW.md`] = [
    '- [MEDIUM][邊界] b.ts:2 — 空字串沒處理（等你決定）',
    '- [MEDIUM][邊界] c.ts:5 — 上限沒擋',
  ].join('\n')
  reviewJustFinished(data, ALPHA, 0)
  // Beta：高風險卡的資安審查只剩一條 MEDIUM：一樣不派修正，過關但要你看
  data.git[BETA] = { branch: 'feature/beta', head: 'b1', files: ['app/Http/Middleware/Admin.php'] }
  setCard(data, CARD_B, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；輸入沒驗')
  data.files[`${BETA}/.task/REVIEW.md`] = '- [LOW][風格] x.php:1 — 縮排'
  data.files[`${BETA}/.task/SECURITY.md`] = '- [MEDIUM][輸入驗證] app/Http/Middleware/Admin.php:3 — 沒檢查長度'
  reviewJustFinished(data, BETA, 0, { security: true })
  await h.refresh(); await h.step(); await h.step()

  // 不派修正、流程不暫停：過關
  expect(data.launches).toHaveLength(0)
  expect(h.fixes()).toHaveLength(0)
  const alpha = (data.store.chains as any)[ALPHA]
  expect(alpha.passed).toBe(true)
  expect(alpha.round).toBe(0)
  expect(alpha.stopped).toBeUndefined()
  expect(alpha.mediumFix).toBeUndefined()
  expect(data.toasts).toContain('Alpha：驗收通過，可以開 PR')
  expect(data.toasts.some((t: string) => t.includes('流程已暫停'))).toBe(false)
  const beta = (data.store.chains as any)[BETA]
  expect(beta.passed).toBe(true)
  expect(beta.needsHuman).toContain('認證／中介層')
  // 卡片「等你」那題還在，輪到你：按選項字母 → f 填入 → Enter 送出
  expect(data.files[CARD_A]).toContain(`- 等你：${ASK}`)
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_A}` })
  expect(await screen(ui)).toContain(flat('按選項字母 → f 填入 → Enter 送出'))
  await ui.unmount()
})

/** AC-2：不分第幾輪（第一次、複審、輪數用完、通過後重新審查、資安審查），可能影響行為的 MEDIUM 一律標「（等你決定）」寫進等你，不說會自動派修正 */
test('test_review_prompt_always_asks_behavior_medium', () => {
  const c = buildCase({ name: 'A', statusPath: CARD_A }, '- 狀態：x\n- 檢查：`npm test`\n- 等你：無\n- 下一步：寫測試\n- 關卡：無', 1, {}, undefined)
  const review = (round: number, more: object = {}) => buildPrompt(c, 'review', '', undefined, { round, ...(round > 0 ? { base: 'abc123' } : {}), pitfalls: '', history: '', ...more })
  const prompts = [review(0), review(1), review(2), review(3), review(0, { base: 'abc123', recheck: true }), review(0, { security: true }), review(1, { security: true }), review(2, { security: true })]
  for (const p of prompts) {
    expect(p).toContain(ASK_RULE)
    expect(p).not.toContain(AUTO)
    expect(p).not.toContain('不加註記')
    expect(p).not.toContain('這次不會自動修')
    // 只關於紀錄、命名這類的照舊記錄、不修
    expect(p).toContain('記錄、不修')
    expect(p).toContain('都算進關卡的 MEDIUM 數')
  }
  // 複審：只確認 CRITICAL／HIGH 修好沒；等你決定的照原樣再列，過關時才問得到
  const again = review(1)
  expect(again).toContain('只判斷上一輪的 CRITICAL／HIGH 有沒有修好')
  expect(again).toContain('標「（等你決定）」的照原樣再列')
  // 重新審查（過關後又有新 commit）：等你還沒回答、或剛選了修掉的那條 MEDIUM 也照原樣再列，不會被整份覆寫清掉
  const recheck = review(0, { base: 'abc123', recheck: true })
  expect(recheck).toContain('標「（等你決定）」而沒被改到的照原樣再列（過關時要在 等你 問）')
  expect(recheck).not.toContain('沒被改到的 MEDIUM／LOW 不要再提')
})

/** AC-1：有 HIGH 也有 MEDIUM：自動修正只修 CRITICAL／HIGH，MEDIUM 不在這輪改；修完複審只剩 MEDIUM 就過關 */
test('test_high_with_medium_fixes_only_critical_and_high', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  launchOneAtATime(data, clock)
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 1、MEDIUM 2、LOW 1；漏稽核')
  data.files[`${ALPHA}/.task/REVIEW.md`] = [
    '- [HIGH][稽核] a.ts:1 — 漏寫稽核紀錄',
    '- [MEDIUM][邊界] b.ts:2 — 空字串沒處理（等你決定）',
    '- [MEDIUM][命名] c.ts:3 — 變數名不清（記錄、不修）',
    '- [LOW][風格] d.ts:4 — 縮排',
  ].join('\n')
  reviewJustFinished(data, ALPHA, 0)
  await h.refresh()

  // 派修正第 1／2 輪：只修 CRITICAL、HIGH，MEDIUM 交給你
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0).startsWith('修正第 1／2 輪：依 .task/REVIEW.md 修正所有 CRITICAL、HIGH（MEDIUM、LOW 不用修：MEDIUM 由你在卡片 等你 決定，不要改）')).toBe(true)
  expect(h.prompt(0)).not.toContain('沒標「不修」「等你決定」的 MEDIUM')
  const run = (data.store.chains as any)[ALPHA]
  expect(run.round).toBe(1)
  expect(run.fixTotal).toBe(1)
  expect(run.fixBranch).toBe('feature/alpha')
  expect(run.mediumFix).toBeUndefined()

  // 修完：自動檢查 → 複審；複審只剩等你決定的 MEDIUM，審查在等你問 → 過關，只用了 1 輪
  setCard(data, CARD_A, '無')
  data.git[ALPHA]!.head = 'h2'
  await h.finish(1)
  expect(data.launches).toHaveLength(2)
  expect(h.prompt(1).startsWith('程式碼審查')).toBe(true)
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可', ASK)
  data.files[`${ALPHA}/.task/REVIEW.md`] = '- [MEDIUM][邊界] b.ts:2 — 空字串沒處理（等你決定）'
  await h.finish()
  expect(data.launches).toHaveLength(2)
  expect(h.fixes()).toHaveLength(1)
  expect((data.store.chains as any)[ALPHA].passed).toBe(true)
  expect(data.files[CARD_A]).toContain(`- 等你：${ASK}`)
})

/** 審查 MEDIUM 第 3 條：自動派的修正提示只寫剛結束那份審查的審查檔（程式碼審查 → REVIEW.md、資安審查 → SECURITY.md），兩份檔都在也不混 */
test('test_auto_fix_prompt_names_only_the_review_file_that_just_finished_when_both_files_exist', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs', [CARD_B]: 'npm test' }
  launchOneAtATime(data, clock)
  // Alpha：程式碼審查剛結束，REVIEW.md 有 HIGH；上一次資安審查的 SECURITY.md 也還在
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；空字串沒處理')
  data.files[`${ALPHA}/.task/REVIEW.md`] = '- [HIGH][邊界] b.ts:2 — 空字串沒處理'
  data.files[`${ALPHA}/.task/SECURITY.md`] = '- [LOW][風格] a.ts:1 — 舊的資安審查'
  reviewJustFinished(data, ALPHA, 0)
  // Beta：資安審查剛結束，SECURITY.md 有 HIGH；程式碼審查的 REVIEW.md 已過關
  data.git[BETA] = { branch: 'feature/beta', head: 'b1', files: ['app/Http/Middleware/Admin.php'] }
  setCard(data, CARD_B, 'review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；輸入沒驗')
  data.files[`${BETA}/.task/REVIEW.md`] = '- [LOW][風格] x.php:1 — 縮排'
  data.files[`${BETA}/.task/SECURITY.md`] = '- [HIGH][輸入驗證] app/Http/Middleware/Admin.php:3 — 沒檢查長度'
  reviewJustFinished(data, BETA, 0, { security: true })

  await h.refresh()

  const sent = (root: string) => String(data.launches.find((l: any) => l.init.cwd === root)?.argv.at(-1) ?? '')
  expect(data.launches).toHaveLength(2)
  expect(sent(ALPHA)).toContain('修正第 1／2 輪：依 .task/REVIEW.md 修正所有')
  expect(sent(ALPHA)).not.toContain('.task/SECURITY.md')
  expect(sent(BETA)).toContain('修正第 1／2 輪：依 .task/SECURITY.md 修正所有')
  expect(sent(BETA)).not.toContain('.task/REVIEW.md')
})

/** 卡片上的審查結論是對話自己寫的（工作桌沒派審查），審查檔有沒註記的 MEDIUM：不派修正，六段照舊到合併「可開 PR（自審）」。 */
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
  expect(gamma).toContain(flat('● 規格 ● 實作 ● 測試 ● 驗收 ◆ 合併'))
  expect(gamma).toContain(flat('◆ 驗收  CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0（自審）'))
  expect(gamma).toContain(flat('按兩次 n 開 PR 派 Agent push 並開 PR（驗收是自審，可按 w 派獨立驗收）'))
  expect(await ui.find({ key: `case-${CARD_C}-open-pr` })).toBeTruthy()
  await ui.unmount()
})

/** 別的對話開的流程只剩 MEDIUM：MEDIUM 不再自動修，這個對話不接手、不派，紀錄一字不變 */
test('test_foreign_flow_with_only_medium_is_not_taken_over', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  launchOneAtATime(data, clock)
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；空字串沒處理')
  data.files[`${ALPHA}/.task/REVIEW.md`] = '- [MEDIUM][邊界] b.ts:2 — 空字串沒處理'
  reviewJustFinished(data, ALPHA, 1, { owner: 'other-session' })
  const before = JSON.parse(JSON.stringify((data.store.chains as any)[ALPHA]))
  const jobs = JSON.parse(JSON.stringify((data.store.jobs as any)[ALPHA]))

  await h.refresh(); await h.step()

  expect(data.launches).toHaveLength(0)
  expect((data.store.chains as any)[ALPHA]).toEqual(before)
  expect((data.store.jobs as any)[ALPHA]).toEqual(jobs)
})

/** AC-4（D-05／D-06）：在「等你」對審查 MEDIUM 題選 B) 修掉送出、對話清掉等你：工作桌自動派修正（上限用完也派）、累計數 +1，修完照常重新測試與驗收 */
test('test_answer_b_on_review_medium_dispatches_fix_and_counts', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  launchOneAtATime(data, clock)
  // 已自動修滿 2 輪後過關，審查在等你問一條 MEDIUM
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可', ASK)
  data.files[`${ALPHA}/.task/REVIEW.md`] = '- [MEDIUM][邊界] b.ts:2 — 空字串沒處理（等你決定）'
  data.store.chains = { [ALPHA]: { owner: ME, startedAt: 0, round: 0, fixTotal: 2, fixBranch: 'feature/alpha', passed: true, reviewHead: 'h1', reviewBranch: 'feature/alpha', judgedHead: 'h1', judgedBranch: 'feature/alpha' } }
  data.store.jobs = { [ALPHA]: { sessionId: IMPL, last: { launchName: 'desk-rv-0', nativeId: 'r0000001', sessionId: 'r0000001-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: ME, handled: true } } }
  await h.refresh()

  // 面板選 B、f 填入、送出：提示叫對話別自己修，流程紀錄記下送出時的 HEAD
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `case-${CARD_A}-opt0B` })
  await ui.press({ key: `case-${CARD_A}-fill` })
  expect(data.fills[0].text).toBe('「Alpha」決策：B')
  await $.prompt.submit({ text: data.fills[0].text } as any)
  await ui.unmount()
  expect((data.submitted.at(-1).context ?? []).join('\n')).toContain('審查 MEDIUM 那題選了 B) 修掉：不要自己修')
  expect((data.store.chains as any)[ALPHA].mediumFixAt).toBe('h1')
  // 對話還沒清掉等你：不派
  await h.refresh()
  expect(data.launches).toHaveLength(0)

  // 對話記了決策、清掉等你：派修正（上限已用完也派），累計數 2 → 3，紀錄拿掉
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0).startsWith('修正：你在卡片 等你 對審查 MEDIUM 選了 B) 修掉：依 .task/REVIEW.md 修正')).toBe(true)
  expect(data.launches[0].argv[data.launches[0].argv.indexOf('--resume') + 1]).toBe(IMPL)
  const run = (data.store.chains as any)[ALPHA]
  expect(run.fixTotal).toBe(3)
  expect(run.mediumFixAt).toBeUndefined()
  // 再重新整理不重派
  await h.refresh(); await h.step()
  expect(data.launches).toHaveLength(1)

  // 修完 commit：照常自動重新測試、派重新審查
  setCard(data, CARD_A, '無')
  data.git[ALPHA]!.head = 'h2'
  await h.finish(3)
  expect(data.processCalls.filter((c: any) => c.argv[0] === 'sh').length).toBe(1)
  expect(data.launches).toHaveLength(2)
  expect(h.prompt(1).startsWith('程式碼審查')).toBe(true)
  expect((data.store.chains as any)[ALPHA].fixTotal).toBe(3)
})

/** 選 A（不修）或別題選 B 都不派；多題時照題號認 */
test('test_only_fix_on_review_medium_counts_as_answer_b', () => {
  expect(picksMediumFix(ASK, 'B')).toBe(true)
  expect(picksMediumFix(ASK, 'A')).toBe(false)
  expect(picksMediumFix(ASK, 'C')).toBe(false)
  const two = `要 push 嗎？A) 要 B) 等；${ASK}`
  expect(picksMediumFix(two, '1B 2A')).toBe(false)
  expect(picksMediumFix(two, '1A 2B')).toBe(true)
  expect(picksMediumFix('要 push 嗎？A) 要 B) 修掉', 'B')).toBe(false)
  expect(decisionAnswerOf('先看一下\n「Alpha」決策：1A 2B\n「Beta」決策：A', 'Alpha')).toBe('1A 2B')
  expect(decisionAnswerOf('「Beta」決策：A', 'Alpha')).toBe('')
})

/** 回答 B 的測試共用：Alpha 已過關、審查在等你問一條 MEDIUM；chain 給 undefined 就是沒有流程紀錄。 */
function passedWithMediumAsk(data: any, chain: object | undefined) {
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可', ASK)
  data.files[`${ALPHA}/.task/REVIEW.md`] = '- [MEDIUM][邊界] b.ts:2 — 空字串沒處理（等你決定）'
  if (chain) data.store.chains = { [ALPHA]: { startedAt: 0, round: 0, passed: true, reviewHead: 'h1', reviewBranch: 'feature/alpha', judgedHead: 'h1', judgedBranch: 'feature/alpha', ...chain } }
  data.store.jobs = { [ALPHA]: { sessionId: IMPL, last: { launchName: 'desk-rv-0', nativeId: 'r0000001', sessionId: 'r0000001-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: (chain as any)?.owner ?? ME, handled: true } } }
}

/** 面板選 B、f 填入、送出；回傳送給對話的附加說明。 */
async function answerB($: any, data: any) {
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `case-${CARD_A}-opt0B` })
  await ui.press({ key: `case-${CARD_A}-fill` })
  await $.prompt.submit({ text: data.fills.at(-1).text } as any)
  await ui.unmount()
  return (data.submitted.at(-1).context ?? []).join('\n')
}

/** AC-4：流程是別的對話開的（開流程的對話可能已經不在）：回答 B 時這個對話接手流程，等你清掉後照樣派修正 */
test('test_answer_b_dispatches_fix_when_flow_belongs_to_another_conversation', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  launchOneAtATime(data, clock)
  passedWithMediumAsk(data, { owner: 'other-session' })
  await h.refresh()

  expect(await answerB($, data)).toContain('不要自己修')
  const run = (data.store.chains as any)[ALPHA]
  expect(run.owner).toBe(ME)
  expect(run.mediumFixAt).toBe('h1')

  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0).startsWith('修正：你在卡片 等你 對審查 MEDIUM 選了 B) 修掉')).toBe(true)
  expect((data.store.chains as any)[ALPHA].fixTotal).toBe(1)
})

/** 沒有流程紀錄（不是工作桌派的審查）：工作桌派不了修正，決策提示不叫對話別修、什麼都不記，清掉等你也不派 */
test('test_answer_b_without_flow_record_leaves_fix_to_conversation', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  launchOneAtATime(data, clock)
  passedWithMediumAsk(data, undefined)
  await h.refresh()

  const context = await answerB($, data)
  expect(context).toContain('卡片「等你」的決策')
  expect(context).not.toContain('不要自己修')
  expect((data.store.chains as any)?.[ALPHA]).toBeUndefined()
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await h.refresh(); await h.step()
  expect(data.launches).toHaveLength(0)
})

/** 回答 B 是你主動要的：名額滿排進隊伍、輪到時 5 小時額度已低於門檻，照樣派出（不像自動項目被丟掉） */
test('test_answer_b_fix_queued_is_sent_even_when_quota_drops', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.files['/home/u/.claude/handoffs/dispatch.json'] = JSON.stringify({ maxAgents: 1 })
  data.agents = [busy('desk-m0-0', '/home/u/other/one')]
  data.launch = async (e: any) => {
    const id = `e000000${data.launches.length}`
    data.agents = [...data.agents, { ...busy(e.argv[3], e.init.cwd, clock.now()), id, sessionId: `${id}-0000-4000-8000-000000000000` }]
    return result(0, id)
  }
  passedWithMediumAsk(data, { owner: ME })
  await h.refresh()
  await answerB($, data)
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await h.refresh()
  // 名額滿：排進隊伍，紀錄拿掉（不會重複排）
  expect(data.launches).toHaveLength(0)
  expect((data.store.chains as any)[ALPHA].mediumFixAt).toBeUndefined()

  // 排隊期間額度跌到 20%，另一個 Agent 做完：照樣派出
  const resetsAt = new Date(clock.now() + 2 * 3_600_000).toISOString()
  data.usage = { ...data.usage, rateLimits: [{ kind: 'five_hour', percentUsed: 80, resetsAt }] }
  data.agents = data.agents.map((a: any) => ({ ...a, status: 'idle', state: 'done' }))
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(data.launches[0].init.cwd).toBe(ALPHA)
  expect(h.prompt(0).startsWith('修正：你在卡片 等你 對審查 MEDIUM 選了 B) 修掉')).toBe(true)
  expect((data.store.chains as any)[ALPHA].fixTotal).toBe(1)
  expect((data.store.chains as any)[ALPHA].stopped).toBeUndefined()
})

/** 回答 B 的修正自動只試一次：啟動一直失敗時不會每次重新整理都重派；流程停下寫明按 g 重派，按 g 派的就是那幾條 MEDIUM 的修正並算一輪 */
test('test_answer_b_fix_tries_once_when_launch_fails_then_g_restarts_it', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  data.launch = async () => result(1, '', 'claude: boom')
  passedWithMediumAsk(data, { owner: ME })
  await h.refresh()
  await answerB($, data)
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await h.refresh()
  for (let i = 0; i < 5; i++) { await h.refresh(); await h.step() }

  // 只試了一次；流程停下、紀錄拿掉，輪到你寫按 g 重派
  expect(data.launches).toHaveLength(1)
  const run = (data.store.chains as any)[ALPHA]
  expect(run.stopped).toBe(MEDIUM_FIX_NOT_SENT)
  expect(run.mediumFixAt).toBeUndefined()
  expect(run.fixTotal ?? 0).toBe(0)
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_A}` })
  expect(await screen(ui)).toContain(flat(MEDIUM_FIX_NOT_SENT))
  await ui.unmount()

  // 啟動恢復正常後按 g：派出那幾條 MEDIUM 的修正，算一輪
  launchOneAtATime(data, clock)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(2)
  expect(h.prompt(1).startsWith('修正：你在卡片 等你 對審查 MEDIUM 選了 B) 修掉')).toBe(true)
  expect((data.store.chains as any)[ALPHA].fixTotal).toBe(1)
  expect((data.store.chains as any)[ALPHA].stopped).toBeUndefined()
})

/** 已啟動、只是 agents 清單晚列出：不重派第二個 Agent，流程也不停下 */
test('test_answer_b_fix_is_not_sent_twice_when_agent_list_lags', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  let started: any = null
  // 啟動成功，但清單要等一下才列出這個 Agent
  data.launch = async (e: any) => { started = { ...busy(e.argv[3], e.init.cwd, clock.now()), id: 'f0000001', sessionId: 'f0000001-0000-4000-8000-000000000000' }; return result(0, 'f0000001') }
  passedWithMediumAsk(data, { owner: ME })
  await h.refresh()
  await answerB($, data)
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await h.refresh()
  for (let i = 0; i < 3; i++) { await h.refresh(); await h.step() }
  expect(data.launches).toHaveLength(1)
  expect((data.store.chains as any)[ALPHA].stopped).toBeUndefined()
  expect((data.store.chains as any)[ALPHA].mediumFixAt).toBeUndefined()

  // 清單列出來了：照樣只有那一個
  data.agents = [started]
  for (let i = 0; i < 2; i++) { await h.refresh(); await h.step() }
  expect(data.launches).toHaveLength(1)
})

/** 高風險卡的資安審查問的 MEDIUM 選 B：派出的修正只寫 SECURITY.md；沒派出停下後按 g 重派也照它 */
test('test_answer_b_on_security_review_medium_names_security_file', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  data.launch = async () => result(1, '', 'claude: boom')
  passedWithMediumAsk(data, { owner: ME })
  data.files[`${ALPHA}/.task/SECURITY.md`] = '- [MEDIUM][輸入] c.ts:3 — 路徑沒正規化（等你決定）'
  // 這件最後一次派工是資安審查（高風險卡：程式碼審查過關後派的）
  const jobs = data.store.jobs as any
  data.store.jobs = { ...jobs, [ALPHA]: { ...jobs[ALPHA], last: { ...jobs[ALPHA].last, security: true } } }
  await h.refresh()
  await answerB($, data)
  expect((data.store.chains as any)[ALPHA].mediumFixSecurity).toBe(true)
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await h.refresh()

  // 自動試的那次：指到 SECURITY.md，不提 REVIEW.md
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0).startsWith('修正：你在卡片 等你 對審查 MEDIUM 選了 B) 修掉：依 .task/SECURITY.md 修正')).toBe(true)
  expect(h.prompt(0)).not.toContain('REVIEW.md')
  expect((data.store.chains as any)[ALPHA].stopped).toBe(MEDIUM_FIX_NOT_SENT)

  // 沒派出、按 g 重派：照樣指到 SECURITY.md
  await h.refresh(); await h.step()
  launchOneAtATime(data, clock)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(2)
  expect(h.prompt(1).startsWith('修正：你在卡片 等你 對審查 MEDIUM 選了 B) 修掉：依 .task/SECURITY.md 修正')).toBe(true)
})

/** 程式碼審查問的 MEDIUM 選 B：上一次選修掉的是資安審查也不沿用，指到 REVIEW.md */
test('test_answer_b_on_code_review_medium_clears_old_security_mark', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  launchOneAtATime(data, clock)
  passedWithMediumAsk(data, { owner: ME, mediumFixSecurity: true })
  await h.refresh()
  await answerB($, data)
  expect((data.store.chains as any)[ALPHA].mediumFixSecurity).toBeUndefined()
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0).startsWith('修正：你在卡片 等你 對審查 MEDIUM 選了 B) 修掉：依 .task/REVIEW.md 修正')).toBe(true)
})

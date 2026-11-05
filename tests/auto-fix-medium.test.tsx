import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_A, CARD_B, CARD_C, result, text, flat } from './fixture'
import { buildPrompt } from '../hooks/dispatch'
import { buildCase } from '../hooks/model'

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

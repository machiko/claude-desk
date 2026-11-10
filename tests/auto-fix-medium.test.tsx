import { expect, test } from 'claude-code/testing'
import { fixture, PANE, PROJECT_DIR, CARD_A, CARD_B, CARD_C, result, text, flat } from './fixture'
import { screen, busyAgent as busy } from './world'
import { buildPrompt } from '../hooks/dispatch'
import { buildCase } from '../hooks/model'
import { decisionAnswerOf, picksMediumFix, picksMediumFollowUp } from '../hooks/card'
import { MEDIUM_FIX_NOT_SENT } from '../hooks/chain'

// 修正輪收斂：自動流程只修 CRITICAL／HIGH；MEDIUM 一律由審查標「（記錄、不修）」，不自動派修正、也不在「等你」問。
// 舊卡「等你」裡已有的 MEDIUM 題（A～D）照舊能答：選 C 自動派修正、B 開疊放的後續卡（下面 test_answer_b_* 等）。
const ALPHA = '/home/u/wt/alpha'
const BETA = '/home/u/wt/beta'
const GAMMA = '/home/u/wt/gamma'
const ME = 'fixture-session'
const IMPL = 'a0000001-0000-4000-8000-000000000000'
const ASK = '審查 MEDIUM 1 條（空字串沒處理）怎麼處理：A) 不修，記錄原因 B) 另開卡修（推薦，這張先過關） C) 修掉（在這張卡修，多一輪修正） D) 改規格'
const AUTO = '工作桌會跟 CRITICAL／HIGH 一起自動派修正'
/** 審查提示的 MEDIUM 規則：可能影響行為的也只記錄、不問。 */
const RECORD_RULE = 'MEDIUM 一律記錄、不問：只關於規格紀錄、文件、命名、重複、註解、可維護性的，跟可能影響行為的（拿不準的、驗收情境無法驗證的、要改規格才能修的也一樣），都在審查檔那條結尾標「（記錄、不修）」、不寫進卡片 等你'

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

/**
 * 驗收 MEDIUM 記錄後繼續 AC-2：審查結論 CRITICAL 0、HIGH 0、MEDIUM 2（可能影響行為的也照新規則標記錄、不修，等你 無）：
 * 不派修正、流程過關，卡片不在等你；輪到你直接是開 PR。設了 autoPr 時過關就自動派推送 Agent 開 PR。
 */
test('test_behavior_medium_alone_passes_without_asking', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs', [CARD_B]: 'npm test' }
  launchOneAtATime(data, clock)
  // Alpha：第一次審查只剩 MEDIUM，審查照新規則全部記錄、不修，等你留 無
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 2、LOW 0；可')
  data.files[`${ALPHA}/.task/REVIEW.md`] = [
    '- [MEDIUM][邊界] b.ts:2 — 空字串沒處理（記錄、不修）',
    '- [MEDIUM][規格] — AC-2 無法驗證：沒寫上限（記錄、不修）',
  ].join('\n')
  reviewJustFinished(data, ALPHA, 0)
  await h.refresh(); await h.step(); await h.step()

  // 不派修正、流程不暫停：過關，提醒開 PR
  expect(data.launches).toHaveLength(0)
  const alpha = (data.store.chains as any)[ALPHA]
  expect(alpha.passed).toBe(true)
  expect(alpha.round).toBe(0)
  expect(alpha.stopped).toBeUndefined()
  expect(data.toasts).toContain('Alpha：驗收通過，可以開 PR')
  expect(data.toasts.some((t: string) => t.includes('流程已暫停'))).toBe(false)
  // 卡片不在等你：輪到你是開 PR，不是填入決策
  expect(data.files[CARD_A]).toContain('- 等你：無')
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_A}` })
  const shown = await screen(ui)
  expect(shown).toContain(flat('n 開 PR（按兩次，派 Agent push 並開 PR）'))
  expect(shown).not.toContain(flat('f 填入決策'))
  await ui.unmount()

  // Beta：專案設了 autoPr，審查只剩記錄的 MEDIUM（含可能影響行為的）→ 過關就自動派推送 Agent 開 PR，不停下來問
  data.files[`${PROJECT_DIR}/dispatch.json`] = JSON.stringify({ autoPr: true })
  data.git[BETA] = { branch: 'feature/beta', head: 'b1', remote: 'git@github.com:acme/shop.git', upstream: false }
  data.gh = []
  setCard(data, CARD_B, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  data.files[`${BETA}/.task/REVIEW.md`] = '- [MEDIUM][邊界] x.php:3 — 沒檢查長度（記錄、不修）'
  reviewJustFinished(data, BETA, 0)
  await h.refresh(); await h.step()
  const beta = (data.store.chains as any)[BETA]
  expect(beta.passed).toBe(true)
  expect(beta.stopped).toBeUndefined()
  expect(data.files[CARD_B]).toContain('- 等你：無')
  const published = data.launches.filter((l: any) => l.init.cwd === BETA)
  expect(published).toHaveLength(1)
  expect(String(published[0].argv.at(-1)).startsWith('推送：push feature/beta 並')).toBe(true)
  // 記錄的 MEDIUM 列進 PR 說明（AC-3）
  expect(String(published[0].argv.at(-1))).toContain('有 .task/SECURITY.md 也讀，把裡面的 MEDIUM 逐條列在「驗收記錄的 MEDIUM」段')
  expect(h.fixes()).toHaveLength(0)
})

/**
 * 驗收 MEDIUM 記錄後繼續 AC-1：不分第幾輪（第一次、複審、輪數用完、通過後重新審查、資安審查），可能影響行為的 MEDIUM（含 AC 無法驗證的）
 * 一律標「（記錄、不修）」、記歷程、不寫進等你；提示裡不再有 A～D 的題目，也不再要求新標「（等你決定）」。
 */
test('test_review_prompt_records_behavior_medium_without_asking', () => {
  const c = buildCase({ name: 'A', statusPath: CARD_A }, '- 狀態：x\n- 檢查：`npm test`\n- 等你：無\n- 下一步：寫測試\n- 關卡：無', 1, {}, undefined)
  const review = (round: number, more: object = {}) => buildPrompt(c, 'review', '', undefined, { round, ...(round > 0 ? { base: 'abc123' } : {}), pitfalls: '', ...more })
  const prompts = [review(0), review(1), review(2), review(3), review(0, { base: 'abc123', recheck: true }), review(0, { security: true }), review(1, { security: true }), review(2, { security: true })]
  for (const p of prompts) {
    expect(p).toContain(RECORD_RULE)
    expect(p).toContain('在卡片歷程記一筆「審查：MEDIUM n 條記錄不修 → 見審查檔」')
    expect(p).toContain('流程照常往開 PR 走')
    expect(p).toContain('都算進關卡的 MEDIUM 數')
    // 舊規則的題目與新標法都不再出現
    expect(p).not.toContain('A) 不修，記錄原因')
    expect(p).not.toContain('D) 改規格')
    expect(p).not.toContain('標「（等你決定）」並')
    expect(p).not.toContain('過關時要在 等你 問')
    expect(p).not.toContain('過關那次再問')
    expect(p).not.toContain(AUTO)
  }
  // 複審：只確認 CRITICAL／HIGH 修好沒；舊卡已標「（等你決定）」的照原樣再列，但不新增
  const again = review(1)
  expect(again).toContain('只判斷上一輪的 CRITICAL／HIGH 有沒有修好')
  expect(again).toContain('上一份已有標「（等你決定）」的（這條規則之前的舊卡）照原樣再列；不新增這種標法，也不在 等你 新增題目。')
  // 重新審查：舊卡已回答的改標不修，不在等你新增題目
  const recheck = review(0, { base: 'abc123', recheck: true })
  expect(recheck).toContain('卡片 Decisions 已記你對那條選了不修、另開卡修或改規格的，改標「（不修，見 Decisions）」')
  expect(recheck).toContain('不新增這種標法，也不在 等你 新增題目。')
  // 資安審查接在程式碼審查之後：等你已有的題目照原樣保留
  const keep = '卡片 等你 已有的題目（例如舊卡程式碼審查問的 MEDIUM 題）照原樣保留'
  expect(review(0, { security: true })).toContain(keep)
  expect(review(0)).not.toContain(keep)
})

/** AC-1：有 HIGH 也有 MEDIUM：自動修正只修 CRITICAL／HIGH，MEDIUM 不在這輪改（修完之後怎麼走見下一支） */
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

  // 派修正第 1／2 輪：只修 CRITICAL、HIGH，MEDIUM 只記錄
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0).startsWith('修正第 1／2 輪：依 .task/REVIEW.md 修正所有 CRITICAL、HIGH（MEDIUM、LOW 不用修：MEDIUM 只記錄、不要改，也不寫進 等你）')).toBe(true)
  expect(h.prompt(0)).not.toContain('沒標「不修」「等你決定」的 MEDIUM')
  const run = (data.store.chains as any)[ALPHA]
  expect(run.round).toBe(1)
  expect(run.fixTotal).toBe(1)
  expect(run.fixBranch).toBe('feature/alpha')
  expect(run.mediumFix).toBeUndefined()
})

/**
 * MEDIUM 收尾 AC-1：舊卡的審查檔有 HIGH 1 條、又有一條 MEDIUM 標「（等你決定）」：審查結束就記為這條分支審查過；
 * 修完 commit 只重新跑測試、不派複審；那條 MEDIUM 留在審查檔，開 PR 時跟其他 MEDIUM 一起列進 PR 說明。
 */
test('test_old_card_your_decision_medium_with_high_reruns_tests_only_after_fix', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  data.files[`${PROJECT_DIR}/dispatch.json`] = JSON.stringify({ autoPr: true })
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1', remote: 'git@github.com:acme/shop.git', upstream: false }
  data.gh = []
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  launchOneAtATime(data, clock)
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 1、MEDIUM 2、LOW 0；漏稽核')
  const review = [
    '- [HIGH][稽核] a.ts:1 — 漏寫稽核紀錄',
    '- [MEDIUM][邊界] b.ts:2 — 空字串沒處理（等你決定）',
    '- [MEDIUM][命名] c.ts:3 — 變數名不清（記錄、不修）',
  ].join('\n')
  data.files[`${ALPHA}/.task/REVIEW.md`] = review
  reviewJustFinished(data, ALPHA, 0)
  await h.refresh()

  // 派修正第 1／2 輪，同時記下這條分支審查過（不再因為等你決定的 MEDIUM 留著複審）
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0).startsWith('修正第 1／2 輪：')).toBe(true)
  expect((data.store.chains as any)[ALPHA].reviewedBranch).toBe('feature/alpha')

  // 修正 Agent 照提示寫回關卡、commit；完成檢查通過 → 不派複審，流程過關
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 2、LOW 0；已依審查修正、未複審（發版時整版審查）')
  data.git[ALPHA]!.head = 'h2'
  await h.finish(1)
  expect(data.launches.filter((l: any) => String(l.argv.at(-1)).startsWith('程式碼審查'))).toHaveLength(0)
  const run = (data.store.chains as any)[ALPHA]
  expect(run.passed).toBe(true)
  expect(run.unreviewed).toBe(true)
  expect(run.stopped).toBeUndefined()
  expect(data.files[CARD_A]).toContain('- 等你：無')
  // 那條 MEDIUM 留在審查檔，沒人把它清掉
  expect(data.files[`${ALPHA}/.task/REVIEW.md`]).toContain('空字串沒處理（等你決定）')

  // 過關後自動派推送 Agent 開 PR：審查檔的 MEDIUM（含等你決定的那條）列進 PR 說明
  await h.step()
  const published = data.launches.filter((l: any) => String(l.argv.at(-1)).startsWith('推送：push feature/alpha 並'))
  expect(published).toHaveLength(1)
  expect(String(published[0].argv.at(-1))).toContain('另讀 .task/REVIEW.md，有 .task/SECURITY.md 也讀，把裡面的 MEDIUM 逐條列在「驗收記錄的 MEDIUM」段')
  expect(h.fixes()).toHaveLength(1)
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
  expect(gamma).toContain(flat('n 開 PR（按兩次，派 Agent push 並開 PR，驗收是自審，可按 w 派獨立驗收）'))
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

/** AC-4（D-05／D-06）：在「等你」對審查 MEDIUM 題選 C) 修掉送出、對話清掉等你：工作桌自動派修正（上限用完也派）、累計數 +1，修完照常重新測試與驗收 */
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

  // 面板選 C、f 填入、送出：提示叫對話別自己修，流程紀錄記下送出時的 HEAD
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `case-${CARD_A}-opt0C` })
  await ui.press({ key: `case-${CARD_A}-fill` })
  expect(data.fills[0].text).toBe('「Alpha」決策：C')
  await $.prompt.submit({ text: data.fills[0].text } as any)
  await ui.unmount()
  expect((data.submitted.at(-1).context ?? []).join('\n')).toContain('審查 MEDIUM 那題選了 C) 修掉：不要自己修')
  expect((data.store.chains as any)[ALPHA].mediumFixAt).toBe('h1')
  // 對話還沒清掉等你：不派
  await h.refresh()
  expect(data.launches).toHaveLength(0)

  // 對話記了決策、清掉等你：派修正（上限已用完也派），累計數 2 → 3，紀錄拿掉
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0).startsWith('修正：你在卡片 等你 對審查 MEDIUM 選了 C) 修掉：依 .task/REVIEW.md 修正')).toBe(true)
  expect(data.launches[0].argv[data.launches[0].argv.indexOf('--resume') + 1]).toBe(IMPL)
  const run = (data.store.chains as any)[ALPHA]
  expect(run.fixTotal).toBe(3)
  expect(run.mediumFixAt).toBeUndefined()
  // 派出你選修掉的 MEDIUM：記著，修完過關時面板寫「已修正」
  expect(run.mediumFixed).toBe(true)
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

/** 選 A（不修）、B（另開卡修）或別題選 C 都不派；多題時照題號認；照選項文字認，舊卡上「B) 修掉」的題目選 B 照樣算修掉 */
test('test_only_fix_on_review_medium_counts_as_answer_b', () => {
  expect(picksMediumFix(ASK, 'C')).toBe(true)
  expect(picksMediumFix(ASK, 'A')).toBe(false)
  expect(picksMediumFix(ASK, 'B')).toBe(false)
  expect(picksMediumFix(ASK, 'D')).toBe(false)
  const two = `要 push 嗎？A) 要 B) 等；${ASK}`
  expect(picksMediumFix(two, '1C 2A')).toBe(false)
  expect(picksMediumFix(two, '1A 2C')).toBe(true)
  expect(picksMediumFix(two, '1A 2B')).toBe(false)
  expect(picksMediumFix('要 push 嗎？A) 要 B) 修掉', 'B')).toBe(false)
  expect(picksMediumFix('審查 MEDIUM 1 條（空字串沒處理）怎麼處理：A) 不修，記錄原因 B) 修掉 C) 改規格', 'B')).toBe(true)
  expect(decisionAnswerOf('先看一下\n「Alpha」決策：1A 2B\n「Beta」決策：A', 'Alpha')).toBe('1A 2B')
  expect(decisionAnswerOf('「Beta」決策：A', 'Alpha')).toBe('')
})

/** 回答 C 的測試共用：Alpha 已過關、審查在等你問一條 MEDIUM；chain 給 undefined 就是沒有流程紀錄。 */
function passedWithMediumAsk(data: any, chain: object | undefined) {
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1' }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可', ASK)
  data.files[`${ALPHA}/.task/REVIEW.md`] = '- [MEDIUM][邊界] b.ts:2 — 空字串沒處理（等你決定）'
  if (chain) data.store.chains = { [ALPHA]: { startedAt: 0, round: 0, passed: true, reviewHead: 'h1', reviewBranch: 'feature/alpha', judgedHead: 'h1', judgedBranch: 'feature/alpha', ...chain } }
  data.store.jobs = { [ALPHA]: { sessionId: IMPL, last: { launchName: 'desk-rv-0', nativeId: 'r0000001', sessionId: 'r0000001-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: (chain as any)?.owner ?? ME, handled: true } } }
}

/** 面板選 C、f 填入、送出；回傳送給對話的附加說明。 */
async function answerFix($: any, data: any) {
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `case-${CARD_A}-opt0C` })
  await ui.press({ key: `case-${CARD_A}-fill` })
  await $.prompt.submit({ text: data.fills.at(-1).text } as any)
  await ui.unmount()
  return (data.submitted.at(-1).context ?? []).join('\n')
}

/** AC-4：流程是別的對話開的（開流程的對話可能已經不在）：回答 C 時這個對話接手流程，等你清掉後照樣派修正 */
test('test_answer_b_dispatches_fix_when_flow_belongs_to_another_conversation', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  launchOneAtATime(data, clock)
  passedWithMediumAsk(data, { owner: 'other-session' })
  await h.refresh()

  expect(await answerFix($, data)).toContain('不要自己修')
  const run = (data.store.chains as any)[ALPHA]
  expect(run.owner).toBe(ME)
  expect(run.mediumFixAt).toBe('h1')

  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0).startsWith('修正：你在卡片 等你 對審查 MEDIUM 選了 C) 修掉')).toBe(true)
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

  const context = await answerFix($, data)
  expect(context).toContain('卡片「等你」的決策')
  expect(context).not.toContain('不要自己修')
  expect((data.store.chains as any)?.[ALPHA]).toBeUndefined()
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await h.refresh(); await h.step()
  expect(data.launches).toHaveLength(0)
})

/** 回答 C 是你主動要的：名額滿排進隊伍、輪到時 5 小時額度已低於門檻，照樣派出（不像自動項目被丟掉） */
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
  await answerFix($, data)
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
  expect(h.prompt(0).startsWith('修正：你在卡片 等你 對審查 MEDIUM 選了 C) 修掉')).toBe(true)
  expect((data.store.chains as any)[ALPHA].fixTotal).toBe(1)
  expect((data.store.chains as any)[ALPHA].stopped).toBeUndefined()
})

/** 回答 C 的修正自動只試一次：啟動一直失敗時不會每次重新整理都重派；流程停下寫明按 g 重派，按 g 派的就是那幾條 MEDIUM 的修正並算一輪 */
test('test_answer_b_fix_tries_once_when_launch_fails_then_g_restarts_it', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  data.launch = async () => result(1, '', 'claude: boom')
  passedWithMediumAsk(data, { owner: ME })
  await h.refresh()
  await answerFix($, data)
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
  expect(h.prompt(1).startsWith('修正：你在卡片 等你 對審查 MEDIUM 選了 C) 修掉')).toBe(true)
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
  await answerFix($, data)
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

/** 高風險卡（流程跑過資安審查）的 MEDIUM 選 C：兩份都有標等你決定的，派出的修正 REVIEW.md 與 SECURITY.md 都寫；沒派出停下後按 g 重派也一樣 */
test('test_answer_b_after_security_review_names_both_review_files', async ($, on) => {
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
  await answerFix($, data)
  expect((data.store.chains as any)[ALPHA].mediumFixSecurity).toBe(true)
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await h.refresh()

  // 自動試的那次：兩份都寫，哪一份的（等你決定）都不漏
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0).startsWith('修正：你在卡片 等你 對審查 MEDIUM 選了 C) 修掉：依 .task/REVIEW.md 與 .task/SECURITY.md 修正')).toBe(true)
  expect((data.store.chains as any)[ALPHA].stopped).toBe(MEDIUM_FIX_NOT_SENT)

  // 沒派出、按 g 重派：照樣兩份都寫
  await h.refresh(); await h.step()
  launchOneAtATime(data, clock)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  expect(data.launches).toHaveLength(2)
  expect(h.prompt(1).startsWith('修正：你在卡片 等你 對審查 MEDIUM 選了 C) 修掉：依 .task/REVIEW.md 與 .task/SECURITY.md 修正')).toBe(true)
})

/** 高風險卡上程式碼審查問的 MEDIUM 選 C：資安審查無發現、但最後一次派工是它，修正照樣指到 REVIEW.md（不只寫 SECURITY.md） */
test('test_answer_b_on_code_review_medium_in_high_risk_card_names_review_file', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  launchOneAtATime(data, clock)
  passedWithMediumAsk(data, { owner: ME })
  data.files[`${ALPHA}/.task/SECURITY.md`] = '無發現'
  const jobs = data.store.jobs as any
  data.store.jobs = { ...jobs, [ALPHA]: { ...jobs[ALPHA], last: { ...jobs[ALPHA].last, security: true } } }
  await h.refresh()
  await answerFix($, data)
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0)).toContain('依 .task/REVIEW.md 與 .task/SECURITY.md 修正標「（等你決定）」')
})

/** 程式碼審查問的 MEDIUM 選 C：上一次選修掉的是資安審查也不沿用，指到 REVIEW.md */
test('test_answer_b_on_code_review_medium_clears_old_security_mark', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  launchOneAtATime(data, clock)
  passedWithMediumAsk(data, { owner: ME, mediumFixSecurity: true })
  await h.refresh()
  await answerFix($, data)
  expect((data.store.chains as any)[ALPHA].mediumFixSecurity).toBeUndefined()
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0).startsWith('修正：你在卡片 等你 對審查 MEDIUM 選了 C) 修掉：依 .task/REVIEW.md 修正')).toBe(true)
})

/** 高風險卡：程式碼審查只剩 MEDIUM、在等你問，流程自動派資安審查；資安審查跑的時候你選 C 送出、對話清掉等你。共用到「資安審查做完」之前。 */
async function answerBDuringSecurityReview($: any, data: any, clock: any) {
  const h = helpers($, data, clock)
  data.agents = []
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1', files: ['app/Http/Middleware/Admin.php'] }
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  launchOneAtATime(data, clock)
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可', ASK)
  data.files[`${ALPHA}/.task/REVIEW.md`] = '- [MEDIUM][邊界] b.ts:2 — 空字串沒處理（等你決定）'
  reviewJustFinished(data, ALPHA, 0)
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0).startsWith('資安審查')).toBe(true)
  await h.refresh()
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_A}` })
  await ui.press({ key: `case-${CARD_A}-opt0C` })
  await ui.press({ key: `case-${CARD_A}-fill` })
  await $.prompt.submit({ text: data.fills.at(-1).text } as any)
  await ui.unmount()
  expect((data.store.chains as any)[ALPHA].mediumFixAt).toBe('h1')
  return h
}

/** 資安審查跑時回答 C：資安審查做完先照常處理（有 HIGH 就派依 SECURITY.md 的修正），不先派 MEDIUM 修正把那次結論蓋掉 */
test('test_answer_b_during_security_review_lets_security_result_be_handled_first', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = await answerBDuringSecurityReview($, data, clock)
  // 對話清掉等你；資安審查做完寫 HIGH 1
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；越權')
  data.files[`${ALPHA}/.task/SECURITY.md`] = '- [HIGH][授權] app/Http/Middleware/Admin.php:3 — 沒檢查角色'
  await h.finish(2)

  expect(data.launches).toHaveLength(2)
  expect(h.prompt(1).startsWith('修正第 1／2 輪：依 .task/SECURITY.md 修正所有 CRITICAL、HIGH')).toBe(true)
  expect(h.prompt(1)).not.toContain('選了 C) 修掉')
  const last = (data.store.jobs as any)[ALPHA].last
  expect(last.round).toBe(1)
  expect((data.store.chains as any)[ALPHA].fixTotal).toBe(1)
})

/** 資安審查跑時回答 C、資安審查做完沒有 CRITICAL／HIGH：先照常處理（過關），接著才派你選的 MEDIUM 修正 */
test('test_answer_b_during_security_review_dispatches_fix_after_security_passes', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = await answerBDuringSecurityReview($, data, clock)
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；無')
  data.files[`${ALPHA}/.task/SECURITY.md`] = '無發現'
  await h.finish(2)

  expect(data.launches).toHaveLength(2)
  expect(h.prompt(1).startsWith('修正：你在卡片 等你 對審查 MEDIUM 選了 C) 修掉：依 .task/REVIEW.md 與 .task/SECURITY.md 修正')).toBe(true)
  const run = (data.store.chains as any)[ALPHA]
  expect(run.mediumFixAt).toBeUndefined()
  expect(run.fixTotal).toBe(1)
})

/** 過關後才派、自動流程不會標成已處理的派工（推送／開 PR、同步）做完後回答 C：照樣派修正（不會一直卡著沒動靜） */
async function answerFixAfterPassedJob($: any, data: any, clock: any, kind: 'publish' | 'sync') {
  const h = helpers($, data, clock)
  data.agents = []
  launchOneAtATime(data, clock)
  passedWithMediumAsk(data, { owner: ME })
  const jobs = data.store.jobs as any
  const { handled: _, ...done } = jobs[ALPHA].last
  data.store.jobs = { ...jobs, [ALPHA]: { ...jobs[ALPHA], last: { ...done, kind, launchName: `desk-${kind}-0` } } }
  await h.refresh()
  await answerFix($, data)
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await h.refresh(); await h.step()
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0).startsWith('修正：你在卡片 等你 對審查 MEDIUM 選了 C) 修掉')).toBe(true)
  const run = (data.store.chains as any)[ALPHA]
  expect(run.mediumFixAt).toBeUndefined()
  expect(run.fixTotal).toBe(1)
}

test('test_answer_b_after_publish_still_dispatches_fix', async ($, on) => {
  const { data, clock } = fixture(on)
  await answerFixAfterPassedJob($, data, clock, 'publish')
})

test('test_answer_b_after_sync_still_dispatches_fix', async ($, on) => {
  const { data, clock } = fixture(on)
  await answerFixAfterPassedJob($, data, clock, 'sync')
})

// lean-fix-loop：審查 MEDIUM 題多一個「另開卡修」（推薦），修掉從 B 移到 C。
const FOLLOW_UP_LINE = '/desk:card new feature/alpha-medium "Alpha：審查 MEDIUM" feature/alpha'

/** 面板對審查 MEDIUM 題選 key、f 填入、送出；回傳送給對話的附加說明。 */
async function answerMedium($: any, data: any, key: string) {
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `case-${CARD_A}-opt0${key}` })
  await ui.press({ key: `case-${CARD_A}-fill` })
  expect(data.fills.at(-1).text).toBe(`「Alpha」決策：${key}`)
  await $.prompt.submit({ text: data.fills.at(-1).text } as any)
  await ui.unmount()
  return (data.submitted.at(-1).context ?? []).join('\n')
}

/** lean-fix-loop AC-3：選 B) 另開卡修送出：提示叫對話開疊在這條分支上的後續卡、寫進要修的 MEDIUM、原卡記新卡名並清等你；不記 HEAD、清掉等你後不派修正，原卡輪到開 PR */
test('test_follow_up_pick_opens_card_without_fix_dispatch', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  launchOneAtATime(data, clock)
  passedWithMediumAsk(data, { owner: ME })
  await h.refresh()
  const before = (data.store.chains as any)[ALPHA]

  const context = await answerMedium($, data, 'B')
  expect(context).toContain('審查 MEDIUM 那題選了 B) 另開卡修')
  expect(context).toContain(FOLLOW_UP_LINE)
  expect(context).toContain('開一張疊在這條分支上的後續卡，把要修的 MEDIUM')
  expect(context).toContain('寫進新卡的下一步')
  expect(context).toContain('在這張卡 Decisions 記後續卡名「Alpha：審查 MEDIUM」、把那題從「等你」拿掉')
  expect(context).toContain('工作桌不會在這張卡派修正')
  expect(context).not.toContain('不要自己修')
  // 不記 HEAD、流程紀錄不變
  expect((data.store.chains as any)[ALPHA]).toEqual(before)
  expect((data.store.chains as any)[ALPHA].mediumFixAt).toBeUndefined()

  // 對話記了決策、清掉等你：不派修正，原卡輪到開 PR
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await h.refresh(); await h.step(); await h.step()
  expect(data.launches).toHaveLength(0)
  const ui = await $.ui.mount(PANE(160))
  await ui.press({ key: `row-${CARD_A}` })
  expect(await screen(ui)).toContain(flat('開 PR'))
  await ui.unmount()
})

/** lean-fix-loop AC-4：選項重排後選 C) 修掉：跟改之前一樣記下 HEAD，清掉等你後工作桌派一輪修正 */
test('test_fix_pick_still_dispatches_after_reorder', async ($, on) => {
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  launchOneAtATime(data, clock)
  passedWithMediumAsk(data, { owner: ME })
  await h.refresh()

  const context = await answerMedium($, data, 'C')
  expect(context).toContain('審查 MEDIUM 那題選了 C) 修掉：不要自己修')
  expect(context).not.toContain('那題選了 B) 另開卡修')
  expect((data.store.chains as any)[ALPHA].mediumFixAt).toBe('h1')
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可')
  await h.refresh()
  expect(data.launches).toHaveLength(1)
  expect(h.prompt(0).startsWith('修正：你在卡片 等你 對審查 MEDIUM 選了 C) 修掉：依 .task/REVIEW.md 修正')).toBe(true)
})

/** lean-fix-loop AC-5：只有審查 MEDIUM 題選到另開卡修才帶後續卡提示；多題時照題號認，別的題目選項寫了「另開卡」也不算 */
test('test_follow_up_pick_only_matches_review_medium_ask', async ($, on) => {
  expect(picksMediumFollowUp(ASK, 'B')).toBe(true)
  for (const k of ['A', 'C', 'D']) expect(picksMediumFollowUp(ASK, k)).toBe(false)
  const other = '這個 bug 怎麼處理：A) 現在修 B) 另開卡修'
  expect(picksMediumFollowUp(other, 'B')).toBe(false)
  const two = `${other}；${ASK}`
  expect(picksMediumFollowUp(two, '1B 2A')).toBe(false)
  expect(picksMediumFollowUp(two, '1A 2B')).toBe(true)
  expect(picksMediumFix(two, '1A 2B')).toBe(false)

  // 真的送出：別題選了另開卡修、MEDIUM 題選不修，不帶後續卡提示；MEDIUM 題選另開卡修才帶
  const { data, clock } = fixture(on)
  const h = helpers($, data, clock)
  data.agents = []
  launchOneAtATime(data, clock)
  passedWithMediumAsk(data, { owner: ME })
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可', two)
  await h.refresh()
  await $.prompt.submit({ text: '「Alpha」決策：1B 2A' } as any)
  expect((data.submitted.at(-1).context ?? []).join('\n')).toContain('卡片「等你」的決策')
  expect((data.submitted.at(-1).context ?? []).join('\n')).not.toContain('那題選了 B) 另開卡修')
  // 上一則的決策還鎖著：換成一題新的再送
  setCard(data, CARD_A, 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；可', two.replace('1 條', '2 條'))
  await h.refresh()
  await $.prompt.submit({ text: '「Alpha」決策：1A 2B' } as any)
  expect((data.submitted.at(-1).context ?? []).join('\n')).toContain(FOLLOW_UP_LINE)
})

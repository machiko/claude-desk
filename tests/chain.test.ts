import { expect, test } from 'claude-code/testing'
import { fixture, CARD_A, PROJECT_DIR, result } from './fixture'
import { carriedFix, carriedReview, fixTotalOf, nextStep, recheckFeed, paused, handedOver, MAX_FIX_ROUNDS, AGENT_STOPPED } from '../hooks/chain'
import { STOP, fixLimitStop, highRiskStop } from '../hooks/stop-reason'

const run = (round = 0, extra = {}) => ({ owner: 'me', startedAt: 1, round, ...extra })
const v = (critical: number, high: number, medium = 0) => ({ critical, high, medium, low: 0 })

test('after implementation: check, then review when green, fix when red, stop after two rounds', () => {
  expect(MAX_FIX_ROUNDS).toBe(2)
  expect(nextStep(run(), 'continue', null, null, true)).toEqual({ kind: 'verify' })
  expect(nextStep(run(), 'continue', null, null, false)).toEqual({ kind: 'stop', reason: STOP.checkUnapproved, atCheck: true })
  expect(nextStep(run(), 'continue', null, null, false, { changed: true })).toEqual({ kind: 'stop', reason: STOP.checkChanged, atCheck: true })
  expect(nextStep(run(), 'continue', true, null, true)).toEqual({ kind: 'dispatch', dispatch: 'review', round: 0 })
  expect(nextStep(run(0), 'continue', false, null, true)).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 1, reason: 'check' })
  expect(nextStep(run(2), 'continue', false, null, true)).toEqual({ kind: 'stop', reason: fixLimitStop(2) })
})

test('after review: CRITICAL and HIGH are fixed, MEDIUM passes, no counts stops', () => {
  expect(nextStep(run(), 'review', null, v(0, 0, 3), true)).toEqual({ kind: 'pass' })
  expect(nextStep(run(), 'review', null, v(0, 1), true)).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 1, reason: 'review' })
  expect(nextStep(run(1), 'review', null, v(1, 0), true)).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 2, reason: 'review' })
  expect(nextStep(run(2), 'review', null, v(0, 2), true)).toEqual({ kind: 'stop', reason: fixLimitStop(2, { critical: 0, high: 2 }) })
  expect(nextStep(run(), 'review', null, null, true)?.kind).toBe('stop')
})

test('nothing moves without a live chain or a finished job', () => {
  expect(nextStep(undefined, 'continue', true, null, true)).toBeNull()
  expect(nextStep(run(0, { stopped: 'x' }), 'continue', true, null, true)).toBeNull()
  expect(nextStep(run(0, { passed: true }), 'review', null, v(0, 0), true)).toBeNull()
  expect(nextStep(run(), null, true, null, true)).toBeNull()
  expect(nextStep(run(), 'sync', true, null, true)).toBeNull()
})

test('risk: docs-only skips review; high risk adds one security review, then hands over to you', () => {
  const low = { level: 'low' as const, reasons: ['只動文件'] }
  const high = { level: 'high' as const, reasons: ['資料範圍', 'migration'] }
  expect(nextStep(run(), 'continue', true, null, true, { risk: low })).toEqual({ kind: 'pass', skipped: true })
  expect(nextStep(run(), 'continue', true, null, true, { risk: high })).toEqual({ kind: 'dispatch', dispatch: 'review', round: 0 })
  expect(nextStep(run(), 'review', null, v(0, 0), true, { risk: high })).toEqual({ kind: 'dispatch', dispatch: 'review', round: 0, security: true })
  expect(nextStep(run(), 'review', null, v(0, 0), true, { risk: high, lastWasSecurity: true })).toEqual({ kind: 'pass', needsHuman: highRiskStop(['資料範圍', 'migration']) })
  expect(nextStep(run(), 'review', null, v(1, 0), true, { risk: high, lastWasSecurity: true })).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 1, reason: 'review' })
})

test('a stopped agent pauses the chain without holding at the check', () => {
  // 被 `claude stop` 停掉的 Agent 不算做完：不跑檢查、不派審查或修正，流程暫停並說怎麼辦；不是檢查段的原因，不留 heldAtCheck。
  expect(AGENT_STOPPED).toBe('Agent 被停止，未完成；看過 worktree 後按 g 重開')
  expect(nextStep(run(), 'continue', null, null, true, { stopped: true })).toEqual({ kind: 'stop', reason: STOP.agentStopped })
  expect(nextStep(run(), 'continue', true, null, true, { stopped: true })).toEqual({ kind: 'stop', reason: STOP.agentStopped })
  expect(nextStep(run(1), 'review', null, v(0, 1), true, { stopped: true })).toEqual({ kind: 'stop', reason: STOP.agentStopped })
  expect(nextStep(run(), 'reply', null, null, true, { stopped: true })).toEqual({ kind: 'stop', reason: STOP.agentStopped })
  expect(nextStep(run(), 'sync', null, null, true, { stopped: true })).toBeNull()
  expect(nextStep(run(0, { stopped: 'x' }), 'continue', null, null, true, { stopped: true })).toBeNull()
  expect(paused(run(0, { heldAtCheck: true, stopArgs: { files: 2 } }), STOP.agentStopped)).toEqual({ owner: 'me', startedAt: 1, round: 0, stopped: 'agentStopped' })
})

/** AC-3 */
test('chain: a finished publish does not restart the chain', () => {
  // 推送（push、開 PR）不在流程裡：做完、被停掉、檢查結果或審查結論在不在都一樣，不跑檢查、不派審查或修正、不停下流程。
  for (const r of [run(), run(1), run(0, { passed: true })]) {
    expect(nextStep(r, 'publish', null, null, true)).toBeNull()
    expect(nextStep(r, 'publish', false, v(0, 1), true)).toBeNull()
    expect(nextStep(r, 'publish', null, null, false, { stopped: true })).toBeNull()
  }
  // 對照組：同樣條件做完的是實作就會往下走。
  expect(nextStep(run(), 'continue', null, null, true)).toEqual({ kind: 'verify' })
})

test('chain: a finished catchup does not run the check or count as a fix round', () => {
  // 解衝突（合併基準分支）不在流程裡：做完、被停掉都不跑檢查、不派審查或修正；有 commit 時由重新檢查接手。
  for (const r of [run(), run(1), run(0, { passed: true }), run(0, { stopped: 'x' })]) {
    expect(nextStep(r, 'catchup', null, null, true)).toBeNull()
    expect(nextStep(r, 'catchup', false, v(0, 1), true)).toBeNull()
    expect(nextStep(r, 'catchup', null, null, false, { stopped: true })).toBeNull()
  }
})

test('chain: a job whose question was handled in the conversation records the verdict but dispatches nothing', () => {
  // 過關、停下照舊：審查結論照記。
  expect(handedOver(nextStep(run(), 'review', null, v(0, 0, 2), true))).toEqual({ kind: 'pass' })
  expect(handedOver(nextStep(run(2), 'review', null, v(0, 1), true))).toEqual({ kind: 'stop', reason: fixLimitStop(2, { critical: 0, high: 1 }) })
  // 本來要派修正（審查或檢查擋下）：停下寫原因。
  expect(handedOver(nextStep(run(), 'review', null, v(0, 1), true))).toEqual({ kind: 'stop', reason: STOP.askHandedOver })
  expect(handedOver(nextStep(run(), 'continue', false, null, true))).toEqual({ kind: 'stop', reason: STOP.askHandedOver })
  // 本來要跑檢查、派審查（含資安審查）：什麼都不做。
  expect(handedOver(nextStep(run(), 'continue', null, null, true))).toBeNull()
  expect(handedOver(nextStep(run(), 'continue', true, null, true))).toBeNull()
  expect(handedOver({ kind: 'dispatch', dispatch: 'review', round: 0, security: true })).toBeNull()
  expect(handedOver(null)).toBeNull()
})

/** AC-1（單元）：只剩 MEDIUM（不管審查檔有沒有註記）不派修正、過關；跟 HIGH 同時有時只照 CRITICAL／HIGH 派一輪 */
test('test_next_step_never_fixes_medium', () => {
  const high = { level: 'high' as const, reasons: ['認證／中介層'] }
  expect(nextStep(run(), 'review', null, v(0, 0, 1), true)).toEqual({ kind: 'pass' })
  expect(nextStep(run(1), 'review', null, v(0, 0, 2), true)).toEqual({ kind: 'pass' })
  expect(nextStep(run(), 'review', null, v(0, 1, 3), true)).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 1, reason: 'review' })
  // 高風險：程式碼審查只剩 MEDIUM 照樣接資安審查；資安審查只剩 MEDIUM 過關、等你看
  expect(nextStep(run(), 'review', null, v(0, 0, 1), true, { risk: high })).toEqual({ kind: 'dispatch', dispatch: 'review', round: 0, security: true })
  expect(nextStep(run(), 'review', null, v(0, 0, 1), true, { risk: high, lastWasSecurity: true })?.kind).toBe('pass')
})

/** AC-5：累計修正數只帶同一條分支的；換分支、沒記分支從 0 起算；另一張卡是另一份流程紀錄，本來就從 0 起算 */
test('test_fix_round_total_is_per_branch', () => {
  const used = run(0, { fixTotal: 2, fixBranch: 'feature/a' })
  // 同一條分支：重開流程照帶，自動修正已用完
  expect(carriedFix(used, 'feature/a')).toEqual({ fixTotal: 2, fixBranch: 'feature/a' })
  expect(nextStep(run(0, carriedFix(used, 'feature/a')), 'review', null, v(0, 1), true)).toEqual({ kind: 'stop', reason: fixLimitStop(2, { critical: 0, high: 1 }) })
  // 換了分支、沒記分支、分支不明、沒有紀錄：從 0 起算，照常自動修
  for (const carried of [carriedFix(used, 'feature/b'), carriedFix(run(2), 'feature/a'), carriedFix(used, undefined), carriedFix(undefined, 'feature/a')]) {
    expect(carried).toEqual({})
    expect(fixTotalOf(run(0, carried))).toBe(0)
    expect(nextStep(run(0, carried), 'review', null, v(0, 1), true)).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 1, reason: 'review' })
  }
  // 你主動派的修正照樣算一輪：同分支 2 → 3，換分支 0 → 1
  expect(carriedFix(used, 'feature/a', true)).toEqual({ fixTotal: 3, fixBranch: 'feature/a' })
  expect(carriedFix(used, 'feature/b', true)).toEqual({ fixTotal: 1, fixBranch: 'feature/b' })
  // 舊紀錄沒有累計數：用這一輪的 round
  expect(fixTotalOf(run(1))).toBe(1)
})

/** 本卡 AC-1～AC-3（單元）：這條分支審查過、不是高風險：修正（審查或測試沒過的）與過關後的重新檢查，測試綠就過關、帶 unreviewed，不派審查；測試沒過照舊派修正 */
test('nextStep passes a reviewed branch on a green check without another review', () => {
  const seen = { reviewedBranch: 'feature/a' }
  const ctx = { branch: 'feature/a' }
  expect(nextStep(run(1, seen), 'continue', true, null, true, ctx)).toEqual({ kind: 'pass', unreviewed: true })
  expect(nextStep(run(0, { ...seen, recheck: true }), 'continue', true, null, true, ctx)).toEqual({ kind: 'pass', unreviewed: true })
  expect(nextStep(run(1, seen), 'reply', true, null, true, ctx)).toEqual({ kind: 'pass', unreviewed: true })
  expect(nextStep(run(1, seen), 'continue', false, null, true, ctx)).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 2, reason: 'check' })
  expect(nextStep(run(1, seen), 'continue', null, null, true, ctx)).toEqual({ kind: 'verify' })
  // 只動文件照舊免驗收
  expect(nextStep(run(1, seen), 'continue', true, null, true, { ...ctx, risk: { level: 'low', reasons: ['只動文件'] } })).toEqual({ kind: 'pass', skipped: true })
  // 換了分支、沒記、分支不明：照舊派審查
  for (const [r, c] of [[run(1, seen), { branch: 'feature/b' }], [run(1), ctx], [run(1, seen), {}]] as const) {
    expect(nextStep(r, 'continue', true, null, true, c)).toEqual({ kind: 'dispatch', dispatch: 'review', round: 1 })
  }
  // 開新一輪只帶同一條分支的標記
  expect(carriedReview(run(0, seen), 'feature/a')).toEqual(seen)
  expect(carriedReview(run(0, seen), 'feature/b')).toEqual({})
  expect(carriedReview(undefined, 'feature/a')).toEqual({})
  expect(recheckFeed('Alpha', true)).toBe('Alpha 驗收通過後有新 commit，自動重新測試，通過就過關、不重新驗收')
  expect(recheckFeed('Alpha', false)).toBe('Alpha 驗收通過後有新 commit，自動重新測試與驗收')
})

/** 本卡 AC-4：高風險卡就算這條分支審查過，修正後照舊複審（之後照舊接資安審查）；只動文件照舊免驗收；第一次實作做完照舊派審查 */
test('test_high_risk_fix_is_still_rereviewed', () => {
  const high = { level: 'high' as const, reasons: ['認證／中介層'] }
  const seen = run(1, { reviewedBranch: 'feature/a' })
  expect(nextStep(seen, 'continue', true, null, true, { risk: high, branch: 'feature/a' })).toEqual({ kind: 'dispatch', dispatch: 'review', round: 1 })
  expect(nextStep(run(0, { reviewedBranch: 'feature/a', recheck: true }), 'continue', true, null, true, { risk: high, branch: 'feature/a' })).toEqual({ kind: 'dispatch', dispatch: 'review', round: 0 })
  expect(nextStep(seen, 'review', null, v(0, 0), true, { risk: high, branch: 'feature/a' })).toEqual({ kind: 'dispatch', dispatch: 'review', round: 1, security: true })
  expect(nextStep(run(), 'continue', true, null, true, { risk: { level: 'low', reasons: ['只動文件'] }, branch: 'feature/a' })).toEqual({ kind: 'pass', skipped: true })
  expect(nextStep(run(), 'continue', true, null, true, { branch: 'feature/a' })).toEqual({ kind: 'dispatch', dispatch: 'review', round: 0 })
})

/** card-base-and-fast-path AC-5：設了 review.combineSecurity，高風險分支的程式碼審查已含資安重點，過關後不再另派資安審查，照舊停下來給你看。 */
test('combined security review does not dispatch second review', async ($, on) => {
  const { data, clock } = fixture(on)
  const ALPHA = '/home/u/wt/alpha'
  data.files[`${PROJECT_DIR}/dispatch.json`] = JSON.stringify({ review: { combineSecurity: true } })
  data.git[ALPHA] = { branch: 'feature/alpha', head: 'h1', files: ['src/Auth/Fido.php'] }
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.agents = []
  let n = 0
  data.launch = async (e: any) => {
    n++
    const id = `c000000${n}`
    data.agents = [{ id, kind: 'background', cwd: ALPHA, name: e.argv[3], sessionId: `${id}-0000-4000-8000-000000000000`, state: 'working', status: 'busy', startedAt: clock.now() }]
    return result(0, id)
  }
  const step = async () => { await clock.advance(2500); await clock.settle() }
  const finish = async () => {
    data.agents = data.agents.map(a => ({ ...a, status: 'idle', state: 'done' }))
    await $.command.run({ command: 'desk', args: 'refresh' } as any)
    await clock.settle(); await step(); await step(); await step()
  }
  const prompt = (i: number) => String(data.launches[i].argv[data.launches[i].argv.length - 1])

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'go Alpha' } as any)
  await clock.settle()
  await finish()
  // 實作 → 檢查通過 → 程式碼審查（含資安重點；檢查剛在 h1 跑過，不重跑整套）
  expect(data.launches).toHaveLength(2)
  expect(prompt(1).startsWith('程式碼審查')).toBe(true)
  expect(prompt(1)).toContain('這是高風險分支，這次審查同時做資安審查（過關後不另派）')
  expect(prompt(1)).toContain('完成檢查 `node test.mjs` 已在 HEAD h1 通過')

  data.files[CARD_A] = data.files[CARD_A]!.replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；可')
  await finish()
  expect(data.launches).toHaveLength(2)
  expect(data.toasts.some(t => t.includes('資安驗收已派出'))).toBe(false)
  const chain = (data.store.chains as any)[ALPHA]
  expect(chain.passed).toBe(true)
  expect(chain.needsHuman).toBe('highRisk')
})

/**
 * 維持-1（少等、少按、少續跑）：做完一輪寫進「等你」、已在對話處理（answered）：流程停下、過關（含高風險等你看）時照舊不派；
 * 本來就該停的（Agent 被停掉、檢查指令改過）照舊停；其他改派一次「繼續」，不算修正輪（不帶 reason），額度不足照舊煞車。
 */
test('test_answered_question_does_not_resume_stopped_or_passed_chain', () => {
  const answered = { answered: true }
  expect(nextStep(run(0, { stopped: STOP.agentStopped.code }), 'continue', null, null, true, answered)).toBeNull()
  expect(nextStep(run(0, { stopped: 'quotaHold' }), 'continue', true, null, true, answered)).toBeNull()
  expect(nextStep(run(0, { passed: true }), 'continue', true, null, true, answered)).toBeNull()
  expect(nextStep(run(0, { passed: true, needsHuman: 'highRisk' }), 'reply', true, null, true, answered)).toBeNull()
  expect(nextStep(run(), 'continue', null, null, true, { ...answered, stopped: true })).toEqual({ kind: 'stop', reason: STOP.agentStopped })
  expect(nextStep(run(), 'continue', null, null, false, { ...answered, changed: true })).toEqual({ kind: 'stop', reason: STOP.checkChanged, atCheck: true })
  // 其他：本來要跑檢查、派審查、派修正或過關的，都改成派一次繼續（同一輪、不算修正）
  for (const check of [null, true, false]) expect(nextStep(run(1), 'continue', check, null, true, answered)).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 1 })
  expect(nextStep(run(), 'reply', true, null, true, { ...answered, risk: { level: 'low', reasons: [] } })).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 0 })
  expect(nextStep(run(), 'continue', null, null, true, { ...answered, quotaHold: 'x' })).toEqual({ kind: 'stop', reason: 'x', resume: { dispatch: 'continue', round: 0 } })
})

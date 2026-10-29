import { expect, test } from 'claude-code/testing'
import { nextStep, paused, handedOver, MAX_FIX_ROUNDS, AGENT_STOPPED, ASK_HANDED_OVER, CHECK_CHANGED, CHECK_UNAPPROVED } from '../hooks/chain'

const run = (round = 0, extra = {}) => ({ owner: 'me', startedAt: 1, round, ...extra })
const v = (critical: number, high: number, medium = 0) => ({ critical, high, medium, low: 0 })

test('after implementation: check, then review when green, fix when red, stop after two rounds', () => {
  expect(MAX_FIX_ROUNDS).toBe(2)
  expect(nextStep(run(), 'continue', null, null, true)).toEqual({ kind: 'verify' })
  expect(nextStep(run(), 'continue', null, null, false)).toEqual({ kind: 'stop', reason: CHECK_UNAPPROVED, atCheck: true })
  expect(nextStep(run(), 'continue', null, null, false, { changed: true })).toEqual({ kind: 'stop', reason: CHECK_CHANGED, atCheck: true })
  expect(nextStep(run(), 'continue', true, null, true)).toEqual({ kind: 'dispatch', dispatch: 'review', round: 0 })
  expect(nextStep(run(0), 'continue', false, null, true)).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 1, reason: 'check' })
  expect(nextStep(run(2), 'continue', false, null, true)).toEqual({ kind: 'stop', reason: '修了 2 輪檢查仍未通過' })
})

test('after review: CRITICAL and HIGH are fixed, MEDIUM passes, no counts stops', () => {
  expect(nextStep(run(), 'review', null, v(0, 0, 3), true)).toEqual({ kind: 'pass' })
  expect(nextStep(run(), 'review', null, v(0, 1), true)).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 1, reason: 'review' })
  expect(nextStep(run(1), 'review', null, v(1, 0), true)).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 2, reason: 'review' })
  expect(nextStep(run(2), 'review', null, v(0, 2), true)).toEqual({ kind: 'stop', reason: '修了 2 輪仍有 CRITICAL 0、HIGH 2' })
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
  expect(nextStep(run(), 'review', null, v(0, 0), true, { risk: high, lastWasSecurity: true })).toEqual({ kind: 'pass', needsHuman: '高風險改動（資料範圍、migration），審查已過，請你看過再開 PR' })
  expect(nextStep(run(), 'review', null, v(1, 0), true, { risk: high, lastWasSecurity: true })).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 1, reason: 'review' })
})

test('a stopped agent pauses the chain without holding at the check', () => {
  // 被 `claude stop` 停掉的 Agent 不算做完：不跑檢查、不派審查或修正，流程暫停並說怎麼辦；不是檢查段的原因，不留 heldAtCheck。
  expect(AGENT_STOPPED).toBe('Agent 被停止，未完成；看過 worktree 後按 g 重開')
  expect(nextStep(run(), 'continue', null, null, true, { stopped: true })).toEqual({ kind: 'stop', reason: AGENT_STOPPED })
  expect(nextStep(run(), 'continue', true, null, true, { stopped: true })).toEqual({ kind: 'stop', reason: AGENT_STOPPED })
  expect(nextStep(run(1), 'review', null, v(0, 1), true, { stopped: true })).toEqual({ kind: 'stop', reason: AGENT_STOPPED })
  expect(nextStep(run(), 'reply', null, null, true, { stopped: true })).toEqual({ kind: 'stop', reason: AGENT_STOPPED })
  expect(nextStep(run(), 'sync', null, null, true, { stopped: true })).toBeNull()
  expect(nextStep(run(0, { stopped: 'x' }), 'continue', null, null, true, { stopped: true })).toBeNull()
  expect(paused(run(0, { heldAtCheck: true }), AGENT_STOPPED)).toEqual({ owner: 'me', startedAt: 1, round: 0, stopped: AGENT_STOPPED })
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

test('chain: a job whose question was handled in the conversation records the verdict but dispatches nothing', () => {
  // 過關、停下照舊：審查結論照記。
  expect(handedOver(nextStep(run(), 'review', null, v(0, 0, 2), true))).toEqual({ kind: 'pass' })
  expect(handedOver(nextStep(run(2), 'review', null, v(0, 1), true))).toEqual({ kind: 'stop', reason: '修了 2 輪仍有 CRITICAL 0、HIGH 1' })
  // 本來要派修正（審查或檢查擋下）：停下寫原因。
  expect(handedOver(nextStep(run(), 'review', null, v(0, 1), true))).toEqual({ kind: 'stop', reason: ASK_HANDED_OVER })
  expect(handedOver(nextStep(run(), 'continue', false, null, true))).toEqual({ kind: 'stop', reason: ASK_HANDED_OVER })
  // 本來要跑檢查、派審查（含資安審查）：什麼都不做。
  expect(handedOver(nextStep(run(), 'continue', null, null, true))).toBeNull()
  expect(handedOver(nextStep(run(), 'continue', true, null, true))).toBeNull()
  expect(handedOver({ kind: 'dispatch', dispatch: 'review', round: 0, security: true })).toBeNull()
  expect(handedOver(null)).toBeNull()
})

/** auto-fix-medium：要修的 MEDIUM 跟 HIGH 同一輪修；資安審查一樣；輪數用完只剩 MEDIUM 過關，還有 HIGH 照原句停下 */
test('test_next_step_fixes_medium_with_high_and_passes_at_round_cap', () => {
  const high = { level: 'high' as const, reasons: ['認證／中介層'] }
  // 只有 MEDIUM：派修正並帶 medium
  expect(nextStep(run(), 'review', null, v(0, 0, 1), true, { mediumFix: 1 })).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 1, reason: 'review', medium: 1 })
  // 跟 HIGH 同一輪，不另外多一輪
  expect(nextStep(run(), 'review', null, v(0, 1, 3), true, { mediumFix: 1 })).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 1, reason: 'review', medium: 1 })
  expect(nextStep(run(1), 'review', null, v(0, 0, 2), true, { mediumFix: 2 })).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 2, reason: 'review', medium: 2 })
  // 資安審查的 MEDIUM 也派修正；沒有要修的照舊過關（高風險要你看）
  expect(nextStep(run(), 'review', null, v(0, 0, 1), true, { risk: high, lastWasSecurity: true, mediumFix: 1 })).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 1, reason: 'review', medium: 1 })
  expect(nextStep(run(1), 'review', null, v(0, 0, 1), true, { risk: high, lastWasSecurity: true })?.kind).toBe('pass')
  // 程式碼審查只剩要修的 MEDIUM：先修，不先派資安審查
  expect(nextStep(run(), 'review', null, v(0, 0, 1), true, { risk: high, mediumFix: 1 })).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 1, reason: 'review', medium: 1 })
  // 第 2 輪只剩 MEDIUM：過關，不停下；還有 HIGH 照原句停下
  expect(nextStep(run(2), 'review', null, v(0, 0, 1), true, { mediumFix: 1 })).toEqual({ kind: 'pass' })
  expect(nextStep(run(2), 'review', null, v(0, 1, 1), true, { mediumFix: 1 })).toEqual({ kind: 'stop', reason: '修了 2 輪仍有 CRITICAL 0、HIGH 1' })
  // 沒有要修的 MEDIUM：回傳值跟以前一模一樣
  expect(nextStep(run(), 'review', null, v(0, 1, 2), true, { mediumFix: 0 })).toEqual({ kind: 'dispatch', dispatch: 'continue', round: 1, reason: 'review' })
})

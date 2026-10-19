import { expect, test } from 'claude-code/testing'
import { nextStep, MAX_FIX_ROUNDS } from '../hooks/chain'

const run = (round = 0, extra = {}) => ({ owner: 'me', startedAt: 1, round, ...extra })
const v = (critical: number, high: number, medium = 0) => ({ critical, high, medium, low: 0 })

test('after implementation: check, then review when green, fix when red, stop after two rounds', () => {
  expect(MAX_FIX_ROUNDS).toBe(2)
  expect(nextStep(run(), 'continue', null, null, true)).toEqual({ kind: 'verify' })
  expect(nextStep(run(), 'continue', null, null, false)?.kind).toBe('stop')
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

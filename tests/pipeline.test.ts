import { expect, test } from 'claude-code/testing'
import { pipeline, parseVerdict, checkStands, stageParts, standingVerdict } from '../hooks/pipeline'
import { buildCase } from '../hooks/model'
import type { Case, Verify } from '../types'

const card = (f: Partial<Record<'狀態' | '檢查' | '等你' | '下一步' | '關卡', string>>) =>
  `<!-- DESK -->\n- 狀態：${f.狀態 ?? 'ok'}\n- 檢查：${f.檢查 ?? '`npm test`'}\n- 等你：${f.等你 ?? '無'}\n- 下一步：${f.下一步 ?? '做事'}\n- 關卡：${f.關卡 ?? '無'}\n<!-- /DESK -->`
const mk = (f: Parameters<typeof card>[0] = {}, extra: Partial<Case> = {}): Case => ({ ...buildCase({ name: 'A', statusPath: '/p/a/.desk/CARD.md' }, card(f), 1, {}, undefined), git: { branch: 'feature/a', head: 'h1' }, ...extra })
const ok = (head = 'h1'): Verify => ({ command: 'npm test', at: 1, ok: true, exitCode: 0, tail: [], truncated: false, head })
const glyphs = (c: Case, v?: Verify) => stageParts(pipeline(c, v), true).map(p => p.text).join('')

test('verdict needs all four counts', () => {
  expect(parseVerdict('review：CRITICAL 0、HIGH 2、MEDIUM 1、LOW 0；要修')).toEqual({ critical: 0, high: 2, medium: 1, low: 0 })
  expect(parseVerdict('review: critical=1 high=0 medium=0 low=3')).toEqual({ critical: 1, high: 0, medium: 0, low: 3 })
  expect(parseVerdict('review：看起來不錯')).toBeNull()
  expect(parseVerdict('release：x')).toBeNull()
})

test('a check counts only for the current command and the current HEAD', () => {
  expect(checkStands(mk(), ok())).toBe(true)
  expect(checkStands(mk(), ok('old'))).toBeNull()
  expect(checkStands(mk(), { ...ok(), command: 'other' })).toBeNull()
  expect(checkStands(mk(), { ...ok(), ok: false })).toBe(false)
})

test('stages follow the evidence from the back', () => {
  expect(glyphs(mk({ 檢查: '無' }))).toBe('◆○○○○○')
  expect(pipeline(mk({ 檢查: '無' }), undefined).note).toBe('尚缺完成檢查')
  expect(glyphs(mk({ 等你: '要嗎？A) 要 B) 不要' }))).toBe('◆○○○○○')
  expect(glyphs(mk())).toBe('●◆○○○○')
  expect(glyphs(mk(), ok())).toBe('●●●◆○○')
  expect(glyphs(mk(), { ...ok(), ok: false })).toBe('●●✕○○○')
  expect(glyphs(mk({ 關卡: 'review：CRITICAL 0、HIGH 0、MEDIUM 3、LOW 1；可' }))).toBe('●●●●◆○')
  expect(pipeline(mk({ 關卡: 'review：CRITICAL 0、HIGH 0、MEDIUM 3、LOW 1；可' }), undefined).note).toBe('可開 PR')
  expect(glyphs(mk({ 關卡: 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；可' }, { pr: { id: 9, state: 'OPEN', ci: 'pending' } }))).toBe('●●●●◉○')
  expect(glyphs(mk({ 關卡: 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；可' }, { pr: { id: 9, state: 'OPEN', ci: 'fail' } }))).toBe('●●●●✕○')
  expect(glyphs(mk({}, { pr: { id: 9, state: 'MERGED', ci: 'none' } }))).toBe('●●●●●◆')
  expect(pipeline(mk({}, { pr: { id: 9, state: 'MERGED', ci: 'none' } }), undefined).note).toBe('待打 tag')
  expect(glyphs(mk({ 關卡: 'release：v1.4.0 可上線' }, { tag: 'v1.4.0' }))).toBe('●●●●●◆')
  expect(pipeline(mk({ 關卡: 'release：v1.4.0 可上線' }, { tag: 'v1.4.0' }), undefined).note).toBe('v1.4.0 已打，待確認上線')
  // 只有 tag、沒有合併／審查過關／release 關卡：不算上線（剛從打了 tag 的 main 開的分支）
  expect(glyphs(mk({}, { tag: 'v1.4.0' }))).toBe('●◆○○○○')
  expect(pipeline(mk({}, { tag: 'v1.4.0', pr: { id: 9, state: 'MERGED', ci: 'none' } }), undefined).current).toBeNull()
})

test('a review with blocking issues stays in review while the chain fixes it, and fails once it stopped', () => {
  const gate = { 關卡: 'review：CRITICAL 1、HIGH 0、MEDIUM 0、LOW 0；SQL 注入' }
  expect(glyphs(mk(gate, { chain: { round: 1 } }), ok())).toBe('●●●◉○○')
  expect(glyphs(mk(gate, { chain: { round: 2, stopped: '修了 2 輪仍有 CRITICAL 1、HIGH 0' } }), ok())).toBe('●●●✕○○')
})

test('idle and manual cases say so instead of offering to continue', () => {
  expect(pipeline(mk({ 下一步: '無' }), undefined).note).toBe('閒置')
  expect(pipeline(mk({}, { manual: true }), undefined).note).toBe('手動追蹤')
  expect(pipeline(mk(), undefined).note).toBe('可繼續實作')
})

test('a release line only shows check and ship', () => {
  const c = mk({}, { git: { branch: 'release/v1.4', head: 'h1' } })
  const p = pipeline(c, ok())
  expect(p.stages.map(s => s.status)).toEqual(['na', 'na', 'done', 'na', 'na', 'wait'])
  expect(stageParts(p, false).map(s => s.text)).toEqual(['檢查●', '上線◆'])
  expect(pipeline(c, undefined).stages.find(s => s.id === 'check')!.status).toBe('wait')
})

test('a commit after the review passed sends the case back to check, then to review', () => {
  const passed = { 關卡: 'review：CRITICAL 0、HIGH 0、MEDIUM 1、LOW 0；過' }
  const stale = (extra: Partial<Case> = {}) => mk(passed, { chain: { round: 0, passed: true, stale: true }, ...extra })
  // 沒有新 commit：照舊停在合併
  expect(glyphs(mk(passed, { chain: { round: 0, passed: true } }))).toBe('●●●●◆○')
  // 審查後有新 commit：舊結論不算，退回檢查
  expect(standingVerdict(stale())).toBeNull()
  expect(glyphs(stale())).toBe('●●◆○○○')
  expect(pipeline(stale(), undefined).note).toBe('審查後有新 commit，需重新檢查')
  // 新 HEAD 的檢查過了：輪到重新審查
  expect(glyphs(stale(), ok())).toBe('●●●◆○○')
  expect(pipeline(stale(), ok()).note).toBe('審查後有新 commit，待重新審查')
  // 舊 HEAD 的檢查不算
  expect(glyphs(stale(), ok('old'))).toBe('●●◆○○○')
  // 合併後就不再退回
  expect(glyphs(stale({ pr: { id: 9, state: 'MERGED', ci: 'none' } }))).toBe('●●●●●◆')
})

test('a branch already inside its base counts as merged only once it reached the merge stage', () => {
  const passed = { 關卡: 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過' }
  // 審查過了、git 看到 HEAD 已在 main 裡：合併算過，輪到上線
  expect(glyphs(mk(passed, { mergedInto: 'origin/main' }))).toBe('●●●●●◆')
  expect(pipeline(mk(passed, { mergedInto: 'origin/main' }), undefined).note).toBe('待打 tag')
  // 剛開的分支（HEAD 還是 base 的 commit）不算合併
  expect(glyphs(mk({}, { mergedInto: 'origin/main' }))).toBe('●◆○○○○')
  expect(glyphs(mk({}, { mergedInto: 'origin/main' }), ok())).toBe('●●●◆○○')
})

test('a tag counts as shipped once the PR is merged, the review passed, or the gate is release', () => {
  const passed = { 關卡: 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過' }
  expect(glyphs(mk({ 檢查: '無' }, { tag: 'v0.19.0' }))).toBe('◆○○○○○')
  expect(pipeline(mk({ 關卡: 'spec：待確認規格' }, { tag: 'v0.19.0' }), undefined).note).toBe('規格待確認')
  expect(pipeline(mk({}, { tag: 'v0.19.0', mergedInto: 'origin/main' }), undefined).current).toBe('build')
  expect(pipeline(mk(passed, { tag: 'v0.19.0' }), undefined).current).toBeNull()
  expect(pipeline(mk(passed, { tag: 'v0.19.0', mergedInto: 'origin/main' }), undefined).current).toBeNull()
  expect(pipeline(mk({}, { tag: 'v0.19.0', pr: { id: 9, state: 'MERGED', ci: 'none' } }), undefined).current).toBeNull()
  expect(pipeline(mk({ 關卡: 'release：v0.19.0 可上線' }, { tag: 'v0.19.0' }), undefined).current).toBe('ship')
})

test('a confirmed ship stays shipped after the release gate is cleared and the PR is no longer shown', () => {
  // 按 u 之後：關卡清成無、看不到 PR，只剩卡片上確認時寫的狀態與下一步
  expect(pipeline(mk({ 狀態: 'v0.19.0 已上線（工作桌確認）', 下一步: '等下一版開發' }, { tag: 'v0.19.0' }), undefined).current).toBeNull()
  expect(pipeline(mk({ 下一步: '可歸檔：/desk:card archive a' }, { tag: 'v0.19.0' }), undefined).current).toBeNull()
  // 寫的是別的版號：不算這個 tag 已上線
  expect(glyphs(mk({ 狀態: 'v0.18.0 已上線（工作桌確認）' }, { tag: 'v0.19.0' }))).toBe('●◆○○○○')
})

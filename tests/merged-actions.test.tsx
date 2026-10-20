import { expect, test } from 'claude-code/testing'
import { buildCase } from '../hooks/model'
import { finalState, pipeline } from '../hooks/pipeline'
import { cardBehind, stageActions, turnOf, type ActionId } from '../hooks/turn'
import type { Case, Verify } from '../types'
import { fixture, CARD_A, CARD_B, PANE } from './fixture'

const card = (f: { gate?: string; next?: string }) =>
  `<!-- DESK -->\n- 狀態：ok\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：${f.next ?? '依規格實作'}\n- 關卡：${f.gate ?? '無'}\n<!-- /DESK -->`

/** 跟工作桌一樣：讀卡 → 疊上 git／PR／接力 → 算六段 → 決定是否完成。 */
function mk(f: Parameters<typeof card>[0], extra: Partial<Case> = {}, v?: Verify): Case {
  const base = { ...buildCase({ name: 'A', statusPath: '/w/age-group/.desk/CARD.md' }, card(f), 1, {}, v), git: { branch: 'feature/a', head: 'h2' }, ...extra }
  const piped = { ...base, pipeline: pipeline(base as Case, v) }
  return { ...piped, state: finalState(piped) } as Case
}
const failedCheck: Verify = { command: 'npm test', at: 1, ok: false, exitCode: 1, tail: [], truncated: false, head: 'h2' }
const merged = { pr: { id: 12, state: 'MERGED' as const, ci: 'none' as const, url: 'https://github.com/acme/shop/pull/12' } }
const ids = (c: Case, ctx = {}) => [...stageActions(c, ctx)].sort()
const NOT_AFTER_MERGE: ActionId[] = ['continue', 'review', 'sync', 'verify']

test('merged case whose check failed afterwards only offers post-merge actions', () => {
  const c = mk({}, merged, failedCheck)
  expect(c.state).not.toBe('failed')
  expect(ids(c)).toEqual(['open', 'pr', 'ship'])
  expect(turnOf(c)).toEqual({ who: 'you', text: '打 tag 發版' })
  // 完成檢查在跑或排隊也一樣：合併後不再出現檢查
  for (const ctx of [{ verifying: true }, { queued: true }]) for (const id of NOT_AFTER_MERGE) expect(stageActions(c, ctx).has(id)).toBe(false)
})

test('merged case whose chain stopped after merge is not failed and has no continue, review, sync or check', () => {
  const c = mk({}, { ...merged, chain: { round: 0, stopped: '完成檢查要你核准才能執行', stale: true } })
  expect(c.state).not.toBe('failed')
  for (const id of NOT_AFTER_MERGE) expect(stageActions(c).has(id)).toBe(false)
  expect(turnOf(c).text).toBe('打 tag 發版')
})

test('merged and tagged with a release gate offers ship confirm, never continue or check', () => {
  const c = mk({ gate: 'release：v0.2.0' }, { ...merged, tag: 'v0.2.0', chain: { round: 0, stopped: '完成檢查未通過' } }, failedCheck)
  expect(ids(c)).toEqual(['open', 'pr', 'ship'])
  expect(turnOf(c)).toEqual({ who: 'you', text: '部署 v0.2.0 後按 u 確認上線', key: 'u' })
})

test('merged, tagged and confirmed with a failed check is done: archive and open only', () => {
  const c = mk({ next: '可歸檔' }, { ...merged, tag: 'v0.2.0' }, failedCheck)
  expect(c.state).toBe('done')
  expect(ids(c)).toEqual(['archive', 'open', 'pr'])
})

test('merged via git (no PR) drops sync and check as well', () => {
  const c = mk({ gate: 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過' }, { mergedInto: 'origin/main' }, failedCheck)
  expect(c.state).not.toBe('failed')
  expect(ids(c)).toEqual(['open', 'ship'])
})

test('merged via git after a commit that followed the review still counts as merged', () => {
  const c = mk({ gate: 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過' }, { mergedInto: 'origin/main', chain: { round: 0, passed: true, stale: true } }, failedCheck)
  expect(c.pipeline?.stages.find(s => s.id === 'merge')?.status).toBe('done')
  expect(c.state).not.toBe('failed')
  expect(ids(c)).toEqual(['open', 'ship'])
})

test('merged case does not hint to sync the card', () => {
  const now = 10 * 60_000
  const c = mk({ gate: 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過' }, { ...merged, updatedAt: 0, commitAt: 5 * 60_000 })
  expect(cardBehind(c, now)).toBe(false)
  // 對照：還沒合併的同一件會提示
  const open = mk({ gate: 'review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過' }, { updatedAt: 0, commitAt: 5 * 60_000 })
  expect(cardBehind(open, now)).toBe(true)
})

test('a commit after the pass on a merged branch does not start another check or review', async ($, on) => {
  const { data, clock } = fixture(on)
  const root = '/home/u/wt/alpha'
  data.git[root] = { branch: 'feature/alpha', head: 'h2' }
  data.prs = [{ id: 7, state: 'MERGED', dest: 'main', url: 'https://bitbucket.org/x/7' }]
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無').replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  data.store.chains = { [root]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, reviewHead: 'h1', judgedHead: 'h1' } }
  data.store.jobs = { [root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }
  data.agents = []
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  await clock.advance(2500); await clock.settle()
  expect(data.processCalls.filter(c => c.argv[0] === 'sh').length).toBe(0)
  expect(data.launches.length).toBe(0)
  const run = (data.store.chains as any)[root]
  expect(run.passed).toBe(true)
  expect(run.recheck).toBeUndefined()
})

test('a commit after the pass merged only through git does not start another check or review, and shows only post-merge actions', async ($, on) => {
  const { data, clock } = fixture(on)
  const root = '/home/u/wt/beta'
  // 審查在 g1 通過；之後多了 g2（例如改版號），沒開 PR、直接併進 main
  data.git[root] = { branch: 'feature/b', head: 'g2', remote: 'git@github.com:acme/shop.git', releases: '', originHead: 'origin/main', merged: ['origin/main'], firstParent: 'm2\nm1\n', parents: { m1: 'base0' } }
  data.gh = null
  data.files[CARD_B] = data.files[CARD_B]!.replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  data.store.trustedVerify = { [CARD_B]: 'node test.mjs' }
  data.store.chains = { [root]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, reviewHead: 'g1', judgedHead: 'g1' } }
  data.store.jobs = { [root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }
  data.agents = []
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  await clock.advance(2500); await clock.settle()
  expect(data.processCalls.filter(c => c.argv[0] === 'sh').length).toBe(0)
  expect(data.launches.length).toBe(0)
  const run = (data.store.chains as any)[root]
  expect(run.passed).toBe(true)
  expect(run.recheck).toBeUndefined()
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ type: 'Text', text: /已合併到 main/ })).toBeDefined()
  expect(await ui.find({ key: `case-${CARD_B}-open` })).toBeDefined()
  for (const k of NOT_AFTER_MERGE) expect(await ui.find({ key: `case-${CARD_B}-${k}` })).toBeUndefined()
  await ui.unmount()
})

test('a review that finishes after the merge is archived and marked handled, and nothing else is dispatched', async ($, on) => {
  const { data, clock } = fixture(on)
  const root = '/home/u/wt/alpha'
  data.git[root] = { branch: 'feature/alpha', head: 'h1' }
  data.prs = [{ id: 7, state: 'MERGED', dest: 'main', url: 'https://bitbucket.org/x/7' }]
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無').replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 1、MEDIUM 0、LOW 0；漏稽核')
  data.files[`${root}/.task/REVIEW.md`] = '# 審查\n\n- [HIGH] 漏稽核\n'
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  // 合併前派出的審查，合併後才結束：結論有 HIGH，但已經合併，不再派修正
  data.store.chains = { [root]: { owner: 'fixture-session', startedAt: 0, round: 0, reviewHead: 'h1' } }
  data.store.jobs = { [root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session' } } }
  data.agents = []
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  await clock.advance(2500); await clock.settle()
  expect(data.writes.some(w => /\/reviews\/alpha-\d{8}-\d{4}-code\.md$/.test(w))).toBe(true)
  expect((data.store.jobs as any)[root].last.handled).toBe(true)
  expect(data.launches.length).toBe(0)
  expect(data.processCalls.filter(c => c.argv[0] === 'sh').length).toBe(0)
})

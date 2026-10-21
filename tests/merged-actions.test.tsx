import { expect, test } from 'claude-code/testing'
import { buildCase } from '../hooks/model'
import { finalState, pipeline } from '../hooks/pipeline'
import { cardBehind, stageActions, turnOf, type ActionId } from '../hooks/turn'
import type { Case, Verify } from '../types'
import { fixture, CARD_A, CARD_B, PANE } from './fixture'

const card = (f: { gate?: string; next?: string }) =>
  `<!-- DESK -->\n- 狀態：ok\n- 檢查：\`npm test\`\n- 等你：無\n- 下一步：${f.next ?? '依規格實作'}\n- 關卡：${f.gate ?? '無'}\n<!-- /DESK -->`

/** 跟工作桌一樣：讀卡 → 疊上 git／PR／流程 → 算六段 → 決定是否完成。 */
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

/** 只靠 git 認合併、沒有 PR：合併在 g1，之後分支又有 g2（合併後補改版號、文件）。g2 不在 main 裡，仍算已合併。 */
test('a branch merged only through git stays merged after a later commit on it', async ($, on) => {
  const { data, clock } = fixture(on)
  const root = '/home/u/wt/beta'
  data.git[root] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git', releases: '', originHead: 'origin/main', merged: ['origin/main'], firstParent: 'm2\nm1\n', parents: { m1: 'base0' } }
  data.gh = null
  data.files[CARD_B] = data.files[CARD_B]!.replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  data.store.trustedVerify = { [CARD_B]: 'node test.mjs' }
  data.store.chains = { [root]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, reviewHead: 'g1', judgedHead: 'g1' } }
  data.store.jobs = { [root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }
  data.agents = []
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle(); await clock.advance(2500); await clock.settle() }
  await refresh()

  // 合併之後，分支上多了 g2：g2 不在 main 裡，但是從合併時的 g1 長出來的
  data.git[root] = { ...data.git[root]!, head: 'g2', merged: [], forkPoint: 'g1', descends: ['g1'], branchLine: 'g2\n', parents: { m1: 'base0', g2: 'g1' } }
  await refresh()

  expect(data.processCalls.filter(c => c.argv[0] === 'sh').length).toBe(0)
  expect(data.launches.length).toBe(0)
  const run = (data.store.chains as any)[root]
  expect(run.passed).toBe(true)
  expect(run.recheck).toBeUndefined()
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ type: 'Text', text: /已合併到 main/ })).toBeDefined()
  for (const k of NOT_AFTER_MERGE) expect(await ui.find({ key: `case-${CARD_B}-${k}` })).toBeUndefined()
  await ui.unmount()
})

/** 範圍外：git 認過合併的分支，之後的 commit 開了新 PR，就照新 PR 走；換了分支也不算合併。 */
test('a later PR or another branch in the same folder is not taken as the earlier git merge', async ($, on) => {
  const { data, clock } = fixture(on)
  const root = '/home/u/wt/beta'
  data.git[root] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git', releases: '', originHead: 'origin/main', merged: ['origin/main'], firstParent: 'm2\nm1\n', parents: { m1: 'base0' } }
  data.gh = null
  data.files[CARD_B] = data.files[CARD_B]!.replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  data.agents = []
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() }
  // 選取會保留：只在開頭點一次 Beta，之後每次打開面板它都在現在卡上。
  const merged = async () => { const ui = await $.ui.mount(PANE(80)); const hit = await ui.find({ type: 'Text', text: /已合併到 main/ }); await ui.unmount(); return !!hit }
  await refresh()
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  await ui.unmount()
  expect(await merged()).toBe(true)

  // 合併後的 g2 開了新 PR：照 PR 走，不顯示「已合併到 main」
  data.git[root] = { ...data.git[root]!, head: 'g2', merged: [], forkPoint: 'g1', descends: ['g1'], branchLine: 'g2\n', parents: { m1: 'base0', g2: 'g1' } }
  data.gh = [{ number: 31, state: 'OPEN', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/31', statusCheckRollup: [] }]
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.advance(6 * 60_000); await refresh()
  expect(await merged()).toBe(false)

  // 同一個資料夾切到別的分支：不沿用 feature/b 的合併
  data.gh = null
  data.git[root] = { ...data.git[root]!, branch: 'feature/c', head: 'c1', merged: [], forkPoint: 'g1', descends: ['g1'], branchLine: 'c1\n', parents: { m1: 'base0', c1: 'g1' } }
  await clock.advance(6 * 60_000); await refresh()
  expect(await merged()).toBe(false)
})

/** 範圍外：同一個資料夾歸檔後用同名分支重開（從已包含舊合併的 main 切出來），新分支還沒合併，不能沿用舊的 git 合併紀錄。 */
test('a branch reopened under the same name in the same folder is not taken as the earlier git merge', async ($, on) => {
  const { data, clock } = fixture(on)
  const root = '/home/u/wt/beta'
  data.git[root] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git', releases: '', originHead: 'origin/main', merged: ['origin/main'], firstParent: 'm2\nm1\n', parents: { m1: 'base0' } }
  data.gh = null
  data.files[CARD_B] = data.files[CARD_B]!.replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  data.agents = []
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle() }
  const ui = await $.ui.mount(PANE(80))
  await refresh()
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ type: 'Text', text: /已合併到 main/ })).toBeDefined()
  await ui.unmount()

  // 重開的 feature/b 從 main 的 m3 切出、新 commit n1：m3 包含當初的 g1，但分叉點是 m3，不是 g1；
  // 沿 n1 的第一個父走的是 main 的主線（m3、m2、m1），g1 只是 m2 的第二個父
  data.git[root] = { ...data.git[root]!, head: 'n1', merged: [], forkPoint: 'm3', descends: ['g1'], branchLine: 'n1\nm3\nm2\nm1\n' }
  await clock.advance(6 * 60_000); await refresh()
  const again = await $.ui.mount(PANE(80))
  expect(await again.find({ type: 'Text', text: /已合併到 main/ })).toBeUndefined()
  expect(await again.find({ key: `case-${CARD_B}-sync` })).toBeDefined()
  await again.unmount()
})

/** 只靠 git 認合併、沒有 PR：合併在 g1，之後把 main（m3）併回分支成 x1。分叉點變成 m3，但沿 x1 的第一個父仍走得到 g1，仍算已合併。 */
test('a branch merged only through git stays merged after main is merged back into it', async ($, on) => {
  const { data, clock } = fixture(on)
  const root = '/home/u/wt/beta'
  data.git[root] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git', releases: '', originHead: 'origin/main', merged: ['origin/main'], firstParent: 'm2\nm1\n', parents: { m1: 'base0' } }
  data.gh = null
  data.files[CARD_B] = data.files[CARD_B]!.replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  data.store.trustedVerify = { [CARD_B]: 'node test.mjs' }
  data.store.chains = { [root]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, reviewHead: 'g1', judgedHead: 'g1' } }
  data.store.jobs = { [root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }
  data.agents = []
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle(); await clock.advance(2500); await clock.settle() }
  await refresh()

  // 合併之後 git merge origin/main：x1 的第一個父是 g1、第二個父是 main 的 m3
  data.git[root] = { ...data.git[root]!, head: 'x1', merged: [], forkPoint: 'm3', descends: ['g1'], branchLine: 'x1\n', parents: { m1: 'base0', x1: 'g1' } }
  await refresh()

  expect(data.processCalls.filter(c => c.argv[0] === 'sh').length).toBe(0)
  expect(data.launches.length).toBe(0)
  const run = (data.store.chains as any)[root]
  expect(run.passed).toBe(true)
  expect(run.recheck).toBeUndefined()
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ type: 'Text', text: /已合併到 main/ })).toBeDefined()
  for (const k of NOT_AFTER_MERGE) expect(await ui.find({ key: `case-${CARD_B}-${k}` })).toBeUndefined()
  await ui.unmount()
})

/** 已合併、流程停在檢查段時用指令跑檢查：只記檢查結果，不寫「流程繼續」，流程與派工紀錄維持原樣（合併後流程不再往下走）。 */
test('running the check on a merged case paused at the check does not claim the chain goes on', async ($, on) => {
  const { data, clock } = fixture(on)
  const root = '/home/u/wt/alpha'
  data.git[root] = { branch: 'feature/alpha', head: 'h1' }
  data.prs = [{ id: 7, state: 'MERGED', dest: 'main', url: 'https://bitbucket.org/x/7' }]
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無')
  data.store.trustedVerify = { [CARD_A]: 'node test.mjs' }
  const held = { owner: 'fixture-session', startedAt: 0, round: 0, stopped: '容器 app 未啟動，請先在主工作區執行 docker compose up -d app', heldAtCheck: true }
  data.store.chains = { [root]: held }
  data.store.jobs = { [root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'continue', startedAt: 0, fresh: false, owner: 'fixture-session', handled: true } } }
  data.agents = []
  let feed: { text: string }[] = []
  on('state.set', (_: any, e: any, next: any) => { if (e?.plugin === 'desk' && e?.key === 'feed') feed = e.value; return next(e) })
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()

  await $.command.run({ command: 'desk', args: 'verify Alpha' } as any)
  await clock.settle(); await clock.advance(2500); await clock.settle()

  expect(data.processCalls.filter(c => c.argv[0] === 'sh').length).toBe(1)
  expect(feed.some(e => e.text.includes('檢查通過'))).toBe(true)
  expect(feed.some(e => e.text.includes('流程繼續'))).toBe(false)
  expect(data.launches.length).toBe(0)
  expect((data.store.chains as any)[root]).toEqual(held)
  expect((data.store.jobs as any)[root].last.handled).toBe(true)
})

/** AC-1：只靠 git 認合併、沒有 PR：合併在 g1，之後在分支跑 git merge origin/main 被 fast-forward 到 main 頂端 m3，仍算已合併。 */
test('a branch merged only through git stays merged after fast-forwarding to main', async ($, on) => {
  const { data, clock } = fixture(on)
  const root = '/home/u/wt/beta'
  data.git[root] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git', releases: '', originHead: 'origin/main', merged: ['origin/main'], firstParent: 'm2\nm1\n', parents: { m1: 'base0' } }
  data.gh = null
  data.files[CARD_B] = data.files[CARD_B]!.replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  data.store.trustedVerify = { [CARD_B]: 'node test.mjs' }
  data.store.chains = { [root]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, reviewHead: 'g1', judgedHead: 'g1' } }
  data.store.jobs = { [root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }
  data.agents = []
  const refresh = async () => { await $.command.run({ command: 'desk', args: 'refresh' } as any); await clock.settle(); await clock.advance(2500); await clock.settle() }
  await refresh()

  // 分支沒有新 commit 就 git merge origin/main：fast-forward 到 main 的 m3（first-parent 走 m3→m2→m1，g1 是 m2 的第二個父）
  data.git[root] = { ...data.git[root]!, head: 'm3', merged: ['origin/main'], forkPoint: 'm3', descends: ['g1'], branchLine: 'm3\nm2\nm1\n', firstParent: '', parents: { m1: 'base0' } }
  await refresh()

  expect(data.processCalls.filter(c => c.argv[0] === 'sh').length).toBe(0)
  expect(data.launches.length).toBe(0)
  const run = (data.store.chains as any)[root]
  expect(run.passed).toBe(true)
  expect(run.recheck).toBeUndefined()
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ type: 'Text', text: /已合併到 main/ })).toBeDefined()
  for (const k of NOT_AFTER_MERGE) expect(await ui.find({ key: `case-${CARD_B}-${k}` })).toBeUndefined()
  await ui.unmount()
})

/** AC-2：g1 審查通過時還沒合併（進兩分鐘節流），兩分鐘內 g1 併進 main 且分支又補了 g2（工作桌從沒在 g1 看到合併），仍認得出已合併。 */
test('a commit within two minutes of the merge is still recognized as merged without having seen the merge head', async ($, on) => {
  const { data, clock } = fixture(on)
  const root = '/home/u/wt/beta'
  data.git[root] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git', releases: '', originHead: 'origin/main', merged: [] }
  data.gh = null
  data.files[CARD_B] = data.files[CARD_B]!.replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  data.store.trustedVerify = { [CARD_B]: 'node test.mjs' }
  data.store.chains = { [root]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, reviewHead: 'g1', reviewBranch: 'feature/b', judgedHead: 'g1', judgedBranch: 'feature/b' } }
  data.store.jobs = { [root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }
  data.agents = []
  const tickRefresh = async () => { await clock.advance(30_000); await clock.settle(); await clock.advance(2500); await clock.settle() }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()

  // 30 秒後（還在兩分鐘節流內）：g1 已併進 main，分支上又多了 g2（g2 不在 main 裡）
  data.git[root] = { ...data.git[root]!, head: 'g2', merged: [], forkPoint: 'g1', descends: ['g1'], branchLine: 'g2\n', firstParent: 'm2\nm1\n', parents: { m1: 'base0', g2: 'g1' } }
  await tickRefresh()

  expect(data.processCalls.filter(c => c.argv[0] === 'sh').length).toBe(0)
  expect(data.launches.length).toBe(0)
  expect((data.store.gitMerged as any)?.[root]).toEqual({ branch: 'feature/b', head: 'g1', into: 'origin/main' })
  const run = (data.store.chains as any)[root]
  expect(run.passed).toBe(true)
  expect(run.recheck).toBeUndefined()
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ type: 'Text', text: /已合併到 main/ })).toBeDefined()
  for (const k of NOT_AFTER_MERGE) expect(await ui.find({ key: `case-${CARD_B}-${k}` })).toBeUndefined()
  await ui.unmount()
})

/** AC-5（範圍外）：另一個 worktree 的 feature/b 從 feature/a 已併進 main 的 a1 開出來、在 b1 審查過；分叉點 a1 雖經由 merge commit 併進 main，但工作桌從沒在這條分支看到 HEAD＝a1，不算已合併。 */
test('a branch forked from a merged commit in another worktree is not taken as merged after review', async ($, on) => {
  const { data, clock } = fixture(on)
  const root = '/home/u/wt/beta'
  // b1 不在 main 裡；merge-base(b1, origin/main)＝a1，a1 在 b1 的 first-parent 鏈上，且沿 main 的 first-parent 回到 a1 之前是 base0 ≠ a1（a1 經由 merge commit 併進 main）
  data.git[root] = { branch: 'feature/b', head: 'b1', remote: 'git@github.com:acme/shop.git', releases: '', originHead: 'origin/main', merged: [], forkPoint: 'a1', descends: ['a1'], branchLine: 'b1\n', firstParent: 'm2\nm1\n', parents: { m1: 'base0', b1: 'a1' } }
  data.gh = null
  data.files[CARD_B] = data.files[CARD_B]!.replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  data.store.trustedVerify = { [CARD_B]: 'node test.mjs' }
  data.store.gitMerged = { '/home/u/wt/alpha': { branch: 'feature/a', head: 'a1', into: 'origin/main' } }
  data.store.chains = { [root]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, reviewHead: 'b1', reviewBranch: 'feature/b', judgedHead: 'b1', judgedBranch: 'feature/b' } }
  data.store.jobs = { [root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }
  data.agents = []
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle(); await clock.advance(2500); await clock.settle()

  expect(data.launches.length).toBe(0)
  expect((data.store.gitMerged as any)[root]).toBeUndefined()
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ type: 'Text', text: /已合併到 main/ })).toBeUndefined()
  expect(await ui.find({ key: `case-${CARD_B}-sync` })).toBeDefined()
  await ui.unmount()
})

/** AC-5（同資料夾）：不用 worktree，feature/a 在 a1 審過（流程紀錄的 a1 屬於 feature/a）、a1 併進 main 但 store 沒記到；同資料夾 `git switch -c feature/b a1` 補了 b1。分叉點 a1 是這個資料夾看過的 HEAD，但不是這條分支的，不算已合併。 */
test('a branch forked in the same folder from the previous branch\'s reviewed head is not taken as merged', async ($, on) => {
  const { data, clock } = fixture(on)
  const root = '/home/u/wt/beta'
  data.git[root] = { branch: 'feature/b', head: 'b1', remote: 'git@github.com:acme/shop.git', releases: '', originHead: 'origin/main', merged: [], forkPoint: 'a1', descends: ['a1'], branchLine: 'b1\n', firstParent: 'm2\nm1\n', parents: { m1: 'base0', b1: 'a1' } }
  data.gh = null
  data.files[CARD_B] = data.files[CARD_B]!.replace(/- 關卡：.*$/m, '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過')
  data.store.trustedVerify = { [CARD_B]: 'node test.mjs' }
  data.store.chains = { [root]: { owner: 'fixture-session', startedAt: 0, round: 0, passed: true, reviewHead: 'a1', reviewBranch: 'feature/a', judgedHead: 'a1', judgedBranch: 'feature/a' } }
  data.store.jobs = { [root]: { sessionId: 'a0000009-0000-4000-8000-000000000000', last: { launchName: 'desk-x', nativeId: 'a0000009', sessionId: 'a0000009-0000-4000-8000-000000000000', kind: 'review', startedAt: 0, fresh: true, owner: 'fixture-session', handled: true } } }
  data.agents = []
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle(); await clock.advance(2500); await clock.settle()

  expect((data.store.gitMerged as any)?.[root]).toBeUndefined()
  const ui = await $.ui.mount(PANE(80))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ type: 'Text', text: /已合併到 main/ })).toBeUndefined()
  expect(await ui.find({ key: `case-${CARD_B}-sync` })).toBeDefined()
  await ui.unmount()
})

/** AC-3：同一輪 refresh 兩件任務並行認定 git 合併時，rememberMerged 串行寫入 store，不會後寫蓋掉前寫。 */
test('concurrent git merge detections preserve both entries in gitMerged store', async ($, on) => {
  const { data, clock } = fixture(on)
  const rootA = '/home/u/wt/alpha'
  const rootB = '/home/u/wt/beta'
  const passed = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'
  data.files[CARD_A] = data.files[CARD_A]!.replace('要 push 嗎？A) 要 B) 等', '無').replace(/- 關卡：.*$/m, passed)
  data.files[CARD_B] = data.files[CARD_B]!.replace(/- 關卡：.*$/m, passed)
  data.git[rootA] = { branch: 'feature/alpha', head: 'a1', remote: 'git@github.com:acme/shop.git', releases: '', originHead: 'origin/main', merged: ['origin/main'], firstParent: 'm2\nm1\n', parents: { m1: 'base0' } }
  data.git[rootB] = { branch: 'feature/b', head: 'b1', remote: 'git@github.com:acme/shop.git', releases: '', originHead: 'origin/main', merged: ['origin/main'], firstParent: 'm2\nm1\n', parents: { m1: 'base0' } }
  data.gh = null
  data.agents = []

  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()

  expect(data.store.gitMerged).toEqual({
    [rootA]: { branch: 'feature/alpha', head: 'a1', into: 'origin/main' },
    [rootB]: { branch: 'feature/b', head: 'b1', into: 'origin/main' },
  })
})

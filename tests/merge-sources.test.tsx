import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_B, PROJECT_DIR } from './fixture'
import { baseRefs, diffBase, mergedProbe, riskOf } from '../hooks/probes'

const BETA = '/home/u/wt/beta'
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'

test('a GitHub remote reads the PR with gh pr list only, never through MCP', async ($, on) => {
  const { data } = fixture(on)
  data.agents = []
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', PASSED)
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git' }
  data.gh = [{ number: 12, state: 'OPEN', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [{ conclusion: '', status: 'IN_PROGRESS' }] }]
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  expect(data.ghCalls.length).toBeGreaterThan(0)
  for (const c of data.ghCalls) expect(c.argv.slice(0, 3)).toEqual(['gh', 'pr', 'list'])
  expect(data.ghCalls[0].argv).toContain('feature/b')
  expect(data.ghCalls[0].argv).toContain('acme/shop')
  expect(data.mcpCalls).toEqual([])
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ type: 'Text', text: /PR #12 → main/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /CI 執行中/ })).toBeDefined()
  await ui.unmount()
})

test('without a PR, git sees the reviewed branch inside main and moves on to ship', async ($, on) => {
  const { data } = fixture(on)
  data.agents = []
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', PASSED)
  data.git[BETA] = { branch: 'feature/b', head: 'g2', remote: 'git@github.com:acme/shop.git', releases: '', originHead: 'origin/main', merged: ['origin/main'], firstParent: 'm2\nm1\n', parents: { m1: 'base0' } }
  data.gh = null
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ type: 'Text', text: /已合併到 main/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /合併後打 tag 發版/ })).toBeDefined()
  await ui.unmount()
})

test('a branch that has not reached the merge stage is never called merged', async ($, on) => {
  const { data } = fixture(on)
  data.agents = []
  data.git[BETA] = { branch: 'feature/b', head: 'g3', remote: 'git@github.com:acme/shop.git', releases: '', originHead: 'origin/main', merged: ['origin/main'] }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ type: 'Text', text: /已合併/ })).toBeUndefined()
  await ui.unmount()
})

/** 只回答 git 的假 $：基準相關的探測只會呼叫 git。 */
const gitOnly = (answers: Record<string, string | null>, clock = { t: 0 }) => ({
  clock: { now: async () => clock.t },
  process: { run: async (argv: string[]) => {
    const out = answers[argv.slice(3).join(' ')]
    return out === undefined || out === null ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: out, stderr: '' }
  } },
})

test('without a release line the diff base falls back to card.base, then origin/HEAD, and risk still sees high-risk files', async () => {
  const $ = gitOnly({
    'for-each-ref --sort=-committerdate --count=1 --format=%(refname:short) refs/remotes/origin/release/': '',
    'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n',
    'merge-base HEAD origin/develop': null,
    'merge-base HEAD origin/main': 'base1\n',
    'diff --name-only base1..HEAD': '.env.example\n',
  })
  const c = { root: BETA, git: { branch: 'feature/b', head: 'g4' } } as any
  expect(await baseRefs($, c, 'origin/develop')).toEqual(['origin/develop', 'origin/main'])
  expect(await baseRefs($, { ...c, pr: { id: 1, state: 'OPEN', ci: 'none', dest: 'release/v2' } }, 'origin/develop')).toEqual(['origin/release/v2', 'origin/develop', 'origin/main'])
  // 分支自己不算候選
  expect(await baseRefs($, { root: BETA, git: { branch: 'main', head: 'g4' } } as any)).toEqual([])
  // origin/develop 找不到 merge-base（例如沒 fetch），改用 origin/main
  expect(await diffBase($, c, 'origin/develop')).toEqual({ target: 'origin/main', base: 'base1' })
  expect((await riskOf($, c as any, [], 'origin/develop')).level).toBe('high')
})

test('the review prompt names the branch it diffs against', async ($, on) => {
  const { data, clock } = fixture(on)
  data.agents = []
  data.files[`${PROJECT_DIR}/dispatch.json`] = '{"card":{"base":"origin/develop"}}'
  data.git[BETA] = { branch: 'feature/b', head: 'g5', releases: '' }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await $.command.run({ command: 'desk', args: 'review Beta' } as any)
  await clock.settle()
  const argv = data.launches[0].argv
  expect(String(argv[argv.length - 1])).toContain('相對 origin/develop 的 diff')
})

const REFS = {
  'for-each-ref --sort=-committerdate --count=1 --format=%(refname:short) refs/remotes/origin/release/': '',
  'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n',
}

test('git calls a branch merged only when HEAD came in through a merge commit, not when it sits on the main line', async () => {
  const c = { root: BETA, git: { branch: 'feature/b', head: 'h-noff' } } as any
  // merge commit m2 的第一個父是主線 m1，分支 HEAD 是第二個父：算合併
  expect(await mergedProbe(gitOnly({ ...REFS, 'merge-base --is-ancestor HEAD origin/main': '', 'rev-list --first-parent HEAD..origin/main': 'm2\nm1\n', 'rev-parse m1^': 'base0\n' }), c)).toBe('origin/main')
  // HEAD 就在主線上（剛開的分支、或停在 main 的主工作區被 release 包含）：不算
  const onLine = { ...c, git: { branch: 'feature/b', head: 'h-line' } }
  expect(await mergedProbe(gitOnly({ ...REFS, 'merge-base --is-ancestor HEAD origin/main': '', 'rev-list --first-parent HEAD..origin/main': 'm2\nm1\n', 'rev-parse m1^': 'h-line\n' }), onLine)).toBeUndefined()
  // HEAD 就是基準的頂端：沒有分叉過
  const tip = { ...c, git: { branch: 'feature/b', head: 'h-tip' } }
  expect(await mergedProbe(gitOnly({ ...REFS, 'merge-base --is-ancestor HEAD origin/main': '', 'rev-list --first-parent HEAD..origin/main': '' }), tip)).toBeUndefined()
})

test('a miss is remembered for two minutes unless forced', async () => {
  const clock = { t: 0 }
  const answers: Record<string, string | null> = { ...REFS, 'merge-base --is-ancestor HEAD origin/main': null }
  const $ = gitOnly(answers, clock)
  const c = { root: BETA, git: { branch: 'feature/b', head: 'h-miss' } } as any
  expect(await mergedProbe($, c)).toBeUndefined()
  Object.assign(answers, { 'merge-base --is-ancestor HEAD origin/main': '', 'rev-list --first-parent HEAD..origin/main': 'm2\nm1\n', 'rev-parse m1^': 'base0\n' })
  clock.t = 60_000
  expect(await mergedProbe($, c)).toBeUndefined()
  expect(await mergedProbe($, c, '', true)).toBe('origin/main')
})

test('refs that look like options are never passed to git', async () => {
  const c = { root: BETA, git: { branch: 'feature/b', head: 'g6' } } as any
  expect(await baseRefs(gitOnly(REFS), c, '--output=/tmp/x')).toEqual(['origin/main'])
})

test('risk is not cached when no base could be found', async () => {
  const answers: Record<string, string | null> = { 'for-each-ref --sort=-committerdate --count=1 --format=%(refname:short) refs/remotes/origin/release/': '' }
  const $ = gitOnly(answers)
  const c = { root: BETA, git: { branch: 'feature/b', head: 'g7' } } as any
  expect((await riskOf($, c)).level).toBe('normal')
  Object.assign(answers, { 'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n', 'merge-base HEAD origin/main': 'base1\n', 'diff --name-only base1..HEAD': '.env\n' })
  expect((await riskOf($, c)).level).toBe('high')
})

test('a failing gh is retried after a minute, and an old PR stops showing after an hour', async ($, on) => {
  const { data, clock } = fixture(on)
  data.agents = []
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', PASSED)
  data.git[BETA] = { branch: 'feature/b', head: 'g8', remote: 'git@github.com:acme/shop.git' }
  data.gh = [{ number: 21, state: 'OPEN', baseRefName: 'main', headRepositoryOwner: { login: 'acme' }, statusCheckRollup: [{ conclusion: '', status: 'IN_PROGRESS' }] }]
  // /desk refresh 與 r 會強制重讀 PR；這裡用每 30 秒的定時更新
  const tickRefresh = async () => { await clock.advance(30_000); await clock.settle() }
  await $.command.run({ command: 'desk', args: 'refresh' } as any)
  await clock.settle()
  expect(data.ghCalls.length).toBe(1)
  data.gh = null
  // CI 跑中：下一輪照樣重讀，這次失敗
  await tickRefresh()
  expect(data.ghCalls.length).toBe(2)
  // 失敗後一分鐘內不再打 gh（CI 跑中也一樣）
  await tickRefresh()
  expect(data.ghCalls.length).toBe(2)
  await tickRefresh()
  expect(data.ghCalls.length).toBe(3)
  const ui = await $.ui.mount(PANE(72))
  await ui.press({ key: `row-${CARD_B}` })
  expect(await ui.find({ type: 'Text', text: /PR #21/ })).toBeDefined()
  // 一小時都讀不到：舊的 PR 不再顯示
  await clock.advance(61 * 60_000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /PR #21/ })).toBeUndefined()
  await ui.unmount()
})

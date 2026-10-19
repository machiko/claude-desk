import { expect, test } from 'claude-code/testing'
import { fixture, PANE, CARD_B, PROJECT_DIR } from './fixture'
import { baseRefs, diffBase, riskOf } from '../hooks/probes'

const BETA = '/home/u/wt/beta'
const PASSED = '- 關卡：review：CRITICAL 0、HIGH 0、MEDIUM 0、LOW 0；過'

test('a GitHub remote reads the PR with gh pr list only, never through MCP', async ($, on) => {
  const { data } = fixture(on)
  data.agents = []
  data.files[CARD_B] = data.files[CARD_B]!.replace('- 關卡：無', PASSED)
  data.git[BETA] = { branch: 'feature/b', head: 'g1', remote: 'git@github.com:acme/shop.git' }
  data.gh = [{ number: 12, state: 'OPEN', baseRefName: 'main', url: 'https://github.com/acme/shop/pull/12', statusCheckRollup: [{ conclusion: '', status: 'IN_PROGRESS' }] }]
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
  data.git[BETA] = { branch: 'feature/b', head: 'g2', remote: 'git@github.com:acme/shop.git', releases: '', originHead: 'origin/main', merged: ['origin/main'] }
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
const gitOnly = (answers: Record<string, string | null>) => ({
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
